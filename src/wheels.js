/**
 * Ce que les deux roues du robot savent réellement faire.
 *
 * Ce module est PUR et volontairement minuscule : il est chargé À LA FOIS par le
 * serveur (qui construit le paquet) et par le navigateur (qui affiche les
 * plafonds). C'est la seule façon d'être sûr que l'écran annonce exactement la
 * même limite que celle appliquée à l'envoi — sinon l'utilisateur se bat contre
 * un plafond invisible, ce qui est précisément ce qui donnait l'impression que
 * les champs étaient « bloqués ».
 *
 * Aucune dépendance : ni Node, ni DOM.
 */

/**
 * Plage réellement utilisable des roues : 500 à 7200 tr/min.
 *
 * olanga borne à [400, 7500] et smee valide [500, 7200]. Une campagne de mesures
 * publiée sur le forum (feuille « Sextuples for Slow Balls and Cerves » :
 * 21 hauteurs × 2 effets × min/max, soit 84 valeurs de roues relevées sur le
 * robot) ne sort JAMAIS de [500, 7200], et se colle à ces deux bornes — ce qui
 * est la signature d'une limite sondée expérimentalement.
 *
 * On resserre donc sur la plage mesurée. Conséquence assumée : à vitesse 10 et
 * sans effet, la formule donne 7275 tr/min, ramené à 7200 — la vitesse maximale
 * exacte n'est atteignable qu'avec un peu d'effet, ce que les mesures confirment.
 */
export const RPM_MIN = 500;
export const RPM_MAX = 7200;

/** Pas des paramètres vitesse et effet, en unités « utilisateur ». */
export const PAS_VITESSE = 0.5;
export const PAS_EFFET = 0.5;

/**
 * Table « vitesse → amplitude de spin maximale », contrainte du FIRMWARE.
 *
 * Attention : c'est une limite du micrologiciel, PAS la limite des roues. Les
 * deux ne coïncident pas — à vitesse 8,5 cette table autorise 3, alors que les
 * roues plafonnent à 2,5. Il faut satisfaire les DEUX, donc retenir la plus
 * petite : c'est le rôle de `maxSpinForSpeed`. Afficher cette table seule
 * revenait à promettre un réglage que le robot refusait ensuite.
 */
export const MAX_SPIN_BY_SPEED = Object.freeze({
  0.0: 2, 0.5: 3, 1.0: 4, 1.5: 5, 2.0: 6, 2.5: 7, 3.0: 8, 3.5: 9,
  4.0: 10, 4.5: 10, 5.0: 9, 5.5: 8, 6.0: 8, 6.5: 7, 7.0: 6, 7.5: 5,
  8.0: 4, 8.5: 3, 9.0: 2, 9.5: 1, 10.0: 0,
});

const arrondi = (v) => Math.round(v * 1000) / 1000;

/** Vitesses des roues pour une combinaison (vitesse, effet) donnée. */
export function wheelRpms(speed, spin) {
  const base = 970 + 630.5 * speed;
  const delta = 342 * spin;
  return { top: base + delta, bottom: base - delta };
}

/** Les deux roues tiennent-elles dans [RPM_MIN, RPM_MAX] ? */
export function wheelsInRange(speed, spin) {
  const r = wheelRpms(speed, spin);
  const marge = 0.001;
  return r.top <= RPM_MAX + marge && r.bottom <= RPM_MAX + marge
    && r.top >= RPM_MIN - marge && r.bottom >= RPM_MIN - marge;
}

/** Amplitude de spin maximale acceptée par le FIRMWARE à cette vitesse. */
export function firmwareSpinLimit(speed) {
  return MAX_SPIN_BY_SPEED[speed] ?? null;
}

/**
 * Amplitude de spin maximale que les ROUES acceptent à cette vitesse.
 *
 * On descend de 0,5 en 0,5 : la limite basse (roue qui tourne trop lentement à
 * basse vitesse et fort effet) mord avant la limite haute, c'est pourquoi on
 * teste la combinaison complète plutôt qu'une formule.
 */
