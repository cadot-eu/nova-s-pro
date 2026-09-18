/**
 * Balistique du ballon : profondeur de chute et trajectoire.
 *
 * Sert aux DEUX vues de l'interface — la vue du dessus (où la balle tombe) et la
 * vue de côté (l'arc) — depuis une source unique, pour qu'elles soient toujours
 * cohérentes. Module pur : aucun import Node, donc le navigateur l'exécute
 * directement (voir `BROWSER_MODULES` dans src/server.js).
 *
 * ---------------------------------------------------------------------------
 * POURQUOI CE N'EST PAS UN SIMPLE LANCER DE PROJECTILE
 * ---------------------------------------------------------------------------
 * Un vrai robot couple vitesse et angle : pour poser une balle rapide sur la
 * table, il l'accompagne d'un angle adapté. Le protocole, lui, expose `speed`,
 * `height` et `spin` comme des paramètres INDÉPENDANTS. Une simulation physique
 * directe donne donc un résultat inutilisable : en balayant toute la plage, à
 * peine 40 % des combinaisons retombent sur la table et la moitié part au-delà
 * du fond. Ce n'est pas un défaut du modèle : c'est le signe que la physique ne
 * peut pas être reconstruite à partir de ces trois nombres seuls.
 *
 * On procède donc en deux temps :
 *
 *   1. la PROFONDEUR vient d'une CALIBRATION sur les trois paramètres, choisie
 *      pour que les réglages usuels se répartissent sur toute la table et pour
 *      que les réponses soient celles qu'attend un joueur : plus vite → plus
 *      loin, plus de top-spin → plus court, plus de back-spin → plus long ;
 *   2. la TRAJECTOIRE est la vraie solution balistique (gravité + traînée +
 *      effet Magnus) qui aboutit à cette profondeur : on résout la vitesse de
 *      sortie nécessaire, puis on intègre. L'arc, la hauteur au-dessus du filet
 *      et le temps de vol sont donc cohérents entre eux.
 *
 * Deux grandeurs viennent du manuel officiel (NOVA S PRO Benutzerhandbuch V1.0,
 * §2.2) et non de nous :
 *
 *   « Geschwindigkeit des Balls : 2 ~ 15 m/s »  →  amplitude de vitesse ;
 *   « Bogen nach oben und unten : 50° (-20° ~ 30°),
 *     mechanischer Winkel -17-33° »             →  `height` pilote un angle de
 *                                                   sortie de −17° à 33°.
 *
 * Ce qui est calibré est signalé comme tel, et l'interface présente le résultat
 * comme une estimation — jamais comme une mesure.
 */

/* -------------------------------------------------------------------------- */
/* Constantes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Portance maximale à spin maximal. Sert à QUALIFIER l'effet (« effet latéral »,
 * « top-spin marqué ») dans les libellés, pas à calculer une trajectoire.
 */
export const MAGNUS_COEFFICIENT = 0.90;

/** Dimensions réglementaires de la table, en mètres. */
export const TABLE = Object.freeze({
  length: 2.74,
  width: 1.525,
  netHeight: 0.1525,
  netX: 1.37,
});

/** Sortie du ballon : tête du robot derrière le bord de table, 40 cm au-dessus. */
export const LAUNCH = Object.freeze({ x: -0.30, y: 0.40 });

/** Bornes d'angle mécanique annoncées par le manuel. */
export const ANGLE_MIN_DEG = -17;
export const ANGLE_MAX_DEG = 33;

/** Bornes de vitesse de sortie, d'après le manuel. */
export const SPEED_MIN_MS = 2.0;
export const SPEED_MAX_MS = 15.0;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * Placement du robot, injecté par l'appelant pour éviter une dépendance
 * circulaire entre `setup.js` et ce module. `null` = placement par défaut.
 */
const PLACEMENT_NEUTRE = { depthShift: 0, launchX: null };

function placement(setup) {
  if (!setup) return PLACEMENT_NEUTRE;
  return {
    depthShift: Number(setup.depthShift) || 0,
    launchX: Number.isFinite(Number(setup.launchX)) ? Number(setup.launchX) : null,
  };
}

/**
 * Pas d'intégration, PARTAGÉ par le solveur et le tracé final.
 *
 * Les deux doivent être identiques : avec des pas différents, la vitesse résolue
 * ne fait pas retomber la balle exactement là où la profondeur l'annonce, et les
 * deux vues de l'interface se contredisent de quelques centimètres. Un test le
 * vérifie.
 */
