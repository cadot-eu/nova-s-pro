/**
 * Vérification de l'encodage binaire.
 *
 * Le principe : notre `packBall`/`packDrill` doit produire exactement les mêmes
 * octets que les implémentations d'origine (olanga/nova et
 * smee/nova-s-custom-drills), sur toute la plage de paramètres. Le moindre écart
 * d'un octet fait échouer le test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bpmToPercent,
  buildDrill,
  csvLegacyToDrill,
  csvToDrill,
  describeBall,
  detectFormat,
  describeDrill,
  drillToCsv,
  drillToCsvLegacy,
  drillToSmeeText,
  DRILL_MODE,
  MAX_BALLS,
  mirrorDrill,
  normalizeBall,
  packBall,
  packDrill,
  percentToBpm,
  RANGES,
  RPM_MAX,
  RPM_MIN,
  rpmsToSpeedSpin,
  smeeTextToDrill,
  scaleDropPoint,
  scaleFrequency,
  scaleHeight,
  validateBall,
  validateDrill,
  wheelRpms,
  maxSpinForSpeed,
} from '../src/protocol.js';

import {
  createBallReference,
  createDrillOlanga,
  createDrillReference,
  modifyDrillOlanga,
  packBallReference,
} from './fixtures/reference.js';

/** Construit une balle normalisée à partir de paramètres utilisateur. */
function ball(fields) {
  const { ball: b, adjustments, errors } = normalizeBall(fields);
  assert.deepEqual(errors, [], `balle refusée : ${errors.join(', ')}`);
  assert.deepEqual(adjustments, [], `balle corrigée alors qu'elle était valide : ${adjustments.join(', ')}`);
  return b;
}

/**
 * Normalise sans exiger l'absence de correction.
 *
 * C'est indispensable pour balayer toute la plage : à faible vitesse avec un
 * spin élevé, le RPM calculé d'une roue passe sous le plancher matériel de
 * 400 et se fait ramener. On veut tout de même vérifier l'encodage dans ce cas,
 * puisque c'est exactement ce que le robot recevra.
 */
function normBall(fields) {
  const { ball: b, errors } = normalizeBall(fields);
  assert.deepEqual(errors, [], `balle refusée : ${errors.join(', ')}`);
  return b;
}

/* -------------------------------------------------------------------------- */
/* Mise à l'échelle                                                           */
/* -------------------------------------------------------------------------- */

test('les formules de mise à l’échelle correspondent aux constantes du matériel', () => {
  // hauteur : -50 → -20 ; 100 → 30
  assert.equal(scaleHeight(-50), -20);
  assert.equal(scaleHeight(100), 30);
  // point de chute : -10 → -22 ; 10 → 22
  assert.equal(scaleDropPoint(-10), -22);
  assert.equal(scaleDropPoint(10), 22);
  // fréquence : ce sont des BPM (30–90) qui se transforment en 0.5–1.5.
  // C'est la double conversion d'olanga : p = (bpm−30)/0,6 puis p/100 + 0,5.
  assert.equal(scaleFrequency(30), 0.5);
  assert.equal(scaleFrequency(60), 1.0);
  assert.equal(scaleFrequency(90), 1.5);
});

test('la cadence est en bpm, pas en pourcentage', () => {
  // Régression : la cadence a longtemps été encodée avec la formule du
  // pourcentage interne alors qu'elle était saisie en bpm. 30 bpm partait alors
  // à 0.8 au lieu de 0.5, soit 60 % trop vite.
  assert.equal(bpmToPercent(30), 0);
  assert.equal(bpmToPercent(60), 50);
  assert.equal(bpmToPercent(90), 100);
  assert.equal(percentToBpm(0), 30);
  assert.equal(percentToBpm(50), 60);
  assert.equal(percentToBpm(100), 90);

  // Les presets INTERNES d'olanga sont des pourcentages : leur `10` vaut 36 bpm.
  // (js/constants.js : PUSH_B = [1547, 2915, 50, -5, 10, 1])
  assert.equal(percentToBpm(10), 36);
  assert.equal(scaleFrequency(36), 0.6, 'le preset push(b) d’olanga encode 0.6');

  // Aller-retour sur toute la plage.
  for (let bpm = 30; bpm <= 90; bpm++) {
    assert.ok(Math.abs(percentToBpm(bpmToPercent(bpm)) - bpm) < 1e-9, `aller-retour pour ${bpm} bpm`);
    const packet = scaleFrequency(bpm);
    assert.ok(packet >= 0.5 - 1e-9 && packet <= 1.5 + 1e-9, `${bpm} bpm doit rester dans [0.5, 1.5]`);
  }
});