export function wheelSpinLimit(speed) {
  for (let amplitude = 20; amplitude >= 0; amplitude -= PAS_EFFET) {
    if (wheelsInRange(speed, amplitude)) return arrondi(amplitude);
  }
  return 0;
}

/**
 * Amplitude de spin maximale RÉELLEMENT utilisable à cette vitesse : la plus
 * petite des deux contraintes. C'est la seule valeur à afficher.
 */
export function maxSpinForSpeed(speed) {
  const firmware = firmwareSpinLimit(speed);
  const roues = wheelSpinLimit(speed);
  return firmware === null ? roues : Math.min(firmware, roues);
}

/**
 * Vitesse maximale utilisable pour une amplitude d'effet donnée.
 *
 * Sert à borner le champ « vitesse » de l'interface : au-delà, les roues ne
 * suivent pas, quelle que soit la valeur saisie.
 */
export function maxSpeedForSpin(spin) {
  const amplitude = Math.abs(Number(spin) || 0);
  for (let vitesse = 10; vitesse >= 0; vitesse -= PAS_VITESSE) {
    if (wheelsInRange(vitesse, amplitude) && wheelsInRange(vitesse, -amplitude)) {
      return arrondi(vitesse);
    }
  }
  return 0;
}

/**
 * Ramène une combinaison (vitesse, effet) à ce que les roues savent réellement
 * faire.
 *
 * Le firmware refuse toute roue hors de [RPM_MIN, RPM_MAX]. Jusqu'ici on
 * écrêtait les roues en gardant les valeurs affichées : l'écran annonçait alors
 * un effet que la balle n'avait pas — on croyait régler 3, le robot en jouait
 * 2,8, et l'on ne comprenait pas pourquoi l'exercice semblait inchangé.
 *
 * On cherche donc la combinaison RÉELLEMENT jouable la plus proche, et l'on
 * affiche celle-là. Ordre de sacrifice : **l'effet d'abord**, la vitesse
 * seulement si même sans effet les roues ne suivent pas. C'est l'usage : la
 * vitesse est le réglage que l'on choisit, l'effet s'y adapte.
 *
 * @returns {{speed: number, spin: number, adjusted: boolean, cause?: 'spin'|'speed'}}
 */
export function fitToWheelRange(speed, spin) {
  if (wheelsInRange(speed, spin)) return { speed, spin, adjusted: false };

  // 1. Réduire l'amplitude de l'effet, en gardant son signe.
  const signe = spin < 0 ? -1 : 1;
  for (let cran = Math.round(Math.abs(spin) / PAS_EFFET); cran >= 0; cran--) {
    const candidat = arrondi(signe * cran * PAS_EFFET);
    if (wheelsInRange(speed, candidat)) {
      return { speed, spin: candidat, adjusted: true, cause: 'spin' };
    }
  }

  // 2. Même sans effet les roues ne suivent pas : c'est la vitesse qui est trop
  //    haute. On la réduit jusqu'à la plus grande valeur jouable.
  for (let cran = Math.round(speed / PAS_VITESSE); cran >= 0; cran--) {
    const candidat = arrondi(cran * PAS_VITESSE);
    if (wheelsInRange(candidat, 0)) {
      return { speed: candidat, spin: 0, adjusted: true, cause: 'speed' };
    }
  }
  return { speed: 0, spin: 0, adjusted: true, cause: 'speed' };
}

/**
 * Les plafonds à AFFICHER pour une balle donnée, en unités utilisateur.
 *
 * L'interface s'en sert pour borner les champs et pour écrire « max 2,5 » à
 * côté : l'utilisateur voit la limite au lieu de la découvrir en butant dessus.
 */
export function plafonds(speed, spin) {
  const vitesse = Number(speed) || 0;
  const effet = Math.abs(Number(spin) || 0);
  return {
    /** Effet maximal utilisable à cette vitesse. */
    maxSpin: maxSpinForSpeed(vitesse),
    /** Vitesse maximale utilisable avec cet effet. */
    maxSpeed: maxSpeedForSpin(effet),
  };
}