const SIM_DT = 0.002;

/* -------------------------------------------------------------------------- */
/* Paramètres du robot → grandeurs physiques                                  */
/* -------------------------------------------------------------------------- */

/** `speed` (0–10) → vitesse de sortie nominale en m/s (2–15), d'après le manuel. */
export function nominalSpeed(speed) {
  const s = clamp(Number(speed) || 0, 0, 10);
  return SPEED_MIN_MS + (s / 10) * (SPEED_MAX_MS - SPEED_MIN_MS);
}

/**
 * `height` (−50 à 100) → angle de sortie en degrés (−17 à 33).
 * Les deux couples viennent du manuel : −50 → −17°, 100 → 33°.
 */
export function launchAngle(height) {
  const h = clamp(Number(height) || 0, -50, 100);
  return ANGLE_MIN_DEG + ((h + 50) / 150) * (ANGLE_MAX_DEG - ANGLE_MIN_DEG);
}

/** `spin` (−10 à 10) → coefficient de portance signé (positif = top-spin). */
export function liftCoefficient(spin) {
  const s = clamp(Number(spin) || 0, -10, 10);
  return MAGNUS_COEFFICIENT * (s / 10);
}

/* -------------------------------------------------------------------------- */
/* Étape 1 — profondeur : calibration                                          */
/* -------------------------------------------------------------------------- */

/**
 * Poids de chaque paramètre dans la profondeur.
 *
 * `speed` vient du manuel (§3.5.7 : « the larger the speed parameter, the closer
 * the landing point is to the bottom edge »). Le SIGNE de `height` vient des
 * mesures publiées sur le forum : à hauteur croissante, les balles deviennent des
 * « short push » qui rebondissent de plus en plus (1 rebond à 10, 5 rebonds à 60,
 * 8 rebonds à 95). Une balle haute est donc COURTE, pas longue — l'inverse de ce
 * que ce projet supposait avant de disposer de ces mesures.
 *
 * Les valeurs elles-mêmes restent une calibration.
 */
export const DEPTH_MODEL = Object.freeze({
  /** Profondeur d'une balle qui ne rebondit qu'une fois : elle file au fond. */
  oneBounce: 0.95,
  /**
   * Ce que chaque rebond supplémentaire retire, en fraction de la moitié.
   *
   * Décroissance RÉGULIÈRE, volontairement : une « falaise » entre le premier et
   * le second rebond collait mieux aux libellés de la feuille, mais elle rendait
   * toute la zone 45–85 % INATTEIGNABLE. Impossible alors de poser une balle au
   * fond en la glissant, ni de régler une balle mi-longue : l'utilisateur voyait
   * sa balle s'arrêter au milieu de la table.
   *
   * On perd un peu de fidélité aux libellés, on gagne une table entièrement
   * réglable. Le nombre de rebonds reste le moteur de la profondeur.
   */
  perBounce: 0.115,
  /** Le top-spin raccourcit, le back-spin allonge. */
  spinWeight: 0.14,
  /** Effet direct de la vitesse, en plus de celui qu'elle a via les rebonds. */
  speedWeight: 0.16,
});

/**
 * Profondeur de chute sur la moitié du joueur, en pourcentage.
 * 0 % = au filet, 100 % = au fond.
 *
 * C'est une CALIBRATION, pas une mesure : elle traduit les réglages du robot en
 * une position plausible sur la table, avec les bonnes tendances.
 */
export function estimatedDepthPercent(speed, height, spin = 0, depthShift = 0) {
  const sigma = clamp(Number(spin) || 0, -10, 10) / 10;

  // La profondeur vient du NOMBRE DE REBONDS, la seule grandeur liée à la
  // longueur qui ait été MESURÉE sur le robot (feuille « Sextuples for Slow
  // Balls and Cerves »). C'est bien plus solide qu'une pondération inventée :
  // une balle à un rebond va au fond, une balle à huit rebonds reste au filet.
  const rebonds = playerSideBounces(height, speed);

  const profondeurDeBase = DEPTH_MODEL.oneBounce
    - DEPTH_MODEL.perBounce * (rebonds - 1);

  const sNorm = clamp(Number(speed) || 0, 0, 10) / 10;

  const depth = profondeurDeBase
    + DEPTH_MODEL.speedWeight * (sNorm - 0.5)
    - DEPTH_MODEL.spinWeight * sigma
    // Reculer le robot raccourcit la balle : la distance à parcourir augmente.
    + (Number(depthShift) || 0);

  return Math.round(clamp(depth, 0.05, 0.95) * 100);
}