test('les RPM suivent les formules et le sens du spin', () => {
  assert.deepEqual(wheelRpms(0, 0), { top: 970, bottom: 970 });
  // vitesse 5, spin +3 → roue supérieure plus rapide (topspin)
  assert.deepEqual(wheelRpms(5, 3), { top: 970 + 3152.5 + 1026, bottom: 970 + 3152.5 - 1026 });
  const topspin = wheelRpms(5, 3);
  assert.ok(topspin.top > topspin.bottom, 'topspin : la roue du haut doit tourner plus vite');
  const backspin = wheelRpms(5, -3);
  assert.ok(backspin.bottom > backspin.top, 'backspin : la roue du bas doit tourner plus vite');
});

/* -------------------------------------------------------------------------- */
/* Encodage d'une balle                                                       */
/* -------------------------------------------------------------------------- */

test('packBall est identique à l’implémentation d’olanga/nova sur toute la plage', () => {
  let compared = 0;
  let projections = 0;
  for (let speed = 0; speed <= 10; speed += 0.5) {
    const maxSpin = maxSpinForSpeed(speed);
    const spins = new Set([0, maxSpin, -maxSpin, Math.round(maxSpin / 2 * 2) / 2, -Math.round(maxSpin / 2 * 2) / 2]);
    for (const spin of spins) {
      if (Math.abs(spin) > maxSpin) continue;
      for (const height of [-50, -20, 0, 25, 50, 75, 100]) {
        for (const dropPoint of [-10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10]) {
          for (const frequency of [30, 45, 60, 75, 90]) {
            for (const reps of [1, 3, 10, 200]) {
              const fields = { speed, spin, height, dropPoint, frequency, reps };
              const { ball: b, adjustments } = normalizeBall(fields);
              if (adjustments.some((a) => /réellement jouées/.test(a))) projections++;
              // Invariant fort : quoi qu'on demande, les roues restent dans ce
              // que le firmware accepte.
              assert.ok(
                b.topRpm >= RPM_MIN && b.topRpm <= RPM_MAX
                && b.bottomRpm >= RPM_MIN && b.bottomRpm <= RPM_MAX,
                `roues hors plage pour ${JSON.stringify(fields)} : ${b.topRpm}/${b.bottomRpm}`,
              );
              const ours = packBall(b);
              // On alimente l'oracle avec EXACTEMENT les RPM que nous envoyons :
              // la comparaison porte donc bien sur l'encodage, pas sur la
              // politique de bornage des RPM.
              // L'oracle d'olanga attend le POURCENTAGE interne, pas des bpm :
              // c'est justement la conversion que l'on veut vérifier ici.
              const theirs = packBallReference(
                b.topRpm, b.bottomRpm, height, dropPoint, bpmToPercent(frequency), reps);
              assert.deepEqual(ours, theirs, `divergence pour ${JSON.stringify(fields)}`);
              compared++;
            }
          }
        }
      }
    }
  }
  assert.ok(compared > 2000, `trop peu de cas comparés : ${compared}`);
  assert.ok(projections > 0, 'le balayage doit rencontrer la limite des roues');
});

test('packBall est identique à l’implémentation de smee pour ses paramètres légaux', () => {
  // smee impose des multiples de 10 sur la fréquence et des RPM dans [500, 7274].
  let compared = 0;
  for (const speed of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    const maxSpin = maxSpinForSpeed(speed);
    for (const spin of [0, maxSpin, -maxSpin]) {
      if (Math.abs(spin) > maxSpin) continue;
      for (const height of [-50, 0, 50, 100]) {
        for (const dropPoint of [-10, -5, 0, 5, 10]) {
          for (const frequency of [30, 60, 90]) { // bpm → 0, 50, 100 en pourcentage
            const b = normBall({ speed, spin, height, dropPoint, frequency, reps: 1 });
            // On ne garde que les cas que smee accepterait lui-même : son
            // assertion exclut les RPM hors de [500, 7274].
            if (b.topRpm > 7274 || b.bottomRpm > 7274 || b.topRpm < 500 || b.bottomRpm < 500) continue;
            const ours = packBall(b);
            const theirs = createBallReference(
              b.topRpm, b.bottomRpm, height, dropPoint, bpmToPercent(frequency), 1);
            assert.deepEqual(ours, theirs, `divergence smee pour ${JSON.stringify({ speed, spin, height, dropPoint, frequency })}`);
            compared++;
          }
        }
      }
    }
  }
  assert.ok(compared > 100, `trop peu de cas comparés : ${compared}`);
});

