/**
 * Rotation de la tête du robot (pivot latéral) et placement latéral.
 *
 * La PROFONDEUR de chute ne vit pas ici mais dans `ballistics.js` : elle dépend
 * aussi de la vitesse, de la hauteur et de l'effet, et les deux vues de
 * l'interface doivent la calculer de la même façon.
 *
 * C'est la seule articulation MANUELLE du NOVA S PRO. Le manuel officiel
 * (NOVA S PRO Benutzerhandbuch V1.0, §2.2) dit :
 *
 *   « Mit Ausnahme des seitlichen Drehgelenks werden andere Gelenke dieses
 *     Produkts automatisch eingestellt. »
 *   → À l'exception du pivot latéral, les autres articulations sont réglées
 *     automatiquement.
 *
 *   Einstellung des Seitenspins : Manuell, 180° ± 90°
 *
 * Autrement dit : on tourne la tête à la main, et cette rotation réoriente
 * l'AXE de rotation des roues. Le Bluetooth ne transporte aucun angle de tête —
 * aucune commande de lecture ni d'écriture n'existe dans la capture BLE — donc
 * le logiciel ne peut que DEMANDER à l'utilisateur où il a placé sa tête, puis
 * en tenir compte.
 *
 * Conséquence pratique : à tête droite, `spin` positif donne du top-spin. À tête
 * tournée de 90°, le même `spin` positif donne un effet purement latéral. Le
 * nombre envoyé au robot ne change pas ; c'est sa signification qui change.
 *
 * Les 9 positions nommées par le manuel :
 *   Top-Spin · linker Top-Spin · linker Spin · links unter Spin · unter Spin ·
 *   Rechts unter Spin · Rechts Spin · Rechts Top Spin · Kein Spin
 * Le manuel ne donne PAS l'angle exact de chacune. On modélise donc la rotation
 * comme une rotation d'axe — top/back = spin·cos(θ), latéral = spin·sin(θ) — et
 * on présente le résultat comme une description, jamais comme une mesure.
 */

/** Course du pivot, en degrés, d'après le manuel : 180° ± 90°. */
export const HEAD_ANGLE_RANGE = Object.freeze({ min: -90, max: 90 });

/**
 * Positions nommées par le manuel, avec l'angle que nous leur prêtons.
 * Les valeurs sont un choix de modélisation, pas une donnée constructeur.
 */
export const HEAD_PRESETS = Object.freeze([
  { label: 'Tête droite', angle: 0, manuel: 'Top-Spin / unter Spin' },
  { label: 'Légèrement à gauche', angle: -30, manuel: 'linker Top-Spin / links unter Spin' },
  { label: 'Nettement à gauche', angle: -60, manuel: 'linker Spin' },
  { label: 'Pleine gauche (effet latéral pur)', angle: -90, manuel: 'linker Spin (90°)' },
  { label: 'Légèrement à droite', angle: 30, manuel: 'Rechts Top Spin / Rechts unter Spin' },
  { label: 'Nettement à droite', angle: 60, manuel: 'Rechts Spin' },
  { label: 'Pleine droite (effet latéral pur)', angle: 90, manuel: 'Rechts Spin (90°)' },
]);

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** Normalise un angle de tête : borné, arrondi au degré, 0 si invalide. */
export function normalizeHeadAngle(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(clamp(n, HEAD_ANGLE_RANGE.min, HEAD_ANGLE_RANGE.max));
}

/**
 * Décompose le spin d'une balle selon l'orientation de la tête.
 *
 * @param {number} spin  valeur envoyée au robot (positif = roue du haut plus rapide)
 * @param {number} headAngle  angle du pivot en degrés (0 = tête droite)
 * @returns {{topBack: number, side: number, total: number, family: string, color: string, label: string}}
 */
