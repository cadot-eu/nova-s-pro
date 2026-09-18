/**
 * Les limites des roues, et la cohérence entre ce qui est AFFICHÉ et ce qui est
 * APPLIQUÉ.
 *
 * C'est le cœur du bug qui donnait l'impression que les champs étaient bloqués :
 * l'application affichait un plafond (la table du firmware, « effet 3 à vitesse
 * 8,5 ») et en appliquait un autre (les roues, 2,5). L'utilisateur tapait 3, le
 * champ retombait à 2,5, et plus rien ne bougeait.
 *
 * Ces tests verrouillent l'invariant : le plafond annoncé est EXACTEMENT celui
 * que le serveur fait respecter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RPM_MIN,
  RPM_MAX,
  PAS_EFFET,
  PAS_VITESSE,
  maxSpinForSpeed,
  maxSpeedForSpin,
  firmwareSpinLimit,
  wheelSpinLimit,
  wheelRpms,
  wheelsInRange,
  fitToWheelRange,
  plafonds,
} from '../src/wheels.js';
import { normalizeBall } from '../src/protocol.js';
import { buildSystemPrompt } from '../src/deepseek.js';

const VITESSES = [];
for (let v = 0; v <= 10; v += PAS_VITESSE) VITESSES.push(Math.round(v * 10) / 10);

/**
 * Vitesses où même un effet NUL tient dans les roues.
 *
 * À vitesse 10, ce n'est plus l'effet qu'il faut réduire mais la vitesse
 * elle-même (7275 tr/min) : ce cas est traité à part.
 */
const VITESSES_JOUABLES = VITESSES.filter((v) => wheelsInRange(v, 0));

/* -------------------------------------------------------------------------- */

test('le plafond d’effet annoncé est réellement atteignable', () => {
  for (const vitesse of VITESSES_JOUABLES) {
    const max = maxSpinForSpeed(vitesse);
    assert.ok(
      wheelsInRange(vitesse, max) && wheelsInRange(vitesse, -max),
      `à vitesse ${vitesse}, l'effet ${max} devrait tenir dans les roues : `
      + JSON.stringify(wheelRpms(vitesse, max)),
    );
  }
});

test('le plafond d’effet annoncé est le PLUS GRAND possible', () => {
  // Un demi-pas de plus doit sortir de la plage : sinon le plafond annoncé est
  // trop bas, l'utilisateur est bridé sans raison.
  for (const vitesse of VITESSES_JOUABLES) {
    const max = maxSpinForSpeed(vitesse);
    if (max >= 10) continue; // borne haute « utilisateur », pas « roues »
    const suivant = max + PAS_EFFET;
    assert.ok(
      !wheelsInRange(vitesse, suivant) || !wheelsInRange(vitesse, -suivant),
      `à vitesse ${vitesse}, ${suivant} ne devrait pas être jouable (plafond ${max})`,
    );
  }
});

test('le plafond retenu respecte AUSSI la limite du firmware', () => {
  for (const vitesse of VITESSES) {
    const firmware = firmwareSpinLimit(vitesse);
    assert.ok(
      maxSpinForSpeed(vitesse) <= firmware,
      `à vitesse ${vitesse}, le plafond ${maxSpinForSpeed(vitesse)} dépasse la limite du firmware ${firmware}`,
    );
  }
});

test('les deux plafonds ne coïncident PAS : c’est la plus petite qui gagne', () => {
  // Le cas exact du bug rapporté.
  assert.equal(firmwareSpinLimit(8.5), 3, 'le firmware autorise 3');
  assert.ok(wheelSpinLimit(8.5) < 3, 'les roues, non');
  assert.equal(maxSpinForSpeed(8.5), 2.5, 'donc le plafond utile est 2,5');
});

test('les roues ne sortent jamais de leur plage', () => {
  for (const vitesse of VITESSES) {
    for (let effet = -10; effet <= 10; effet += PAS_EFFET) {
      const { ball } = normalizeBall({
        speed: vitesse, spin: effet, height: 50, dropPoint: 0, frequency: 60, reps: 1,
      });
      assert.ok(
        ball.topRpm >= RPM_MIN && ball.topRpm <= RPM_MAX
        && ball.bottomRpm >= RPM_MIN && ball.bottomRpm <= RPM_MAX,
        `roues hors plage pour ${vitesse}/${effet} : ${ball.topRpm}/${ball.bottomRpm}`,
      );
    }
  }
});

