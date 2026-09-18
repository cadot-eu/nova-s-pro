/**
 * Placement du robot sur la table (« Neun-Quadrat-Raster »).
 *
 * Le manuel officiel décrit, au §3.5.1, une page de choix de position :
 *
 *   « on the machine position selection page, you need to select the corresponding
 *     position in the nine-square grid according to the actual position and angle
 *     of the robot, and adjust the angle below so that the animation effect in the
 *     schematic diagram is consistent with the actual angle of the robot. […]
 *     The reset button returns the machine angle to the default 0º. »
 *
 * Et au §3.4.1 : « the robot placement is divided into standard position mode,
 * near-net position mode and custom position mode. »
 *
 * C'est donc un réglage PHYSIQUE, comme la rotation de tête : le logiciel ne peut
 * pas le lire ni le commander, il ne peut que le demander à l'utilisateur. Il
 * compte pourtant, car la couverture de service dépend de l'endroit et de l'angle
 * d'où le robot envoie.
 *
 * ATTENTION : le manuel ne détaille PAS les neuf cases. Les positions ci-dessous
 * sont une lecture raisonnable — trois colonnes (gauche / centre / droite) et
 * trois profondeurs (reculé / au bord / sur la table) — qui contient les deux
 * modes nommés par le manuel. Ce n'est pas une reproduction de l'application.
 */

/**
 * Le réglage par défaut : robot RECULÉ, au centre, sans angle.
 * (Position demandée par l'utilisateur, et la plus fréquente en pratique : la
 * machine se pose derrière la table.)
 */
export const DEFAULT_SQUARE = 1;      // ligne « fond de table », colonne « centre »
export const DEFAULT_ANGLE = 0;

/**
 * Les trois profondeurs où poser le robot, SUR SA MOITIÉ DE TABLE.
 *
 * La grille découpe la moitié du robot (du fond de table au filet) en trois
 * bandes. « Près du filet » est la position dite « near-net » du manuel.
 */
export const ROBOT_ROWS = Object.freeze([
  { id: 'fond', label: 'Fond de table', hint: 'robot au fond de sa moitié' },
  { id: 'milieu', label: 'Milieu', hint: 'robot au milieu de sa moitié' },
  { id: 'filet', label: 'Près du filet', hint: 'position « near-net » du manuel' },
]);

/** Les trois colonnes. */
export const ROBOT_COLUMNS = Object.freeze([
  { id: 'gauche', label: 'Gauche' },
  { id: 'centre', label: 'Centre' },
  { id: 'droite', label: 'Droite' },
]);

/**
 * Les neuf cases, indexées de 0 (fond, gauche) à 8 (filet, droite).
 * Elles pavent la MOITIÉ DU ROBOT : du fond de table jusqu'au filet.
 */
export const ROBOT_SQUARES = Object.freeze(
  ROBOT_ROWS.flatMap((row, r) => ROBOT_COLUMNS.map((col, c) => ({
    index: r * 3 + c,
    row: r,
    column: c,
    id: `${row.id}-${col.id}`,
    label: `${row.label} · ${col.label}`,
    hint: row.hint,
    // Coordonnées du CENTRE de la case, en pourcentage du schéma :
    // 0 = bord gauche / filet, 100 = bord droit / fond de table.
    lateral: [16.7, 50, 83.3][c],
    depth: [83.3, 50, 16.7][r],
  }))),
);

/** Ramène un index de case dans les bornes. */
export function normalizeSquare(value) {
  // `Number(null)` vaut 0 : sans ce garde-fou, une valeur absente désignerait la
  // case 0 (reculé, gauche) au lieu de la position par défaut.
  if (value === null || value === undefined || value === '') return DEFAULT_SQUARE;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_SQUARE;
  return Math.min(ROBOT_SQUARES.length - 1, Math.max(0, n));
}

/** Ramène un angle de robot dans les bornes du manuel (réglable à la main). */
export function normalizeRobotAngle(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_ANGLE;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_ANGLE;
  return Math.round(Math.min(90, Math.max(-90, n)));
}

/** La case correspondant à un index. */
export function squareAt(index) {
  return ROBOT_SQUARES[normalizeSquare(index)];
}

/**
 * Décrit le placement pour l'affichage et pour le prompt du modèle.
 */