test('une combinaison hors plage est RECALCULÉE, pas écrêtée en douce', () => {
  // Vitesse 0 avec spin 2 : roue basse = 970 − 684 = 286 RPM, sous le plancher.
  // On ne garde pas « spin 2 » en écrêtant la roue — l'écran annoncerait alors
  // un effet que la balle n'a pas. On réduit l'effet à ce qui est jouable.
  const { ball: b, adjustments } = normalizeBall({
    speed: 0, spin: 2, height: 50, dropPoint: 0, frequency: 60, reps: 1,
  });
  assert.equal(b.spin, 1, 'l’effet est ramené à ce que les roues savent faire');
  assert.equal(b.speed, 0, 'la vitesse demandée est conservée');
  assert.equal(b.topRpm, 1312);
  assert.equal(b.bottomRpm, 628);
  assert.ok(
    adjustments.some((a) => /effet : 2 → 1/.test(a)),
    `la correction doit être signalée, obtenu : ${JSON.stringify(adjustments)}`,
  );
  assert.ok(
    adjustments.some((a) => /réellement jouées/.test(a)),
    'les valeurs réellement jouées doivent être annoncées',
  );
  assert.ok(validateBall({ ...b }).ok, 'la balle corrigée doit rester valide');
  assert.equal(packBall(b).length, 24, 'elle doit rester encodable');
});

test('une vitesse qui dépasse les roues est bloquée, même sans effet', () => {
  // Vitesse 10 sans effet : 970 + 6305 = 7275 tr/min, au-delà de 7200.
  const { ball: b, adjustments } = normalizeBall({
    speed: 10, spin: 0, height: 50, dropPoint: 0, frequency: 60, reps: 1,
  });
  assert.equal(b.speed, 9.5, 'la vitesse redescend à la plus grande valeur jouable');
  assert.equal(b.spin, 0);
  assert.equal(b.topRpm, 6960);
  assert.equal(b.bottomRpm, 6960);
  assert.ok(
    adjustments.some((a) => /vitesse : 10 → 9.5/.test(a)),
    `la correction doit être signalée, obtenu : ${JSON.stringify(adjustments)}`,
  );
});

test('l’effet est sacrifié avant la vitesse', () => {
  // 8.5 / 3 demande 7355 tr/min à la roue haute. Réduire la vitesse garderait
  // l'effet, mais c'est la vitesse que l'utilisateur a choisie : on garde donc
  // la vitesse et on réduit l'effet.
  const { ball: b } = normalizeBall({
    speed: 8.5, spin: 3, height: 50, dropPoint: -6, frequency: 70, reps: 1,
  });
  assert.equal(b.speed, 8.5);
  assert.equal(b.spin, 2.5);
  assert.ok(b.topRpm <= RPM_MAX && b.bottomRpm <= RPM_MAX);
});

test('une combinaison jouable n’est pas touchée', () => {
  const { ball: b, adjustments } = normalizeBall({
    speed: 7, spin: 5, height: 50, dropPoint: -6, frequency: 70, reps: 1,
  });
  assert.equal(b.speed, 7);
  assert.equal(b.spin, 5);
  assert.equal(b.topRpm, 7094);
  assert.deepEqual(adjustments, [], 'aucune correction ne doit être inventée');
});

test('la balle encodée fait exactement 24 octets', () => {
  const b = ball({ speed: 5, spin: 2, height: 50, dropPoint: -5, frequency: 60, reps: 1 });
  assert.equal(packBall(b).length, 24);
});

/* -------------------------------------------------------------------------- */
/* Encodage d'un exercice                                                     */
/* -------------------------------------------------------------------------- */

test('packDrill en mode sans fin est identique à createDrill de smee', () => {
  const balls = [
    ball({ speed: 6, spin: 2, height: 50, dropPoint: -6, frequency: 60, reps: 1 }),
    ball({ speed: 6, spin: 2, height: 50, dropPoint: 0, frequency: 60, reps: 1 }),
    ball({ speed: 6, spin: 2, height: 50, dropPoint: 6, frequency: 60, reps: 1 }),
  ];
  const packed = balls.map(packBall);

  for (const random of [false, true]) {
    const ours = packDrill({ balls, mode: 'endless', random });
    // smee : combos = 3 → octet de mode 0x03 → exercice sans fin.
    // Attention : createDrill de smee force minutes = 10 quand isRandom est vrai,
    // ce qui donne le même octet 0x03 en position 3 mais une valeur de mode
    // différente. On compare donc au chemin non aléatoire et on vérifie
    // séparément notre propre encodage du drapeau aléatoire.
    const theirs = createDrillReference(packed, 3, 0, false);
    if (random) {
      assert.equal(ours[6], 1);
      assert.deepEqual(ours.subarray(0, 6), theirs.subarray(0, 6));
      assert.deepEqual(ours.subarray(7), theirs.subarray(7));
    } else {
      assert.deepEqual(ours, theirs);
    }
  }
});