test('un effet DANS le plafond n’est jamais touché', () => {
  for (const vitesse of VITESSES_JOUABLES) {
    const max = maxSpinForSpeed(vitesse);
    for (const effet of [0, max, -max, Math.min(max, 1), -Math.min(max, 1)]) {
      const { ball, adjustments } = normalizeBall({
        speed: vitesse, spin: effet, height: 50, dropPoint: 0, frequency: 60, reps: 1,
      });
      assert.equal(ball.spin, effet, `effet ${effet} modifié à vitesse ${vitesse}`);
      assert.equal(ball.speed, vitesse);
      assert.deepEqual(adjustments, [], `rien à corriger pour ${vitesse}/${effet}`);
    }
  }
});

test('la vitesse maximale est 9,5 : à 10, même sans effet, les roues débordent', () => {
  assert.deepEqual(VITESSES.filter((v) => !wheelsInRange(v, 0)), [10]);
  assert.equal(maxSpeedForSpin(0), 9.5);
  assert.ok(!wheelsInRange(10, 0), 'vitesse 10 sans effet = 7275 tr/min');
  assert.ok(wheelsInRange(9.5, 0), 'vitesse 9,5 = 6960 tr/min');
});

test('à vitesse 10, c’est la VITESSE qu’il faut réduire, pas l’effet', () => {
  // Le plafond d'effet est déjà 0 : il n'y a plus rien à sacrifier côté effet.
  assert.equal(maxSpinForSpeed(10), 0);
  const { ball, adjustments } = normalizeBall({
    speed: 10, spin: 0, height: 50, dropPoint: 0, frequency: 60, reps: 1,
  });
  assert.equal(ball.speed, 9.5);
  assert.equal(ball.spin, 0);
  assert.ok(
    adjustments.some((a) => /vitesse : 10 → 9\.5/.test(a)),
    `la réduction de vitesse doit être signalée : ${JSON.stringify(adjustments)}`,
  );
});

test('maxSpeedForSpin tient compte de l’effet déjà réglé', () => {
  assert.ok(maxSpeedForSpin(5) < maxSpeedForSpin(0), 'un fort effet interdit les hautes vitesses');
  assert.ok(wheelsInRange(maxSpeedForSpin(5), 5));
});

test('fitToWheelRange sacrifie l’effet avant la vitesse', () => {
  const r = fitToWheelRange(10, 4);
  assert.equal(r.adjusted, true);
  assert.equal(r.speed, 9.5, 'la vitesse est conservée autant que possible');
  assert.equal(r.spin, 0);
  const s = fitToWheelRange(8.5, 3);
  assert.equal(s.speed, 8.5);
  assert.equal(s.spin, 2.5);
});

test('plafonds() résume ce qu’il faut afficher', () => {
  assert.deepEqual(plafonds(8.5, 3), { maxSpin: 2.5, maxSpeed: maxSpeedForSpin(3) });
  assert.deepEqual(plafonds(0, 0), { maxSpin: 1, maxSpeed: 9.5 });
});

test('le prompt de l’IA annonce EXACTEMENT le plafond appliqué', () => {
  // Une table recopiée à la main finit par diverger : celle-ci est engendrée.
  const prompt = buildSystemPrompt({});
  const ligne = prompt.split('\n').find((l) => /vitesse 0→/.test(l));
  assert.ok(ligne, 'la table doit figurer dans le prompt');
  for (const vitesse of VITESSES) {
    assert.ok(
      ligne.includes(`${vitesse}→${maxSpinForSpeed(vitesse)}`),
      `le prompt doit annoncer ${maxSpinForSpeed(vitesse)} à vitesse ${vitesse} : ${ligne}`,
    );
  }
  assert.match(prompt, new RegExp(`entre ${RPM_MIN} et ${RPM_MAX} tr/min`));
});