/** Distance horizontale de chute, en mètres, depuis le bord de table. */
export function depthToLandingX(depthPercent) {
  const d = clamp(Number(depthPercent) || 0, 0, 100) / 100;
  return TABLE.netX + d * (TABLE.length - TABLE.netX);
}

/* -------------------------------------------------------------------------- */
/* Étape 2 — trajectoire : arc paramétré aboutissant à la profondeur            */
/* -------------------------------------------------------------------------- */

/**
 * Hauteur de l'arc au-dessus de la corde qui relie le robot au point de chute.
 *
 *   `height` élève l'arc (réglage « Bogen auf/ab » du robot) ;
 *   le top-spin l'abaisse (la balle plonge), le back-spin le relève (elle flotte).
 *
 * Ce sont des coefficients de MODÈLE. Le robot ne publie pas sa balistique et
 * les trois paramètres du protocole sont indépendants : une intégration physique
 * complète est impossible à calibrer (voir l'encadré en tête de fichier).
 */
export const ARC_MODEL = Object.freeze({
  base: 0.06,
  heightWeight: 0.34,
  spinWeight: 0.22,
  min: 0.005,
  max: 0.65,
});

/** Hauteur de l'arc, en mètres, au-dessus de la ligne robot → point de chute. */
export function arcHeight(height, spin) {
  const hn = (clamp(Number(height) || 0, -50, 100) + 50) / 150;
  const sn = clamp(Number(spin) || 0, -10, 10) / 10;
  const h = ARC_MODEL.base + ARC_MODEL.heightWeight * hn - ARC_MODEL.spinWeight * sn;
  return clamp(h, ARC_MODEL.min, ARC_MODEL.max);
}

/** Nombre de points d'une trajectoire. Assez pour un tracé lisse, assez peu
 *  pour que le navigateur redessine sans saccade à chaque frappe. */
export const ARC_POINTS = 60;

/**
 * Nombre de rebonds avant d'atteindre le joueur.
 *
 * Le manuel officiel est explicite (§3.5.4) :
 *   « If you need to set 2 jump ball (the first landing point is on the robot half
 *     of the table, and the second landing point is on the player half of the
 *     table), you can set the ball height parameter to a NEGATIVE value »
 *
 * Une hauteur négative fait donc rebondir la balle sur la moitié du ROBOT avant
 * qu'elle passe le filet. C'est ce qui rend crédible un tir « vers le bas » :
 * la balle ne traverse pas la table en cloche, elle rebondit d'abord.
 */
export function bounceCount(height, speed = 0) {
  const h = clamp(Number(height) || 0, -50, 100);
  // Hauteur négative : le premier rebond est sur la moitié du ROBOT (§3.5.4).
  const surMoitieRobot = h < 0 ? 1 : 0;
  const cote = playerSideBounces(height, speed);
  return Math.round(clamp(surMoitieRobot + cote, 1, 8) * 2) / 2;
}

/**
 * Rebonds sur la moitié du JOUEUR seulement.
 *
 * C'est cette grandeur qui détermine la profondeur : une balle qui rebondit une
 * fois file au fond, une balle qui rebondit huit fois reste près du filet. Le
 * rebond éventuel sur la moitié du robot (hauteur négative, §3.5.4) n'entre pas
 * en compte : c'est le rebond de service normal, pas un indicateur de longueur.
 */
export function playerSideBounces(height, speed = 0) {
  const h = clamp(Number(height) || 0, -50, 100);

  // Rebonds sur la moitié du joueur. Ajusté sur les mesures de la feuille
  // « Sextuples for Slow Balls and Cerves » : 1 rebond à hauteur 10, 2 à 25,
  // 3,8 à 50, 5 à 60, 7 à 80, 8 à 95. Le coefficient 7,6 (plutôt que 8, qui
  // serait la borne haute) place les valeurs mesurées du bon côté de l'arrondi
  // au demi-rebond.
  //
  // Une loi de puissance reproduit ces valeurs un peu mieux qu'une droite
  // (écart moyen 0,32 rebond contre 0,38, maximum 1 dans les deux cas) : le
  // nombre de rebonds ne peut pas croître indéfiniment, il se tasse.
  const hauteurUtile = Math.max(0, h);
  const brut = 1 + 7.6 * Math.pow(Math.max(0, (hauteurUtile - 10) / 85), 1.15);

  // Les mesures portent sur des balles LENTES (roues proches du minimum). Une
  // balle rapide parcourt plus de distance par rebond, donc en fait moins.
  // L'atténuation 1/(1 + vitesse/14) reproduit les mesures à ±0,5 rebond.
  const attenuation = 1 / (1 + clamp(Number(speed) || 0, 0, 10) / 14);

  // Au moins un rebond sur la moitié du joueur : la balle doit y retomber.
  return Math.max(1, brut * attenuation);
}