test('packDrill reproduit l’en-tête d’olanga/nova pour chaque mode', () => {
  const balls = [ball({ speed: 7, spin: 1, height: 60, dropPoint: 4, frequency: 70, reps: 2 })];
  const packed = balls.map(packBall);

  for (const [mode, modeByte] of Object.entries(DRILL_MODE)) {
    const modeValue = mode === 'ENDLESS' ? 0 : 3;
    const ours = packDrill({ balls, mode: mode.toLowerCase(), modeValue, random: false });
    const theirs = createDrillOlanga(packed, modeByte, modeValue, false);
    assert.deepEqual(ours, theirs, `divergence pour le mode ${mode}`);
  }
});

test('l’en-tête 0x81 annonce la bonne longueur et la bonne commande', () => {
  for (const n of [1, 2, 9, 20]) {
    const balls = Array.from({ length: n }, () =>
      ball({ speed: 5, spin: 0, height: 50, dropPoint: 0, frequency: 60, reps: 1 }));
    const pkt = packDrill({ balls, mode: 'endless', random: false });
    assert.equal(pkt.length, 7 + n * 24);
    assert.equal(pkt.readUInt8(0), 0x81);
    assert.equal(pkt.readUInt16LE(1), 4 + n * 24);
    assert.equal(pkt.readUInt8(3), DRILL_MODE.ENDLESS);
    assert.equal(pkt.readUInt16LE(4), 0);
    assert.equal(pkt.readUInt8(6), 0);
  }
});

test('le paquet de modification (0x84) est identique à celui d’olanga', () => {
  for (const n of [1, 3, 9]) {
    const balls = Array.from({ length: n }, (_, i) =>
      ball({ speed: 4 + i * 0.5, spin: 1, height: 50, dropPoint: i - 1, frequency: 60, reps: 1 }));
    const ours = packDrill({ balls }, { modify: true });
    const theirs = modifyDrillOlanga(balls.map(packBall));
    assert.deepEqual(ours, theirs);
    assert.equal(ours.readUInt8(0), 0x84);
    assert.equal(ours.readUInt16LE(1), 1 + n * 24);
    assert.equal(ours.length, 3 + n * 24);
  }
});

test('un exercice vide ou trop grand est refusé', () => {
  assert.throws(() => packDrill({ balls: [] }), /au moins une balle/);
  const tooMany = Array.from({ length: MAX_BALLS + 1 }, () =>
    ball({ speed: 5, spin: 0, height: 50, dropPoint: 0, frequency: 60, reps: 1 }));
  assert.throws(() => packDrill({ balls: tooMany }), /ne peut pas dépasser/);
});

test('un mode inconnu est refusé', () => {
  const balls = [ball({ speed: 5, spin: 0, height: 50, dropPoint: 0, frequency: 60, reps: 1 })];
  assert.throws(() => packDrill({ balls, mode: 'sprint' }), /Mode inconnu/);
});

/* -------------------------------------------------------------------------- */
/* Normalisation et validation                                                */
/* -------------------------------------------------------------------------- */

test('normalizeBall borne les valeurs et signale les corrections', () => {
  const { ball: b, adjustments, errors } = normalizeBall({
    speed: 5.3,        // → 5.5
    spin: 20,          // → limité au maximum de la vitesse
    height: 200,       // → 100
    dropPoint: -12,    // → -10
    frequency: 500,    // → 90 (borne haute en bpm)
    reps: 0,           // → 1
  });
  assert.deepEqual(errors, []);
  assert.equal(b.speed, 5.5);
  assert.equal(b.height, 100);
  assert.equal(b.dropPoint, -10);
  assert.equal(b.frequency, 90);
  assert.equal(b.reps, 1);
  assert.ok(Math.abs(b.spin) <= maxSpinForSpeed(5.5), 'le spin doit respecter la limite de la vitesse');
  assert.ok(adjustments.length >= 5, `corrections attendues, obtenu : ${JSON.stringify(adjustments)}`);
});

test('normalizeBall refuse une balle inexploitable', () => {
  assert.equal(normalizeBall(null).ball, null);
  assert.equal(normalizeBall({}).ball, null);
  assert.ok(normalizeBall({ speed: 'vite' }).errors.length > 0);
});

