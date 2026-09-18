/**
 * Tests du placement du robot (le « nine-square grid » du manuel).
 *
 * Le manuel décrit un réglage MANUEL de la position et de l'angle, sans en
 * détailler les neuf cases. On vérifie donc la cohérence de notre lecture :
 * neuf cases, les deux modes nommés par le manuel présents, et des descriptions
 * exploitables.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ANGLE,
  DEFAULT_SQUARE,
  describeSetup,
  normalizeRobotAngle,
  normalizeSquare,
  ROBOT_COLUMNS,
  ROBOT_ROWS,
  placementEffect,
  robotDepthShift,
  robotLateralShift,
  robotLaunchX,
  ROBOT_SQUARES,
  setupAdvice,
  squareAt,
} from '../src/setup.js';

test('la grille compte neuf cases, toutes distinctes', () => {
  assert.equal(ROBOT_SQUARES.length, 9);
  assert.equal(ROBOT_ROWS.length, 3);
  assert.equal(ROBOT_COLUMNS.length, 3);
  assert.equal(new Set(ROBOT_SQUARES.map((s) => s.id)).size, 9, 'identifiants uniques');
  assert.deepEqual(ROBOT_SQUARES.map((s) => s.index), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('les deux positions nommées par le manuel existent', () => {
  // §3.4.1 : « standard position mode, near-net position mode and custom mode ».
  const standard = ROBOT_SQUARES.find((s) => s.row === 1 && s.column === 1);
  assert.equal(standard.label, 'Milieu · Centre', 'la position polyvalente est au milieu de la moitié');

  // Le défaut demandé est « reculé centre », pas la position standard.
  const defaut = squareAt(DEFAULT_SQUARE);
  assert.equal(defaut.row, 0, 'par défaut le robot est au fond de sa moitié');
  assert.equal(defaut.column, 1, 'et au centre');
  assert.equal(defaut.label, 'Fond de table · Centre');

  const presFilet = ROBOT_SQUARES.filter((x) => x.row === 2);
  assert.equal(presFilet.length, 3, 'trois cases « près du filet »');
  assert.ok(presFilet.every((x) => x.label.startsWith('Près du filet')));
});

test('normalizeSquare borne et écarte les valeurs absurdes', () => {
  assert.equal(normalizeSquare(0), 0);
  assert.equal(normalizeSquare(8), 8);
  assert.equal(normalizeSquare(99), 8, 'borné');
  assert.equal(normalizeSquare(-5), 0, 'borné');
  assert.equal(normalizeSquare(4.4), 4, 'arrondi');
  assert.equal(normalizeSquare(undefined), DEFAULT_SQUARE);
  assert.equal(normalizeSquare('au bord'), DEFAULT_SQUARE);
});

test('normalizeRobotAngle applique le défaut 0° et borne à ±90°', () => {
  assert.equal(DEFAULT_ANGLE, 0, 'le manuel dit « default 0º »');
  assert.equal(normalizeRobotAngle(0), 0);
  assert.equal(normalizeRobotAngle(-30), -30);
  assert.equal(normalizeRobotAngle(500), 90);
  assert.equal(normalizeRobotAngle(-500), -90);
  assert.equal(normalizeRobotAngle(undefined), 0);
  assert.equal(normalizeRobotAngle('droite'), 0);
});

test('describeSetup produit une phrase lisible dans tous les cas', () => {
  assert.match(describeSetup(4, 0), /Milieu · Centre/);
  assert.match(describeSetup(4, 0), /axe neutre/);
  assert.match(describeSetup(0, -30), /Fond de table · Gauche/);
  assert.match(describeSetup(0, -30), /30° vers la gauche/);
  assert.match(describeSetup(8, 45), /45° vers la droite/);
  // L'angle est décrit en valeur absolue, la direction porte le signe.
  assert.ok(!describeSetup(4, -20).includes('-20'));
});

test('setupAdvice explique ce que le placement implique', () => {
  assert.match(setupAdvice(0, 0), /fond de sa moitié/);
  assert.match(setupAdvice(6, 0), /près du filet/);
  assert.match(setupAdvice(3, 0), /gauche/);
  assert.match(setupAdvice(5, 0), /droite/);
  assert.match(setupAdvice(4, -30), /30°/);
  assert.equal(setupAdvice(4, 0), 'robot au milieu de sa moitié : position la plus polyvalente');
});

test('squareAt reste dans les bornes même avec un index invalide', () => {
  assert.equal(squareAt(99).index, 8);
  assert.equal(squareAt(-3).index, 0);
  assert.equal(squareAt(null).index, DEFAULT_SQUARE);
});

/* -------------------------------------------------------------------------- */
/* Effet du placement sur le tir                                              */
/* -------------------------------------------------------------------------- */