export function describeSetup(square, angle) {
  const s = squareAt(square);
  const a = normalizeRobotAngle(angle);
  const orientation = a === 0
    ? 'axe neutre (0°)'
    : `orienté de ${Math.abs(a)}° vers la ${a < 0 ? 'gauche' : 'droite'}`;
  return `robot placé « ${s.label} » (${s.hint}), ${orientation}`;
}

/**
 * Décrit ce que le placement implique, en une phrase, pour le prompt du modèle.
 * Le manuel insiste sur un point : c'est l'angle de placement qui détermine la
 * zone que le robot peut couvrir.
 */
export function setupAdvice(square, angle) {
  const s = squareAt(square);
  const a = normalizeRobotAngle(angle);
  const conseils = [];

  if (s.row === 0) conseils.push('robot au fond de sa moitié : il a toute la table à couvrir, les balles longues sont plus faciles');
  if (s.row === 1) conseils.push('robot au milieu de sa moitié : position la plus polyvalente');
  if (s.row === 2) conseils.push('robot près du filet : les balles courtes sont plus faciles, les balles longues plus difficiles');
  if (s.column === 0) conseils.push('robot décalé à gauche : il couvre mieux le côté gauche');
  if (s.column === 2) conseils.push('robot décalé à droite : il couvre mieux le côté droit');
  if (a !== 0) conseils.push(`orienté de ${Math.abs(a)}° : la zone réellement couverte est décalée du même côté`);

  return conseils.join(' ; ');
}


/* -------------------------------------------------------------------------- */
/* Effet du placement sur le tir                                              */
/* -------------------------------------------------------------------------- */

/**
 * Ce que le placement change, une fois chiffré.
 *
 * Le manuel ne donne AUCUNE conversion entre la case et le point de chute. Ces
 * valeurs sont donc un modèle, choisi pour être cohérent avec ce que le manuel
 * affirme qualitativement :
 *
 *   - « the larger the speed parameter, the closer the landing point is to the
 *     bottom edge » : la profondeur dépend de la distance à parcourir, donc
 *     reculer le robot RACCOURCIT la balle et l'avancer l'ALLONGE ;
 *   - le placement latéral décale la zone couverte du même côté.
 *
 * Un cran de profondeur vaut 8 % de la moitié de table, un cran latéral 12 %.
 */
export const PLACEMENT_EFFECT = Object.freeze({
  depthPerRow: 0.08,     // par cran d'éloignement (0 = au milieu)
  lateralPerColumn: 12,  // en pourcentage de la largeur
});

/** Décalage de profondeur, en fraction (négatif = plus court). */
export function robotDepthShift(square) {
  const s = squareAt(square);
  return (s.row - 1) * PLACEMENT_EFFECT.depthPerRow;
}

/** Décalage latéral, en pourcentage de largeur (0 = centré). */
export function robotLateralShift(square) {
  const s = squareAt(square);
  return (s.column - 1) * PLACEMENT_EFFECT.lateralPerColumn;
}

/**
 * Point de sortie du ballon, en mètres, selon la case du robot.
 *
 * `x` est mesuré depuis le bord de table côté robot (négatif = derrière).
 * C'est ce qui change la longueur réellement parcourue, donc l'arc et le temps
 * de vol — même quand la cible sur la table ne bouge pas.
 */
export function robotLaunchX(square) {
  const s = squareAt(square);
  // Le robot est SUR sa moitié : de 0,15 m après son fond de table jusqu'à
  // 1,15 m, soit juste avant le filet (situé à 1,37 m).
  return [0.15, 0.65, 1.15][s.row];
}

/** Hauteur de la tête, en mètres au-dessus du plan de jeu. */
export function robotLaunchY() {
  return 0.40;
}

/** Décrit en une phrase ce que le placement change pour le tir. */
export function placementEffect(square) {
  const s = squareAt(square);
  const profondeur = robotDepthShift(square) === 0
    ? 'profondeur de référence'
    : robotDepthShift(square) < 0
      ? `balles plus courtes de ${Math.round(-robotDepthShift(square) * 100)} %`
      : `balles plus longues de ${Math.round(robotDepthShift(square) * 100)} %`;
  const lateral = robotLateralShift(square) === 0
    ? 'zone centrée'
    : `zone décalée de ${Math.abs(robotLateralShift(square))} % vers la ${robotLateralShift(square) < 0 ? 'gauche' : 'droite'}`;
  return `${s.label} → ${profondeur}, ${lateral}`;
}