test('validateBall est strict sur les pas et les plages', () => {
  const good = ball({ speed: 5, spin: 2, height: 50, dropPoint: -5, frequency: 60, reps: 1 });
  assert.equal(validateBall(good).ok, true);

  assert.equal(validateBall({ ...good, speed: 5.3 }).ok, false);
  assert.equal(validateBall({ ...good, height: 101 }).ok, false);
  assert.equal(validateBall({ ...good, frequency: 30 }).ok, true, '30 bpm est la borne basse');
  assert.equal(validateBall({ ...good, frequency: 90 }).ok, true, '90 bpm est la borne haute');
  assert.equal(validateBall({ ...good, frequency: 100 }).ok, false, 'la cadence se dit en bpm, pas en pourcentage');
  assert.equal(validateBall({ ...good, frequency: 29 }).ok, false);
  assert.equal(validateBall({ ...good, reps: 0 }).ok, false);
  assert.equal(validateBall({ ...good, speed: 0, spin: 10 }).ok, false, 'spin 10 impossible à vitesse 0');
});

test('validateDrill prévient au-delà de 9 balles', () => {
  const mk = (n) => Array.from({ length: n }, () =>
    ball({ speed: 5, spin: 0, height: 50, dropPoint: 0, frequency: 60, reps: 1 }));
  assert.equal(validateDrill({ balls: mk(3) }).ok, true);
  const medium = validateDrill({ balls: mk(12) });
  assert.equal(medium.ok, true);
  assert.ok(medium.warnings.length >= 1, 'un avertissement est attendu entre 10 et 20 balles');
  assert.equal(validateDrill({ balls: mk(21) }).ok, false);
});

/* -------------------------------------------------------------------------- */
/* Aides de haut niveau                                                       */
/* -------------------------------------------------------------------------- */

test('buildDrill normalise, agrège les corrections et encode', () => {
  const { drill, adjustments } = buildDrill({
    balls: [
      { speed: 9, spin: 1, height: 50, dropPoint: -6, frequency: 70, reps: 1 },
      { speed: 9, spin: 1, height: 50, dropPoint: 0, frequency: 70, reps: 1 },
      { speed: 9, spin: 1, height: 50, dropPoint: 6, frequency: 70, reps: 1 },
    ],
    random: true,
    mode: 'endless',
  });
  assert.equal(drill.balls.length, 3);
  assert.equal(drill.random, true);
  assert.deepEqual(adjustments, []);
  assert.ok(packDrill(drill).length === 7 + 3 * 24);
});

test('buildDrill refuse un exercice sans balle exploitable', () => {
  assert.throws(() => buildDrill({ balls: [] }), /Aucune balle/);
  assert.throws(() => buildDrill({ balls: [{ speed: 'x' }] }), /Balles invalides/);
});

test('buildDrill force une valeur de mode cohérente', () => {
  const { drill, adjustments } = buildDrill({
    balls: [{ speed: 5, spin: 0, height: 50, dropPoint: 0, frequency: 60, reps: 1 }],
    mode: 'minutes',
  });
  assert.equal(drill.modeValue, 1);
  assert.ok(adjustments.some((a) => /modeValue/.test(a)));
});

test('mirrorDrill inverse le point de chute sans toucher au reste', () => {
  const { drill } = buildDrill({
    balls: [
      { speed: 6, spin: 2, height: 50, dropPoint: -8, frequency: 60, reps: 1 },
      { speed: 6, spin: 2, height: 50, dropPoint: 0, frequency: 60, reps: 1 },
      { speed: 6, spin: 2, height: 50, dropPoint: 8, frequency: 60, reps: 1 },
    ],
  });
  const mirrored = mirrorDrill(drill);
  assert.deepEqual(mirrored.balls.map((b) => b.dropPoint), [8, 0, -8]);
  assert.deepEqual(mirrored.balls.map((b) => b.speed), drill.balls.map((b) => b.speed));
  // Le miroir ne doit PAS modifier les RPM : seuls le point de chute change.
  assert.deepEqual(mirrored.balls.map((b) => b.topRpm), drill.balls.map((b) => b.topRpm));
});

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

