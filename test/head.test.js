/**
 * Tests du modèle de rotation de tête.
 *
 * Le point important : `spin` est la seule valeur d'effet que le robot reçoive,
 * et sa SIGNIFICATION dépend de l'orientation manuelle du pivot latéral. Ces
 * tests vérifient que la décomposition reste cohérente et que les couleurs
 * d'affichage suivent (vert = top-spin, jaune = back-spin).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeHead,
  dropPointFromLateral,
  effectiveSpin,
  HEAD_ANGLE_RANGE,
  HEAD_PRESETS,
  lateralPercent,
  normalizeHeadAngle,
  spinColor,
} from '../src/head.js';

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

test('normalizeHeadAngle borne l’angle et écarte les valeurs absurdes', () => {
  assert.equal(normalizeHeadAngle(0), 0);
  assert.equal(normalizeHeadAngle(45), 45);
  assert.equal(normalizeHeadAngle(-90), -90);
  assert.equal(normalizeHeadAngle(500), 90, 'borné à +90');
  assert.equal(normalizeHeadAngle(-500), -90);
  assert.equal(normalizeHeadAngle(12.4), 12, 'arrondi au degré');
  assert.equal(normalizeHeadAngle('30'), 30);
  assert.equal(normalizeHeadAngle('à droite'), 0);
  assert.equal(normalizeHeadAngle(undefined), 0);
  assert.equal(normalizeHeadAngle(NaN), 0);
});

test('la course annoncée correspond au manuel (180° ± 90°)', () => {
  assert.equal(HEAD_ANGLE_RANGE.min, -90);
  assert.equal(HEAD_ANGLE_RANGE.max, 90);
});

/* -------------------------------------------------------------------------- */
/* Décomposition de l'effet                                                   */
/* -------------------------------------------------------------------------- */

test('à tête droite, l’effet est purement top-spin ou back-spin', () => {
  const top = effectiveSpin(4, 0);
  assert.equal(top.family, 'topback');
  assert.equal(top.topBack, 4);
  assert.equal(top.side, 0);
  assert.equal(top.label, 'top-spin');

  const back = effectiveSpin(-4, 0);
  assert.equal(back.family, 'topback');
  assert.equal(back.topBack, -4);
  assert.equal(back.label, 'back-spin');
});

test('à 90°, l’effet devient purement latéral', () => {
  for (const angle of [90, -90]) {
    const e = effectiveSpin(5, angle);
    assert.equal(e.family, 'side', `angle ${angle}`);
    assert.ok(Math.abs(e.topBack) < 0.001, 'plus aucune composante top/back');
    assert.ok(Math.abs(Math.abs(e.side) - 5) < 0.001, 'toute la magnitude passe en latéral');
  }
});

test('le côté de l’effet latéral s’inverse avec le sens de rotation', () => {
  const gauche = effectiveSpin(4, -90);
  const droite = effectiveSpin(4, 90);
  assert.ok(gauche.side < 0, 'tête à gauche → latéral gauche');
  assert.ok(droite.side > 0, 'tête à droite → latéral droit');
  assert.match(gauche.label, /latéral gauche/);
  assert.match(droite.label, /latéral droit/);
});

test('aux angles intermédiaires l’effet est mixte et décrit comme tel', () => {
  const e = effectiveSpin(4, -45);
  assert.equal(e.family, 'mixed');
  assert.ok(Math.abs(e.topBack - 2.83) < 0.02, `top/back ≈ 2.83, obtenu ${e.topBack}`);
  assert.ok(Math.abs(e.side + 2.83) < 0.02, `latéral ≈ −2.83, obtenu ${e.side}`);
  assert.match(e.label, /top-spin \+ latéral gauche/);
});

test('un spin nul reste sans effet quel que soit l’angle', () => {
  for (const angle of [0, -45, 90]) {
    const e = effectiveSpin(0, angle);
    assert.equal(e.family, 'none');
    assert.equal(e.label, 'sans effet');
    assert.equal(spinColor(0, angle), 'grey');
  }
});

test('la magnitude est conservée : la rotation réoriente, elle n’amplifie pas', () => {
  for (const angle of [-90, -45, 0, 45, 90]) {
    const e = effectiveSpin(6, angle);
    const norme = Math.hypot(e.topBack, e.side);
    assert.ok(Math.abs(norme - 6) < 0.02, `angle ${angle} : norme ${norme} au lieu de 6`);
  }
});