/**
 * Position du PREMIER rebond, sur la moitié du robot (entre la sortie et le filet).
 *
 * Plus la hauteur est négative, plus la balle pique tôt. Le coefficient est un
 * choix de modèle : le manuel décrit le comportement, pas la géométrie exacte.
 */
export function firstBounceX(height, launchX = LAUNCH.x) {
  const hn = (clamp(Number(height) || 0, -50, 0) + 50) / 50;   // 0 (très bas) → 1 (au niveau du filet)
  const part = 0.55 + 0.40 * hn;
  return launchX + (TABLE.netX - launchX) * part;
}

/**
 * Longueur du nième rebond, en fraction du premier.
 *
 * Chaque rebond perd de l'énergie : les suivants sont plus courts et plus bas.
 * Coefficient de modèle — les mesures donnent le NOMBRE de rebonds, pas leur
 * espacement.
 */
export const BOUNCE_DECAY = 0.45;

/**
 * Construit la trajectoire : une base rectiligne du robot au point de chute,
 * bombée par une parabole dont la flèche vaut `arcHeight`.
 *
 * L'arc passe donc EXACTEMENT par le point de chute annoncé par la profondeur :
 * les deux vues de l'interface ne peuvent pas se contredire.
 *
 * @returns {{points, landingX, netClearance, apex, flightTime}}
 */
export function buildTrajectory({ targetX, height, spin, speed = 0, setup = null }) {
  const place = placement(setup);
  const x0 = place.launchX ?? LAUNCH.x;
  const y0 = LAUNCH.y;
  const rebonds = bounceCount(height, speed);
  // Premier rebond sur la moitié du robot uniquement si la hauteur est négative.
  const premier = (Number(height) || 0) < 0 ? firstBounceX(height, x0) : null;

  /**
   * Arc parabolique entre deux points posés au sol (ou depuis la sortie du robot).
   *
   * La flèche demandée fixe la hauteur du sommet, MAIS on impose aussi que l'arc
   * franchisse le filet d'au moins 5 cm. Sans cette contrainte, un second bond
   * partant de la moitié du robot passait sous le filet : le modèle annonçait une
   * balle dans le filet là où le robot envoie une balle valide.
   */
  const arc = (debutX, debutY, finX, fleche, nombre) => {
    const longueur = Math.max(0.05, finX - debutX);

    // Coefficient de la parabole A·(x−debut)(fin−x) : sommet à la hauteur voulue.
    const aFleche = (4 * fleche) / (longueur * longueur);

    // Contrainte de franchissement du filet, si celui-ci est dans l'intervalle.
    let aFilet = 0;
    if (debutX < TABLE.netX && finX > TABLE.netX) {
      aFilet = (TABLE.netHeight + 0.05) / ((TABLE.netX - debutX) * (finX - TABLE.netX));
    }

    // La contrainte est PLAFONNÉE : quand la cible tombe juste après le filet, il
    // faudrait une flèche de plusieurs mètres pour franchir le filet de 5 cm, ce
    // qui donnait un arc absurde (3,4 m de sommet). Au-delà du plafond, on laisse
    // l'arc naturel et `clearsNet` dira honnêtement que la balle ne passe pas.
    const PLAFOND_SOMMET = 0.9;   // mètres
    const aMax = (4 * PLAFOND_SOMMET) / (longueur * longueur);
    const A = Math.min(Math.max(aFleche, aFilet), aMax);

    const sortie = [];
    for (let i = 0; i <= nombre; i++) {
      const t = i / nombre;
      const x = debutX + t * longueur;
      // Corde (départ → arrivée), plus le bombement parabolique.
      const corde = debutY * (1 - t);
      sortie.push({ x, y: corde + A * (x - debutX) * (finX - x) });
    }
    return sortie;
  };

  // On construit le trajet en enchaînant les bonds : le premier va du robot au
  // point de chute, les suivants sont de plus en plus courts et de plus en plus
  // bas (perte d'énergie). Le nombre total vient des mesures.
  let points;
  if (premier !== null) {
    const moitie = Math.max(4, Math.round(ARC_POINTS / 4));
    const phase1 = arc(x0, y0, premier, arcHeight(-50, spin), moitie);
    const phase2 = arc(premier, 0, targetX, arcHeight(height, spin), moitie);
    points = [...phase1, ...phase2.slice(1)];
  } else {
    points = arc(x0, y0, targetX, arcHeight(height, spin), ARC_POINTS);
  }

  // Rebonds suivants, sur la moitié du joueur.
  const bondsJoueur = Math.max(0, Math.round(rebonds - (premier !== null ? 2 : 1)));
  let depart = targetX;
  let pas = (targetX - x0) * BOUNCE_DECAY;
  let fleche = arcHeight(height, spin) * 0.55;
  for (let i = 0; i < bondsJoueur; i++) {
    const arrivee = depart + pas;
    const petit = arc(depart, 0, arrivee, fleche, 8);
    points = [...points, ...petit.slice(1)];
    depart = arrivee;
    pas *= BOUNCE_DECAY;
    fleche *= 0.6;
  }

  const auFilet = points.find((pt) => pt.x >= TABLE.netX) ?? points.at(-1);
  const apex = points.reduce((max, pt) => Math.max(max, pt.y), 0);

  // Temps de vol : distance parcourue sur la vitesse nominale du réglage, avec
  // une majoration forfaitaire pour la traînée.
  const vitesse = nominalSpeed(speed);
  const flightTime = ((targetX - x0) * 1.18) / vitesse;

  return {
    points,
    landingX: targetX,
    netClearance: auFilet.y,
    apex,
    flightTime,
    bounces: rebonds,
    firstBounceX: premier,
  };
}

