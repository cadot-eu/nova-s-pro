/**
 * Tests de la balistique.
 *
 * Deux choses comptent ici :
 *   - les TENDANCES doivent être celles qu'attend un joueur (plus vite → plus
 *     loin, plus de top-spin → plus court, plus de back-spin → plus long) ;
 *   - les deux vues de l'interface doivent être COHÉRENTES, puisque la vue du
 *     dessus lit `depth` et la vue de côté lit `points`. Un test vérifie que la
 *     trajectoire retombe bien là où la profondeur l'annonce.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ANGLE_MAX_DEG,
  ANGLE_MIN_DEG,
  depthToLandingX,
  estimatedDepthPercent,
  LAUNCH,
  launchAngle,
  liftCoefficient,
  nominalSpeed,
  arcHeight,
  bounceCount,
  buildTrajectory,
  predictBall,
  projector,
  solveDepthBoth,
  solveDepthParameter,
  SPEED_MAX_MS,
  SPEED_MIN_MS,
  TABLE,
  trajectoryPath,
} from '../src/ballistics.js';
import { dropPointFromLateral, lateralPercent } from '../src/head.js';

/* -------------------------------------------------------------------------- */
/* Conversions issues du manuel                                               */
/* -------------------------------------------------------------------------- */

test('la vitesse de sortie suit les bornes du manuel (2 à 15 m/s)', () => {
  assert.equal(nominalSpeed(0), SPEED_MIN_MS);
  assert.equal(nominalSpeed(10), SPEED_MAX_MS);
  assert.equal(nominalSpeed(5), (SPEED_MIN_MS + SPEED_MAX_MS) / 2);
  assert.equal(nominalSpeed(-5), SPEED_MIN_MS, 'borné');
  assert.equal(nominalSpeed(50), SPEED_MAX_MS, 'borné');
  assert.equal(nominalSpeed(undefined), SPEED_MIN_MS);
});

test('l’angle de sortie suit les couples du manuel (-17° à 33°)', () => {
  assert.equal(launchAngle(-50), ANGLE_MIN_DEG);
  assert.equal(launchAngle(100), ANGLE_MAX_DEG);
  assert.equal(launchAngle(0), -17 + (50 / 150) * 50, 'height 0 → 0,67°');
  assert.equal(launchAngle(-500), ANGLE_MIN_DEG, 'borné');
  assert.equal(launchAngle(500), ANGLE_MAX_DEG, 'borné');
});

test('le coefficient de portance est signé et proportionnel', () => {
  assert.equal(liftCoefficient(0), 0);
  assert.ok(liftCoefficient(5) > 0, 'top-spin → portance positive (vers le bas)');
  assert.ok(liftCoefficient(-5) < 0, 'back-spin → portance négative (vers le haut)');
  assert.equal(liftCoefficient(10), -liftCoefficient(-10), 'symétrique');
  assert.equal(liftCoefficient(500), liftCoefficient(10), 'borné');
});

/* -------------------------------------------------------------------------- */
/* La profondeur répond aux trois paramètres                                  */
/* -------------------------------------------------------------------------- */

test('plus la balle est rapide, plus elle tombe loin', () => {
  const depths = [0, 2, 4, 6, 8, 10].map((s) => estimatedDepthPercent(s, 50, 0));
  for (let i = 1; i < depths.length; i++) {
    assert.ok(depths[i] > depths[i - 1], `speed ${i * 2} devrait être plus profond : ${depths.join(', ')}`);
  }
});

test('le top-spin raccourcit et le back-spin allonge', () => {
  // C'est la demande explicite : changer l'effet doit changer la profondeur.
  const depths = [-10, -6, -2, 0, 2, 6, 10].map((sp) => estimatedDepthPercent(5, 50, sp));
  for (let i = 1; i < depths.length; i++) {
    assert.ok(depths[i] < depths[i - 1], `le spin croissant doit raccourcir : ${depths.join(', ')}`);
  }
  // Et l'écart doit être net, pas cosmétique.
  assert.ok(depths[0] - depths.at(-1) > 25, `amplitude trop faible : ${depths[0]} → ${depths.at(-1)}`);
});