test('un exercice survit à un aller-retour CSV', () => {
  const original = {
    balls: [
      ball({ speed: 8, spin: 3, height: 55, dropPoint: -6, frequency: 80, reps: 1 }),
      ball({ speed: 8, spin: -2, height: 45, dropPoint: 0, frequency: 55, reps: 2 }),
      ball({ speed: 4, spin: 1.5, height: 30, dropPoint: 6.5, frequency: 40, reps: 1 }),
    ],
    mode: 'endless',
    modeValue: 0,
    random: false,
  };
  const csv = drillToCsv(original, { name: 'Test miroir', set: 'B' });
  assert.ok(csv.startsWith('Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps'));

  const { drill: back, name } = csvToDrill(csv);
  assert.equal(name, 'Test miroir');
  assert.equal(back.balls.length, 3);
  assert.deepEqual(back.balls.map((b) => b.speed), [8, 8, 4]);
  assert.deepEqual(back.balls.map((b) => b.spin), [3, -2, 1.5]);
  assert.deepEqual(back.balls.map((b) => b.height), [55, 45, 30]);
  assert.deepEqual(back.balls.map((b) => b.dropPoint), [-6, 0, 6.5]);
  assert.deepEqual(back.balls.map((b) => b.frequency), [80, 55, 40]);
  assert.deepEqual(back.balls.map((b) => b.reps), [1, 2, 1]);
});

test('le CSV reprend exactement le format documenté par olanga', () => {
  const { drill } = buildDrill({
    balls: [{ speed: 7.5, spin: -5, height: 50, dropPoint: -5, frequency: 60, reps: 1 }],
  });
  const lines = drillToCsv(drill, { name: 'Drill A2', set: 'A' }).trim().split('\n');
  // 7,5 / 5 demande 7408 tr/min : l'effet est recalculé à 4 pour rester jouable,
  // et c'est CETTE valeur qui part au robot comme dans le CSV exporté.
  assert.equal(lines[1], 'A;1;Drill A2;7.5;4;back;50;-5;60;1');
});

test('csvToDrill signe le spin d’après la colonne Type', () => {
  const csv = [
    'Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps',
    'A;1;X;7.5;5;top;50;-5;60;1',
    'A;2;X;7.5;5;back;50;5;60;1',
  ].join('\n');
  const { drill } = csvToDrill(csv);
  // Le SIGNE vient de la colonne Type ; l'amplitude est ensuite ramenée à ce que
  // les roues acceptent (5 → 4 à cette vitesse).
  assert.equal(drill.balls[0].spin, 4);
  assert.equal(drill.balls[1].spin, -4);
  assert.equal(drill.balls[0].speed, 7.5);
});

test('un CSV malformé est refusé avec un message clair', () => {
  assert.throws(() => csvToDrill('Set;Ball;Name\nA;1;X'), /CSV illisible/);
  assert.throws(() => csvToDrill('Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps\n'), /CSV vide/);
});

/* -------------------------------------------------------------------------- */
/* Description                                                                */
/* -------------------------------------------------------------------------- */

test('les descriptions ne lèvent pas et restent lisibles', () => {
  const { drill } = buildDrill({
    balls: [{ speed: 9, spin: 2, height: 50, dropPoint: -6, frequency: 80, reps: 1 }],
    random: true,
  });
  const text = describeDrill(drill);
  assert.match(text, /aléatoire/);
  assert.match(text, /topspin/);
  assert.match(text, /gauche \(revers\)/);
  assert.match(describeBall(drill.balls[0]), /RPM/);
});


/* -------------------------------------------------------------------------- */
/* Format texte de smee/nova-s-custom-drills                                  */
/* -------------------------------------------------------------------------- */

test('rpmsToSpeedSpin inverse exactement les formules de RPM', () => {
  for (const [speed, spin] of [[0, 0], [5, 3], [9, -2], [4.5, 10], [2, -5]]) {
    const { top, bottom } = wheelRpms(speed, spin);
    const retour = rpmsToSpeedSpin(top, bottom);
    assert.ok(Math.abs(retour.speed - speed) < 1e-9, `vitesse : ${retour.speed} ≠ ${speed}`);
    assert.ok(Math.abs(retour.spin - spin) < 1e-9, `effet : ${retour.spin} ≠ ${spin}`);
  }
});

test('un exercice survit à un aller-retour texte smee', () => {
  const original = {
    balls: [
      ball({ speed: 5, spin: 3, height: 50, dropPoint: -5, frequency: 60, reps: 1 }),
      ball({ speed: 8, spin: -2, height: 40, dropPoint: 5, frequency: 80, reps: 2 }),
    ],
    mode: 'endless', modeValue: 0, random: false,
  };
  const texte = drillToSmeeText(original);
  assert.equal(texte.split('\n').filter(Boolean).length, 2);

  const { drill, maxRpmError } = smeeTextToDrill(texte);
  assert.equal(drill.balls.length, 2);
  assert.deepEqual(drill.balls.map((b) => b.speed), [5, 8]);
  assert.deepEqual(drill.balls.map((b) => b.spin), [3, -2]);
  assert.deepEqual(drill.balls.map((b) => b.height), [50, 40]);
  assert.deepEqual(drill.balls.map((b) => b.dropPoint), [-5, 5]);
  assert.deepEqual(drill.balls.map((b) => b.frequency), [60, 80]);
  assert.deepEqual(drill.balls.map((b) => b.reps), [1, 2]);
  assert.equal(maxRpmError, 0, 'un exercice passé par nos propres formules revient exactement');
});