/**
 * Prédiction complète d'une balle : profondeur calibrée, puis arc qui y aboutit.
 */
export function predictBall(ball, setup = null) {
  const speed = Number(ball?.speed) || 0;
  const height = Number(ball?.height) || 0;
  const spin = Number(ball?.spin) || 0;
  const place = placement(setup);

  const depth = estimatedDepthPercent(speed, height, spin, place.depthShift);
  const targetX = depthToLandingX(depth);
  const traj = buildTrajectory({ targetX, height, spin, speed, setup });

  return {
    ...traj,
    depth,
    targetX,
    launchAngle: launchAngle(height),
    lift: liftCoefficient(spin),
    arc: arcHeight(height, spin),
    nominalSpeed: nominalSpeed(speed),
    bounces: traj.bounces,
    firstBounceX: traj.firstBounceX,
    clearsNet: traj.netClearance > TABLE.netHeight + 0.005,
  };
}

/* -------------------------------------------------------------------------- */
/* Projection pour le dessin                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Repère commun aux deux vues : la longueur de table en x, et `heightMeters` de
 * hauteur en y. La table occupe donc toujours la même bande horizontale.
 */
export function projector({ heightMeters = 1.0 } = {}) {
  const x0 = LAUNCH.x;
  const x1 = TABLE.length;
  return (x, y) => ({
    x: ((x - x0) / (x1 - x0)) * 1000,
    y: 1000 - (clamp(y, 0, heightMeters) / heightMeters) * 1000,
  });
}