test('reculer le robot raccourcit la balle, l’avancer l’allonge', () => {
  assert.ok(robotDepthShift(0) < 0, 'au fond → plus court');
  assert.equal(robotDepthShift(4), 0, 'au milieu → référence');
  assert.ok(robotDepthShift(8) > 0, 'près du filet → plus long');
  assert.equal(robotDepthShift(1), robotDepthShift(0), 'la colonne ne change pas la profondeur');
});

test('le décalage latéral suit la colonne', () => {
  assert.ok(robotLateralShift(3) < 0, 'colonne gauche → vers la gauche');
  assert.equal(robotLateralShift(4), 0, 'centre → aucun décalage');
  assert.ok(robotLateralShift(5) > 0, 'colonne droite → vers la droite');
  assert.equal(robotLateralShift(0), robotLateralShift(3), 'la ligne ne change pas le latéral');
});

test('la distance de sortie dépend de la ligne, pas de la colonne', () => {
  // Le robot est SUR sa moitié : de 0,15 m après son fond de table jusqu'à
  // 1,15 m, juste avant le filet (1,37 m).
  assert.ok(robotLaunchX(0) < robotLaunchX(4), 'au fond, il part de plus loin du filet');
  assert.ok(robotLaunchX(4) < robotLaunchX(8), 'près du filet, il en part plus près');
  assert.ok(robotLaunchX(0) >= 0, 'il reste sur la moitié du robot');
  assert.ok(robotLaunchX(8) < 1.37, 'et ne dépasse pas le filet');
  assert.equal(robotLaunchX(1), robotLaunchX(0));
  assert.equal(robotLaunchX(1), robotLaunchX(2));
});

test('les neuf cases pavent la moitié du robot, sans déborder', () => {
  // Le manuel décrit une grille de neuf cases ; l'utilisateur veut qu'elle
  // recouvre la moitié du robot, pas qu'elle déborde au-dessus de la table.
  const lateral = [...new Set(ROBOT_SQUARES.map((s) => s.lateral))].sort((a, b) => a - b);
  const depth = [...new Set(ROBOT_SQUARES.map((s) => s.depth))].sort((a, b) => a - b);
  assert.deepEqual(lateral, [16.7, 50, 83.3], 'trois colonnes régulières');
  assert.deepEqual(depth, [16.7, 50, 83.3], 'trois lignes régulières');
  for (const s of ROBOT_SQUARES) {
    assert.ok(s.lateral > 0 && s.lateral < 100, 'dans la largeur');
    assert.ok(s.depth > 0 && s.depth < 100, 'dans la profondeur de la moitié du robot');
  }
});

test('la ligne « près du filet » correspond à la position near-net du manuel', () => {
  assert.match(ROBOT_ROWS[2].hint, /near-net/);
  assert.equal(ROBOT_ROWS[2].id, 'filet');
  assert.equal(robotLaunchX(6), 1.15, 'juste avant le filet');
});

test('placementEffect décrit ce que le placement change', () => {
  assert.match(placementEffect(1), /plus courtes/);
  assert.match(placementEffect(7), /plus longues/);
  assert.match(placementEffect(3), /vers la gauche/);
  assert.match(placementEffect(5), /vers la droite/);
  assert.match(placementEffect(4), /profondeur de référence/);
  assert.match(placementEffect(4), /zone centrée/);
});