test('une balle plus haute retombe plus court', () => {
  // Mesuré sur le robot (feuille « Sextuples for Slow Balls and Cerves ») : à
  // hauteur croissante les balles deviennent des « short push » qui rebondissent
  // de plus en plus (1 rebond à 10, 5 à 60, 8 à 95). Donc hauteur ↑ → plus court.
  const depths = [-50, -20, 0, 30, 60, 100].map((h) => estimatedDepthPercent(5, h, 0));
  for (let i = 1; i < depths.length; i++) {
    assert.ok(depths[i] <= depths[i - 1], `height croissant doit raccourcir : ${depths.join(', ')}`);
  }
  assert.ok(depths[0] - depths.at(-1) > 15, `l’écart doit être net : ${depths[0]} → ${depths.at(-1)}`);
});

test('la profondeur reste toujours dans le cadre, sur tout l’espace', () => {
  for (let speed = 0; speed <= 10; speed += 0.5) {
    for (let height = -50; height <= 100; height += 10) {
      for (const spin of [-10, -5, 0, 5, 10]) {
        const d = estimatedDepthPercent(speed, height, spin);
        assert.ok(d >= 0 && d <= 100, `profondeur ${d} hors bornes pour ${speed}/${height}/${spin}`);
      }
    }
  }
});

test('depthToLandingX place la chute entre le filet et le fond', () => {
  assert.equal(depthToLandingX(0), TABLE.netX, '0 % = au filet');
  assert.equal(depthToLandingX(100), TABLE.length, '100 % = au fond');
  assert.equal(depthToLandingX(50), (TABLE.netX + TABLE.length) / 2);
  assert.equal(depthToLandingX(-50), TABLE.netX, 'borné');
  assert.equal(depthToLandingX(500), TABLE.length, 'borné');
});

/* -------------------------------------------------------------------------- */
/* La trajectoire est celle qui aboutit à la profondeur annoncée              */
/* -------------------------------------------------------------------------- */

test('la trajectoire retombe exactement là où la profondeur l’annonce', () => {
  // C'est LE test qui garantit que les deux vues ne peuvent pas se contredire.
  for (const speed of [1, 3, 5, 7, 9]) {
    for (const height of [-30, 0, 50, 100]) {
      for (const spin of [-8, 0, 8]) {
        const p = predictBall({ speed, height, spin });
        const attendu = depthToLandingX(p.depth);
        assert.ok(
          Math.abs(p.landingX - attendu) < 0.02,
          `chute ${p.landingX.toFixed(3)} m au lieu de ${attendu.toFixed(3)} m `
            + `pour speed ${speed}, height ${height}, spin ${spin}`,
        );
      }
    }
  }
});

test('la trajectoire est monotone en x et part du point de sortie', () => {
  const p = predictBall({ speed: 5, height: 50, spin: 2 });
  assert.ok(p.points.length > 10, 'assez de points pour un tracé lisse');
  assert.equal(p.points[0].x, LAUNCH.x, 'la trajectoire part de la tête du robot');
  assert.ok(Math.abs(p.points[0].y - LAUNCH.y) < 1e-9);
  for (let i = 1; i < p.points.length; i++) {
    assert.ok(p.points[i].x >= p.points[i - 1].x, 'la balle avance toujours');
  }
  // Le point de chute annoncé doit se trouver SUR le trajet (les rebonds
  // suivants continuent après, donc ce n'est plus le dernier point).
  const auSol = p.points.filter((pt) => Math.abs(pt.y) < 1e-9).map((pt) => pt.x);
  assert.ok(auSol.some((x) => Math.abs(x - p.landingX) < 1e-9),
    `le point de chute ${p.landingX.toFixed(3)} doit être un contact au sol`);
  assert.ok(Math.abs(p.points.at(-1).y) < 1e-9, 'la trajectoire finit au sol');
  assert.ok(p.netClearance !== null, 'la hauteur au filet doit être mesurée');
});