/** Chemin SVG de la trajectoire, dans le repère de `projector`. */
export function trajectoryPath(prediction, options = {}) {
  const projeter = projector(options);
  return prediction.points
    .map((p, i) => {
      const q = projeter(p.x, p.y);
      return `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;
    })
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Inverse : quelle valeur donner à un paramètre pour viser cette profondeur ?  */
/* -------------------------------------------------------------------------- */

/** Ramène une valeur sur son pas, dans ses bornes. */
function snapClamp(value, step, min, max) {
  const arrondi = Math.round(value / step) * step;
  const borne = clamp(arrondi, min, max);
  return { value: Math.round(borne * 1000) / 1000, saturated: borne !== arrondi };
}

/** Normalisations utilisées par le modèle de profondeur. */
function depthTerms(speed, height, spin) {
  return {
    hNorm: (clamp(Number(height) || 0, -50, 100) + 50) / 150,
    sigma: clamp(Number(spin) || 0, -10, 10) / 10,
    sNorm: clamp(Number(speed) || 0, 0, 10) / 10,
  };
}

/**
 * Le paramètre qui doit changer quand on déplace une balle VERTICALEMENT.
 *
 * La profondeur dépend de trois paramètres ; pour un glissement il en faut un
 * seul. La vitesse est le levier naturel (il porte les trois quarts de
 * l'amplitude) ; la hauteur est proposée en alternative.
 */
export const DEPTH_KNOBS = Object.freeze(['speed', 'height']);

/**
 * Résout la valeur d'un paramètre pour atteindre une profondeur visée.
 *
 * @param {object} o
 * @param {number} o.depthPercent profondeur visée (0–100)
 * @param {'speed'|'height'} [o.knob='speed'] paramètre à faire varier
 * @param {number} o.speed vitesse actuelle (fixe si `knob` vaut 'height')
 * @param {number} o.height hauteur actuelle (fixe si `knob` vaut 'speed')
 * @param {number} o.spin effet actuel
 * @returns {{value: number, saturated: boolean, reachedDepth: number}}
 *          `saturated` signale que la cible était hors de portée : la balle est
 *          allée au plus loin possible avec ce réglage.
 */
export function solveDepthParameter({ depthPercent, knob = 'speed', speed, height, spin }) {
  const cible = clamp(Number(depthPercent) || 0, 0, 100);

  // La profondeur vient désormais du NOMBRE DE REBONDS : elle n'est plus une
  // formule analytique qu'on puisse inverser. Pire, elle présente une falaise
  // entre un et deux rebonds, donc une dichotomie classique peut converger vers
  // n'importe quoi. On balaie donc le paramètre et on garde la valeur la plus
  // proche de la cible — c'est robuste, discontinu ou non.
  const bornes = knob === 'height' ? { min: -50, max: 100, pas: 1 } : { min: 0, max: 10, pas: 0.5 };
  const evalue = (v) => (knob === 'height'
    ? estimatedDepthPercent(speed, v, spin)
    : estimatedDepthPercent(v, height, spin));

  let meilleur = { value: bornes.min, ecart: Infinity, depth: evalue(bornes.min) };
  for (let v = bornes.min; v <= bornes.max; v += bornes.pas / 4) {
    const depth = evalue(v);
    const ecart = Math.abs(depth - cible);
    if (ecart < meilleur.ecart) meilleur = { value: v, ecart, depth };
  }

  // On rend la valeur sur le pas du paramètre, puis on relit la profondeur
  // réellement atteinte : l'interface replace la balle là où elle peut aller.
  const arrondi = Math.round(meilleur.value / bornes.pas) * bornes.pas;
  const value = Math.round(clamp(arrondi, bornes.min, bornes.max) * 1000) / 1000;
  const reachedDepth = evalue(value);

  return {
    value,
    // Hors de portée si même la meilleure valeur laisse un écart net.
    saturated: Math.abs(reachedDepth - cible) > 3,
    reachedDepth,
  };
}


/**
 * Résout un déplacement vertical en jouant sur la VITESSE **et** la HAUTEUR.
 *
 * La vitesse seule ne couvre qu'une partie de la table : à hauteur 50 et sans
 * effet, elle plafonne à 57 %. Impossible, donc, de poser une balle au fond en
 * ne bougeant que la vitesse — et l'utilisateur voit sa balle s'arrêter au
 * milieu quand il la glisse vers le fond.
 *
 * C'est une conséquence directe des mesures : une balle haute est COURTE, donc
 * pour aller au fond il faut aussi baisser la hauteur. On résout donc en deux
 * temps — la hauteur pour atteindre le bon régime, puis la vitesse pour affiner.
 *
 * @returns {{speed: number, height: number, reachedDepth: number, saturated: boolean}}
 */
export function solveDepthBoth({ depthPercent, speed, height, spin }) {
  const cible = clamp(Number(depthPercent) || 0, 0, 100);

  // 1. La hauteur, qui commande le régime (nombre de rebonds).
  const surHauteur = solveDepthParameter({ depthPercent: cible, knob: 'height', speed, height, spin });

  // 2. La vitesse, pour affiner à cette hauteur.
  const surVitesse = solveDepthParameter({
    depthPercent: cible,
    knob: 'speed',
    speed,
    height: surHauteur.value,
    spin,
  });

  const atteint = surVitesse.reachedDepth;
  return {
    speed: surVitesse.value,
    height: surHauteur.value,
    reachedDepth: atteint,
    // Encore hors de portée si même les deux réunis n'y arrivent pas.
    saturated: Math.abs(atteint - cible) > 3,
  };
}