export function effectiveSpin(spin, headAngle = 0) {
  const angle = normalizeHeadAngle(headAngle);
  const theta = (angle * Math.PI) / 180;
  const magnitude = Math.abs(spin);

  // Rotation d'axe : la composante top/back suit le cosinus, la composante
  // latérale le sinus. On garde le signe du spin pour savoir de quel côté.
  const topBack = Math.round(spin * Math.cos(theta) * 100) / 100;
  const side = Math.round(spin * Math.sin(theta) * 100) / 100;

  const absTop = Math.abs(topBack);
  const absSide = Math.abs(side);

  let family;
  if (magnitude === 0) family = 'none';
  else if (absSide < magnitude * 0.25) family = 'topback';
  else if (absTop < magnitude * 0.25) family = 'side';
  else family = 'mixed';

  // Vert = effet ascendant/descendant (top/back), jaune = effet latéral pur,
  // et une teinte intermédiaire quand les deux se mélangent.
  const color = family === 'none' ? 'gris'
    : family === 'topback' ? (topBack > 0 ? 'vert' : 'jaune')
    : family === 'side' ? 'bleu'
    : 'orange';

  const cote = side === 0 ? '' : side < 0 ? ' gauche' : ' droit';
  const haut = topBack === 0 ? '' : topBack > 0 ? 'top-spin' : 'back-spin';

  const label = magnitude === 0
    ? 'sans effet'
    : family === 'side' ? `effet latéral${cote}`
    : family === 'topback' ? haut
    : `${haut} + latéral${cote}`;

  return { topBack, side, total: magnitude, family, color, label, angle };
}

/** Couleur d'affichage d'une balle : vert = top-spin, jaune = back-spin. */
export function spinColor(spin, headAngle = 0) {
  const { family, topBack } = effectiveSpin(spin, headAngle);
  if (family === 'none') return 'grey';
  if (family === 'topback') return topBack > 0 ? 'green' : 'yellow';
  return family === 'side' ? 'blue' : 'orange';
}

/**
 * Position latérale approximative d'une balle sur la table, en pourcentage de
 * la largeur (0 = bord gauche, 100 = bord droit).
 *
 * `dropPoint` est le seul paramètre de placement du protocole : il vaut −10 à
 * droite (côté revers d'un droitier) et +10 à gauche. Le manuel confirme la
 * correspondance avec l'angle mécanique (−22° à 22°, mécanique ±25°).
 */
export function lateralPercent(dropPoint) {
  const d = clamp(Number(dropPoint) || 0, -10, 10);
  // CONVENTION DU ROBOT, d'après le manuel officiel (§3.4.5) :
  //   « If the left & right parameter is a positive value, the landing point is
  //     adjusted to the RIGHT side of the player (the player faces the robot). »
  // Donc positif = à DROITE du joueur. Dans le schéma, le joueur est en bas et
  // regarde vers le haut : sa droite est la droite de l'écran.
  // La feuille de mesures le confirme : `dropPoint = -6` y est le côté « bh ».
  return 50 + (d / 10) * 50;
}

/** Décrit le réglage de tête pour l'affichage et pour le prompt du modèle. */
export function describeHead(headAngle) {
  const angle = normalizeHeadAngle(headAngle);
  if (angle === 0) return 'tête droite (axe de rotation horizontal : top-spin / back-spin)';
  const cote = angle < 0 ? 'gauche' : 'droite';
  const intensite = Math.abs(angle) >= 75 ? 'pleine' : Math.abs(angle) >= 45 ? 'nette' : 'légère';
  return `tête tournée de ${Math.abs(angle)}° vers la ${cote} (${intensite}) : `
    + `une part ${intensite} de l'effet devient latérale`;
}

/**
 * Inverse de `lateralPercent` : un pourcentage de largeur → un `dropPoint`.
 *
 * Sert au glisser-déposer : on déplace la balle sur le schéma, et ce paramètre
 * suit. Le résultat est ramené sur le pas de 0.5 et dans les bornes du robot.
 */
export function dropPointFromLateral(percent) {
  const n = Number(percent);
  // Une entrée absente ou illisible vaut le CENTRE, comme pour `lateralPercent`.
  // Sans cela, `undefined` serait traité comme 0 %, donc le bord gauche.
  const p = clamp(Number.isFinite(n) ? n : 50, 0, 100);
  const brut = ((p - 50) / 50) * 10;
  return Math.round(clamp(brut, -10, 10) * 2) / 2;
}