/* -------------------------------------------------------------------------- */
/* Couleurs d'affichage                                                       */
/* -------------------------------------------------------------------------- */

test('les couleurs suivent la demande : vert top-spin, jaune back-spin', () => {
  assert.equal(spinColor(3, 0), 'green');
  assert.equal(spinColor(-3, 0), 'yellow');
  // Tête tournée : l'effet n'est plus ni l'un ni l'autre, une couleur distincte
  // évite de faire croire à un top-spin alors que c'est du latéral.
  assert.equal(spinColor(3, -45), 'orange');
  assert.equal(spinColor(3, -90), 'blue');
  assert.equal(spinColor(-3, 90), 'blue');
});

/* -------------------------------------------------------------------------- */
/* Placement latéral                                                          */
/* -------------------------------------------------------------------------- */

test('le placement latéral suit la convention du manuel', () => {
  // Manuelle §3.4.5 : « a positive value → the RIGHT side of the player ».
  // Le joueur est en bas du schéma et regarde vers le haut : sa droite est la
  // droite de l'écran. La feuille de mesures le confirme — dropPoint -6 y est
  // le côté « bh » (revers), donc la gauche du joueur.
  assert.equal(lateralPercent(0), 50, 'centre');
  assert.equal(lateralPercent(10), 100, 'bord droit');
  assert.equal(lateralPercent(-10), 0, 'bord gauche');
  assert.equal(lateralPercent(5), 75);
  assert.equal(lateralPercent(-5), 25);
  // Hors bornes : ramené dans le cadre.
  assert.equal(lateralPercent(99), 100);
  assert.equal(lateralPercent(-99), 0);
  assert.equal(lateralPercent(undefined), 50);
});

/* -------------------------------------------------------------------------- */
/* Descriptions                                                               */
/* -------------------------------------------------------------------------- */

test('describeHead produit une phrase lisible à chaque position', () => {
  assert.match(describeHead(0), /tête droite/);
  assert.match(describeHead(-90), /90° vers la gauche/);
  assert.match(describeHead(90), /90° vers la droite/);
  assert.match(describeHead(30), /30° vers la droite/);
  assert.match(describeHead(-500), /90° vers la gauche/, 'borné avant description');
});

test('les positions prédéfinies couvrent la course et sont uniques', () => {
  const angles = HEAD_PRESETS.map((p) => p.angle);
  assert.equal(new Set(angles).size, angles.length, 'aucun doublon');
  assert.ok(angles.includes(0), 'la tête droite doit être proposée');
  assert.ok(angles.includes(-90) && angles.includes(90), 'les deux extrêmes doivent être proposés');
  for (const p of HEAD_PRESETS) {
    assert.ok(p.angle >= HEAD_ANGLE_RANGE.min && p.angle <= HEAD_ANGLE_RANGE.max);
    assert.ok(p.label && p.manuel, 'chaque position est nommée');
  }
});

/* -------------------------------------------------------------------------- */
/* Inverse du placement (glisser-déposer)                                     */
/* -------------------------------------------------------------------------- */

test('dropPointFromLateral est l’inverse exact de lateralPercent', () => {
  for (const dropPoint of [-10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10]) {
    const retour = dropPointFromLateral(lateralPercent(dropPoint));
    assert.equal(retour, dropPoint, `aller-retour pour ${dropPoint}`);
  }
});

test('dropPointFromLateral borne et arrondit au pas de 0.5', () => {
  assert.equal(dropPointFromLateral(50), 0, 'le centre');
  assert.equal(dropPointFromLateral(100), 10, 'bord droit → placement positif');
  assert.equal(dropPointFromLateral(0), -10, 'bord gauche → placement négatif');
  assert.equal(dropPointFromLateral(-50), -10, 'borné à gauche');
  assert.equal(dropPointFromLateral(500), 10, 'borné à droite');
  assert.equal(dropPointFromLateral(undefined), 0);
  // Le résultat est toujours un multiple de 0.5, donc encodable par le robot.
  for (let p = 0; p <= 100; p += 3.7) {
    const d = dropPointFromLateral(p);
    assert.ok(Math.abs(d * 2 - Math.round(d * 2)) < 1e-9, `${p} % → ${d} n’est pas un multiple de 0.5`);
  }
});