test('le format smee tolère espaces, virgules, commentaires et variantes', () => {
  const texte = [
    '500   4000  -50   6   0  1',
    '1000, 4000,  20, 10, 30, 1 | 5000,  700,  40, -10, 20, 1 ; soit cd soit revers',
    '4000   700  100   2  20  1',
  ].join('\n');

  const r = smeeTextToDrill(texte);
  assert.equal(r.drill.balls.length, 4, 'les deux variantes séparées par | comptent pour deux balles');
  assert.equal(r.variants, 1);
  assert.equal(r.drill.random, true, 'des variantes impliquent un ordre aléatoire');
  assert.equal(r.drill.balls[0].dropPoint, 6);
  assert.equal(r.drill.balls[1].dropPoint, 10);
  assert.equal(r.drill.balls[2].dropPoint, -10);
  // Le 5e champ de smee est un pourcentage : 0 → 30 bpm, 30 → 48 bpm.
  assert.equal(r.drill.balls[0].frequency, 30);
  assert.equal(r.drill.balls[1].frequency, 48);
});

test('l’import smee signale l’écart de RPM inévitable', () => {
  // 4000/700 ne tombe pas sur la grille 0.5 : le plus proche est 3941/521.
  const r = smeeTextToDrill('4000 700 100 2 20 1');
  assert.ok(r.maxRpmError > 0, 'un écart doit être signalé');
  assert.ok(r.adjustments.some((a) => /n’est pas atteignable exactement/.test(a)));
  assert.equal(r.drill.balls[0].topRpm, 3941);
  assert.equal(r.drill.balls[0].bottomRpm, 521);
});

test('sans variante, l’ordre reste fixe', () => {
  const r = smeeTextToDrill('1000 4000 20 10 30 1\n4000 700 100 2 20 1');
  assert.equal(r.variants, 0);
  assert.equal(r.drill.random, false);
});

test('un texte smee malformé est refusé avec un message utile', () => {
  assert.throws(() => smeeTextToDrill(''), /vide/);
  assert.throws(() => smeeTextToDrill('1000 4000 20 10 30'), /multiple de 6/);
  assert.throws(() => smeeTextToDrill('a b c d e f'), /pas des nombres/);
  assert.throws(() => smeeTextToDrill('100 4000 20 10 30 1'), /RPM des roues/);
});


/* -------------------------------------------------------------------------- */
/* Format CSV hérité d'olanga/nova 1.3                                        */
/* -------------------------------------------------------------------------- */

test('le CSV 1.3 s’exporte avec les RPM des roues', () => {
  const { drill } = buildDrill({
    balls: [{ speed: 5, spin: 3, height: 50, dropPoint: -5, frequency: 60, reps: 1 }],
  });
  const lignes = drillToCsvLegacy(drill, { name: 'Essai', set: 'B' }).trim().split('\n');
  assert.equal(lignes[0], 'Set;Ball;Name;Top;Bottom;Height;Drop;Freq;Reps');
  // 60 bpm correspond au pourcentage 50, comme dans l'ancien client.
  assert.equal(lignes[1], 'B;1;Essai;5149;3097;50;-5;50;1');
});

test('un aller-retour CSV 1.3 est exact', () => {
  const original = {
    balls: [
      ball({ speed: 5, spin: 3, height: 50, dropPoint: -5, frequency: 60, reps: 1 }),
      ball({ speed: 2, spin: -5, height: -40, dropPoint: 6, frequency: 36, reps: 1 }),
    ],
    mode: 'endless', modeValue: 0, random: false,
  };
  const { drill, maxRpmError } = csvLegacyToDrill(drillToCsvLegacy(original));
  assert.equal(maxRpmError, 0);
  assert.deepEqual(drill.balls.map((b) => b.speed), [5, 2]);
  assert.deepEqual(drill.balls.map((b) => b.spin), [3, -5]);
  assert.deepEqual(drill.balls.map((b) => b.frequency), [60, 36]);
  assert.equal(drill.balls[0].topRpm, 5149);
});