test('l’arc s’élève avec la hauteur et s’abaisse avec le top-spin', () => {
  // Le réglage « Bogen auf/ab » du robot, et l'effet de l'effet.
  assert.ok(arcHeight(100, 0) > arcHeight(0, 0), 'plus haut → arc plus haut');
  assert.ok(arcHeight(0, 0) > arcHeight(-50, 0));
  assert.ok(arcHeight(50, -8) > arcHeight(50, 0), 'le back-spin flotte');
  assert.ok(arcHeight(50, 8) < arcHeight(50, 0), 'le top-spin plonge');
  // Et l'arc reste dans des proportions plausibles.
  for (const h of [-50, 0, 50, 100]) {
    for (const sp of [-10, 0, 10]) {
      const a = arcHeight(h, sp);
      assert.ok(a > 0 && a < 0.7, `arc ${a} hors proportions pour ${h}/${sp}`);
    }
  }
});

test('le temps de vol reste plausible', () => {
  // C'est un temps de PARCOURS (distance sur vitesse annoncée), pas une mesure.
  // Une balle à 2 m/s sur 2,7 m met légitimement plus d'une seconde.
  for (const speed of [0, 5, 10]) {
    for (const spin of [-8, 0, 8]) {
      const p = predictBall({ speed, height: 50, spin });
      assert.ok(p.flightTime > 0.05 && p.flightTime < 2.0, `temps de vol ${p.flightTime.toFixed(2)} s`);
      // 1,2 m couvre un lob ; au-delà ce serait un arc absurde.
      assert.ok(p.apex > 0 && p.apex < 1.2, `sommet ${p.apex.toFixed(2)} m`);
    }
  }
});

test('une balle lente vole plus longtemps qu’une balle rapide', () => {
  const lent = predictBall({ speed: 1, height: 50, spin: 0 });
  const rapide = predictBall({ speed: 9, height: 50, spin: 0 });
  assert.ok(lent.flightTime > rapide.flightTime, 'la balle lente met plus de temps');
});