test('le CSV 1.3 malformé est refusé avec un message utile', () => {
  assert.throws(() => csvLegacyToDrill('Set;Ball;Name\nA;1;X'), /au lieu de 9/);
  assert.throws(() => csvLegacyToDrill('Set;Ball;Name;Top;Bottom;Height;Drop;Freq;Reps\n'), /vide/);
  assert.throws(
    () => csvLegacyToDrill('Set;Ball;Name;Top;Bottom;Height;Drop;Freq;Reps\nA;1;X;abc;4000;20;10;30;1'),
    /RPM non numériques/,
  );
  assert.throws(
    () => csvLegacyToDrill('Set;Ball;Name;Top;Bottom;Height;Drop;Freq;Reps\nA;1;X;100;4000;20;10;30;1'),
    /RPM doivent être/,
  );
});

test('le format est détecté d’après le nombre de colonnes', () => {
  assert.equal(detectFormat('Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps'), 'csv');
  assert.equal(detectFormat('Set;Ball;Name;Top;Bottom;Height;Drop;Freq;Reps'), 'csv-legacy');
  assert.equal(detectFormat('1000 4000 20 10 30 1'), 'smee');
  assert.equal(detectFormat('# commentaire\n1000 4000 20 10 30 1'), 'smee');
  assert.equal(detectFormat('A;1;X;7.5;5;top;50;-5;60;1'), 'csv');
  // Un contenu vide ne doit pas lever.
  assert.equal(detectFormat(''), 'smee');
});

test('forcer un format inconnu est refusé', () => {
  assert.throws(() => detectFormat('peu importe', 'xml'), /Format inconnu/);
  assert.equal(detectFormat('peu importe', 'smee'), 'smee');
  assert.equal(detectFormat('A;1;X;7.5;5;top;50;-5;60;1', 'auto'), 'csv');
});

/* -------------------------------------------------------------------------- */
/* Pause placée après une balle                                               */
/* -------------------------------------------------------------------------- */

/** Balle complète, avec la pause éventuelle placée APRÈS elle. */
function avecPause(pauseAfter, champs = {}) {
  return ball({
    speed: 6, spin: 2, height: 50, dropPoint: -6, frequency: 60, reps: 1,
    ...champs,
    ...(pauseAfter === undefined ? {} : { pauseAfter }),
  });
}

test('normalizeBall conserve pauseAfter : la pause voyage avec sa balle', () => {
  assert.equal(avecPause(7).pauseAfter, 7);
});

test('pauseAfter est nul par défaut', () => {
  assert.equal(avecPause(undefined).pauseAfter, 0);
  assert.equal(avecPause(0).pauseAfter, 0);
  assert.equal(avecPause(-3).pauseAfter, 0, 'une durée négative n’a pas de sens');
  assert.equal(ball({ speed: 6, spin: 2, height: 50, dropPoint: -6, frequency: 60, reps: 1, pauseAfter: 'abc' }).pauseAfter, 0);
});

test('pauseAfter est borné à 600 s', () => {
  assert.equal(avecPause(100000).pauseAfter, 600);
  assert.equal(avecPause(4.6).pauseAfter, 4.6, 'les demi-secondes restent utiles');
});

test('la pause ne change PAS le paquet envoyé au robot', () => {
  // C'est une directive du logiciel : le robot n'en sait rien. Deux exercices
  // identiques, l'un avec des pauses, l'autre sans, doivent produire exactement
  // les mêmes octets — sinon la pause fausserait les réglages.
  const base = { speed: 6, spin: 2, height: 50, dropPoint: -6, frequency: 60, reps: 1 };
  const sans = packDrill({
    balls: [ball(base), ball({ ...base, dropPoint: 6 })],
    mode: 'endless', random: false,
  });
  const avec = packDrill({
    balls: [avecPause(5, base), avecPause(3, { ...base, dropPoint: 6 })],
    mode: 'endless', random: false,
  });
  assert.deepEqual(Array.from(avec), Array.from(sans));
});

test('la pause survit à un aller-retour JSON (enregistrement puis relecture)', () => {
  const { drill } = buildDrill({
    name: 'Pauses choisies',
    balls: [
      ball({ speed: 5, spin: 0, height: 50, dropPoint: -6, frequency: 60, reps: 1 }),
      ball({ speed: 5, spin: 0, height: 50, dropPoint: 0, frequency: 60, reps: 1, pauseAfter: 8 }),
      ball({ speed: 5, spin: 0, height: 50, dropPoint: 6, frequency: 60, reps: 1 }),
    ],
  });
  const relu = JSON.parse(JSON.stringify(drill));
  assert.deepEqual(relu.balls.map((b) => b.pauseAfter), [0, 8, 0]);
});