test('buildTrajectory aboutit toujours exactement à la cible demandée', () => {
  for (const targetX of [1.40, 1.8, 2.2, 2.70]) {
    for (const height of [-50, 50, 100]) {
      for (const spin of [-10, 0, 10]) {
        const t = buildTrajectory({ targetX, height, spin, speed: 5 });
        assert.ok(Math.abs(t.landingX - targetX) < 1e-9, `cible ${targetX}`);
        const contacts = t.points.filter((pt) => Math.abs(pt.y) < 1e-9).map((pt) => pt.x);
        assert.ok(contacts.some((x) => Math.abs(x - targetX) < 1e-9),
          `la cible ${targetX} doit être un contact au sol`);
      }
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Projection pour le dessin                                                  */
/* -------------------------------------------------------------------------- */

test('le repère de projection couvre la table de bout en bout', () => {
  const projeter = projector({ heightMeters: 1.0 });
  assert.ok(Math.abs(projeter(LAUNCH.x, 0).x - 0) < 1e-6, 'la sortie est au bord gauche');
  assert.ok(Math.abs(projeter(TABLE.length, 0).x - 1000) < 1e-6, 'le fond est au bord droit');
  assert.equal(projeter(0, 0).y, 1000, 'le sol est en bas');
  assert.equal(projeter(0, 1).y, 0, 'un mètre est en haut');
  assert.equal(projeter(0, 5).y, 0, 'au-delà, la hauteur est bornée');
});

test('trajectoryPath produit un chemin SVG valide', () => {
  const p = predictBall({ speed: 6, height: 50, spin: 0 });
  const d = trajectoryPath(p);
  assert.match(d, /^M[-\d.]+,[-\d.]+( L[-\d.]+,[-\d.]+)+$/, 'chemin M puis L');
  assert.ok(!d.includes('NaN'), 'aucune coordonnée invalide');
  assert.ok(!d.includes('undefined'));
});

test('aucune coordonnée invalide sur tout l’espace des paramètres', () => {
  for (let speed = 0; speed <= 10; speed += 1) {
    for (let height = -50; height <= 100; height += 25) {
      for (const spin of [-10, 0, 10]) {
        const p = predictBall({ speed, height, spin });
        assert.ok(Number.isFinite(p.landingX), `landingX pour ${speed}/${height}/${spin}`);
        assert.ok(Number.isFinite(p.flightTime));
        assert.ok(p.points.every((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y)),
          `points invalides pour ${speed}/${height}/${spin}`);
        const d = trajectoryPath(p);
        assert.ok(!d.includes('NaN'), `chemin invalide pour ${speed}/${height}/${spin}`);
      }
    }
  }
});

test('predictBall tolère une balle vide sans lever', () => {
  const p = predictBall({});
  assert.ok(Number.isFinite(p.depth));
  assert.ok(Number.isFinite(p.landingX));
});

/* -------------------------------------------------------------------------- */
/* Inverse : viser une profondeur (glisser-déposer)                           */
/* -------------------------------------------------------------------------- */

test('solveDepthParameter atteint la profondeur visée en changeant la vitesse', () => {
  // Avec hauteur 50 et sans effet, la vitesse couvre environ 49 % à 66 %.
  for (const cible of [50, 55, 60, 65]) {
    const r = solveDepthParameter({ depthPercent: cible, knob: 'speed', speed: 5, height: 50, spin: 0 });
    assert.ok(Math.abs(r.reachedDepth - cible) <= 2,
      `viser ${cible} % → ${r.reachedDepth} % (vitesse ${r.value})`);
    assert.ok(r.value >= 0 && r.value <= 10);
    assert.ok(Math.abs(r.value * 2 - Math.round(r.value * 2)) < 1e-9, 'multiple de 0.5');
  }
});

test('solveDepthParameter atteint la profondeur visée en changeant la hauteur', () => {
  // La hauteur est le levier principal de la profondeur, et la décroissance est
  // régulière : toute la plage est atteignable, sans trou.
  for (const cible of [30, 50, 70, 85]) {
    const r = solveDepthParameter({ depthPercent: cible, knob: 'height', speed: 5, height: 50, spin: 0 });
    assert.ok(Math.abs(r.reachedDepth - cible) <= 2, `viser ${cible} % → ${r.reachedDepth} %`);
    assert.ok(r.value >= -50 && r.value <= 100);
    assert.equal(r.value, Math.round(r.value), 'la hauteur est entière');
  }
});

test('le glissement vertical atteint toute la table, sans trou', () => {
  // Régression : une falaise entre un et deux rebonds rendait la zone 45–85 %
  // INATTEIGNABLE. En glissant une balle vers le fond, elle s'arrêtait au milieu.
  let precedente = -1;
  for (let cible = 15; cible <= 90; cible += 5) {
    const r = solveDepthBoth({ depthPercent: cible, speed: 5, height: 50, spin: 0 });
    assert.ok(!r.saturated, `viser ${cible} % doit être atteignable (obtenu ${r.reachedDepth} %)`);
    assert.ok(Math.abs(r.reachedDepth - cible) <= 3, `viser ${cible} % → ${r.reachedDepth} %`);
    assert.ok(r.reachedDepth > precedente, `la progression doit être monotone : ${cible} %`);
    precedente = r.reachedDepth;
  }
});

test('solveDepthParameter signale une cible hors de portée', () => {
  // Avec un fort top-spin, la hauteur ne suffit pas à aller au fond.
  const loin = solveDepthParameter({ depthPercent: 99, knob: 'height', speed: 5, height: 50, spin: 10 });
  assert.equal(loin.saturated, true, 'la saturation doit être signalée');
  assert.ok(loin.reachedDepth < 99, 'et la cible n’est pas atteinte');

  // Une cible facile ne sature pas.
  const facile = solveDepthParameter({ depthPercent: 50, knob: 'speed', speed: 5, height: 50, spin: 0 });
  assert.equal(facile.saturated, false);
});

test('un glissement simulé retombe là où le modèle le dit', () => {
  // On simule un geste : la balle est déplacée à un endroit du schéma, puis on
  // vérifie que la position recalculée depuis les paramètres est bien celle-là.
  for (const [xPercent, cibleDepth] of [[10, 30], [50, 60], [90, 85]]) {
    const dropPoint = dropPointFromLateral(xPercent);
    const res = solveDepthParameter({ depthPercent: cibleDepth, knob: 'speed', speed: 5, height: 50, spin: 0 });
    const relu = predictBall({ speed: res.value, height: 50, spin: 0 });
    // La profondeur effectivement obtenue est celle annoncée par le solveur.
    assert.equal(relu.depth, res.reachedDepth);
    // Et le placement revient au même endroit du schéma.
    assert.equal(lateralPercent(dropPoint), Math.round(xPercent / 5) * 5);
  }
});


/* -------------------------------------------------------------------------- */
/* Rebonds (manuel §3.5.4)                                                    */
/* -------------------------------------------------------------------------- */

test('une hauteur négative ajoute un rebond sur la moitié du robot', () => {
  // « set the ball height parameter to a NEGATIVE value » → premier rebond sur
  // la moitié du ROBOT (manuel §3.5.4), en plus de ceux de la moitié du joueur.
  for (const height of [-50, -30, -1]) {
    const p = predictBall({ speed: 5, height, spin: 0 });
    assert.ok(p.firstBounceX !== null, `hauteur ${height} : le premier bond doit être situé`);
    assert.ok(p.firstBounceX > LAUNCH.x && p.firstBounceX < TABLE.netX,
      `le premier bond (${p.firstBounceX}) doit être sur la moitié du robot`);
    assert.ok(p.bounces >= 2, `hauteur ${height} → au moins 2 rebonds`);
  }
  for (const height of [0, 30, 100]) {
    const p = predictBall({ speed: 5, height, spin: 0 });
    assert.equal(p.firstBounceX, null, `hauteur ${height} : pas de bond côté robot`);
    assert.ok(p.bounces >= 1);
  }
});

test('le modèle de rebonds reproduit les mesures publiées', () => {
  // Relevés sur le robot (feuille « Sextuples for Slow Balls and Cerves »),
  // roues au minimum, hauteur de 10 à 95.
  const mesures = {
    10: 1, 15: 1, 20: 1, 25: 2, 30: 2, 35: 2.5, 40: 2.8, 45: 3.2,
    50: 3.8, 55: 4.2, 60: 5, 65: 5, 70: 5, 75: 6, 80: 7, 85: 7, 95: 8,
  };
  // Vitesses réelles de ces balles (roues 500 / LW), pour rejouer les mesures.
  const vitesses = {
    10: 2.70, 15: 2.39, 20: 1.99, 25: 1.83, 30: 1.67, 35: 1.51, 40: 1.44, 45: 1.36,
    50: 1.24, 55: 1.16, 60: 1.12, 65: 1.08, 70: 1.04, 75: 0.96, 80: 0.92, 85: 0.90, 95: 0.89,
  };
  let pire = 0;
  for (const [h, attendu] of Object.entries(mesures)) {
    const calcule = bounceCount(Number(h), vitesses[h]);
    pire = Math.max(pire, Math.abs(calcule - attendu));
  }
  assert.ok(pire <= 1, `écart maximal ${pire} rebond : le modèle doit rester à un demi-rebond près`);
});

test('une balle rapide rebondit moins qu’une balle lente de même hauteur', () => {
  for (const height of [30, 60, 90]) {
    const lent = bounceCount(height, 1);
    const rapide = bounceCount(height, 9);
    assert.ok(rapide < lent, `hauteur ${height} : ${rapide} devrait être < ${lent}`);
  }
});

test('le nombre de rebonds reste borné', () => {
  for (let h = -50; h <= 100; h += 5) {
    for (const v of [0, 5, 10]) {
      const n = bounceCount(h, v);
      assert.ok(n >= 1 && n <= 8, `hauteur ${h}, vitesse ${v} → ${n}`);
      assert.ok(Math.abs(n * 2 - Math.round(n * 2)) < 1e-9, 'compté au demi-rebond');
    }
  }
});

test('plus la hauteur est négative, plus le premier bond est proche du robot', () => {
  const bonds = [-50, -40, -30, -20, -10].map((h) => predictBall({ speed: 5, height: h, spin: 0 }).firstBounceX);
  for (let i = 1; i < bonds.length; i++) {
    assert.ok(bonds[i] > bonds[i - 1], `les bonds doivent avancer : ${bonds.map((b) => b.toFixed(2)).join(', ')}`);
  }
});

test('une balle à rebond côté robot franchit quand même le filet', () => {
  // Sans la contrainte de franchissement, le second arc partait du sol et
  // passait sous le filet : le modèle annonçait une balle dans le filet là où
  // le robot envoie une balle valide.
  for (const height of [-50, -30, -10]) {
    for (const speed of [2, 5, 8]) {
      const p = predictBall({ speed, height, spin: 0 });
      assert.ok(p.clearsNet, `hauteur ${height}, vitesse ${speed} : filet à ${(p.netClearance * 100).toFixed(0)} cm`);
    }
  }
});

test('le sommet de l’arc reste plausible sur tout l’espace', () => {
  let pire = 0;
  for (let speed = 0; speed <= 10; speed += 0.5) {
    for (let height = -50; height <= 100; height += 10) {
      for (const spin of [-10, 0, 10]) {
        pire = Math.max(pire, predictBall({ speed, height, spin }).apex);
      }
    }
  }
  // Un lob peut monter haut, mais pas au-delà : la contrainte de filet est
  // plafonnée pour éviter un arc absurde quand la cible est juste après le filet.
  assert.ok(pire < 1.3, `sommet maximal ${pire.toFixed(2)} m`);
});


/* -------------------------------------------------------------------------- */
/* Le placement du robot change le tir                                        */
/* -------------------------------------------------------------------------- */

test('reculer le robot raccourcit la balle et avance le point de chute', () => {
  const balle = { speed: 5, spin: 0, height: 50 };
  const recule = predictBall(balle, { depthShift: -0.14, launchX: -0.55 });
  const auBord = predictBall(balle, { depthShift: 0, launchX: -0.20 });
  const surTable = predictBall(balle, { depthShift: 0.14, launchX: 0.55 });

  assert.ok(recule.depth < auBord.depth, `${recule.depth} < ${auBord.depth}`);
  assert.ok(surTable.depth > auBord.depth, `${surTable.depth} > ${auBord.depth}`);
  assert.ok(recule.landingX < surTable.landingX, 'et le point de chute suit');
});

test('le point de sortie déplace réellement le début de la trajectoire', () => {
  const recule = predictBall({ speed: 5, spin: 0, height: 50 }, { launchX: -0.55 });
  const surTable = predictBall({ speed: 5, spin: 0, height: 50 }, { launchX: 0.55 });
  assert.ok(recule.points[0].x < surTable.points[0].x, 'la trajectoire ne part pas du même endroit');
  assert.ok(recule.flightTime > surTable.flightTime, 'et le temps de parcours diffère');
});

test('sans placement, le comportement reste celui d’avant', () => {
  const balle = { speed: 5, spin: 2, height: 50 };
  const sans = predictBall(balle);
  const neutre = predictBall(balle, { depthShift: 0, launchX: null });
  assert.equal(sans.depth, neutre.depth);
  assert.equal(sans.landingX, neutre.landingX);
});
