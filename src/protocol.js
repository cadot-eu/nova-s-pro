/**
 * Protocole binaire du Pongbot Nova S Pro.
 *
 * Ce module est volontairement pur : aucune I/O, aucun Bluetooth. Il transforme
 * un exercice (« drill ») en octets prêts à être écrits sur la caractéristique
 * BLE `02f00000-0000-0000-0000-00000000ff01`.
 *
 * Sources (rétro-ingénierie par olanga et smee, reprises et vérifiées ici) :
 *   - olanga/nova          js/bluetooth.js `packBall`, js/runner.js `sendDrill`
 *   - smee/nova-s-custom-drills  src/script.js `createBall`, `createDrill`
 *
 * Format d'un paquet NEW_DRILL (0x81) :
 *
 *   offset  taille  contenu
 *   0       1       commande = 0x81
 *   1       2       uint16 LE  longueur = 4 + (nombre_de_balles × 24)
 *   3       1       mode : 0x00 = minutes, 0x01 = combos, 0x03 = sans fin
 *   4       2       uint16 LE  valeur du mode (minutes ou combos ; 0 si sans fin)
 *   6       1       aléatoire : 0 = ordre imposé, 1 = ordre aléatoire
 *   7       N×24    les balles
 *
 * Format d'un paquet MODIFY_DRILL (0x84), qui modifie l'exercice en cours :
 *
 *   0       1       commande = 0x84
 *   1       2       uint16 LE  longueur = 1 + (nombre_de_balles × 24)
 *   3       N×24    les balles
 *
 * Balle (24 octets, tout en little-endian) :
 *
 *   0       4       uint32  RPM roue supérieure
 *   4       4       uint32  RPM roue inférieure
 *   8       4       float32 hauteur   (valeur « paquet », voir mise à l'échelle)
 *   12      4       float32 point de chute (idem)
 *   16      4       float32 fréquence (idem)
 *   20      4       uint32  répétitions
 *
 * Les paramètres utilisateur ne sont PAS les valeurs du paquet : hauteur, point
 * de chute et fréquence subissent une transformation affine avant l'encodage.
 */

import { Buffer } from 'node:buffer';

import {
  RPM_MIN,
  RPM_MAX,
  wheelRpms,
  maxSpinForSpeed,
  fitToWheelRange,
} from './wheels.js';

/* -------------------------------------------------------------------------- */
/* Contraintes                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Nombre maximum de balles par exercice.
 * Le robot accepte jusqu'à 20 balles : 7 + 20×24 = 487 octets, ce qui tient
 * dans une écriture longue ATT (512 octets). Au-delà, le paquet est tronqué.
 */
export const MAX_BALLS = 20;

/**
 * Nombre de balles au-delà duquel on prévient l'utilisateur : le client de
 * smee limite explicitement ses exercices personnalisés à 9 balles.
 */
export const SAFE_BALLS = 9;

/**
 * Les limites des roues vivent dans `src/wheels.js`, chargé AUSSI par le
 * navigateur : l'interface borne donc ses champs exactement comme le serveur
 * borne le paquet. On les ré-exporte ici pour que le reste du code (et les
 * tests) continue de les importer depuis `protocol.js`.
 */
export {
  RPM_MIN, RPM_MAX, MAX_SPIN_BY_SPEED,
  wheelRpms, maxSpinForSpeed, fitToWheelRange,
} from './wheels.js';

/** Bornes des paramètres, en unités « utilisateur ». */
export const RANGES = Object.freeze({
  speed:     { min: 0,    max: 10,  step: 0.5 },
  spin:      { min: -10,  max: 10,  step: 0.5 },
  height:    { min: -50,  max: 100, step: 1 },
  dropPoint: { min: -10,  max: 10,  step: 0.5 },
  frequency: { min: 30,   max: 90,  step: 1 },
  reps:      { min: 1,    max: 200, step: 1 },
});

/**
 * La cadence se dit en **balles par minute** (30–90), comme dans l'interface
 * d'olanga où le champ s'appelle « BPM » avec l'indication « 30-90 ».
 *
 * ATTENTION À L'UNITÉ. Le paquet ne stocke pas des bpm mais un pourcentage
 * interne `p = (bpm − 30) / 0,6` (0–100), que l'on encode ensuite en `p/100 + 0,5`
 * (soit 0,5–1,5). C'est la double conversion que fait olanga :
 *
 *   import CSV :  freqPercent = (bpm − 30) / 0.6      (js/state.js)
 *   export CSV :  bpm         = 30 + freqPercent × 0.6
 *   encodage   :  fr_f        = freqPercent / 100 + 0.5   (js/bluetooth.js)
 *
 * Confondre les deux unités est l'erreur facile : 30 bpm vaut 0,5 dans le paquet,
 * pas 0,8. Les presets internes d'olanga (`[1547, 2915, 50, -5, 10, 1]`) donnent
 * d'ailleurs 10 en pourcentage, soit 36 bpm — pas 10 bpm.
 */
export const bpmToPercent = (bpm) => (bpm - 30) / 0.6;

export const percentToBpm = (percent) => 30 + percent * 0.6;

export const DRILL_MODE = Object.freeze({
  MINUTES: 0x00,
  COMBOS: 0x01,
  ENDLESS: 0x03,
});

const CMD_NEW_DRILL = 0x81;
const CMD_MODIFY_DRILL = 0x84;

/** Point de chute : -10 = droite (revers du droitier), +10 = gauche. */
export const DROP_POINT_SIGN_HELP =
  'dropPoint négatif = à gauche (côté revers), positif = à droite (côté coup droit), 0 = plein milieu';

/* -------------------------------------------------------------------------- */
/* Physique : vitesse et spin → RPM des deux roues                            */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Mise à l'échelle des paramètres vers les valeurs « paquet »                */
/* -------------------------------------------------------------------------- */

/** hauteur utilisateur −50…100 → paquet −20…30 */
export const scaleHeight = (h) => ((h + 50) / 150) * 50 - 20;

/** point de chute utilisateur −10…10 → paquet −22…22 */
export const scaleDropPoint = (d) => ((d + 10) / 20) * 44 - 22;

/** fréquence utilisateur en bpm (30…90) → paquet 0.5…1.5 */
export const scaleFrequency = (bpm) => bpmToPercent(bpm) / 100 + 0.5;

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, step) => Math.round(v / step) * step;
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
/** Évite les artefacts binaires du genre 7.500000000000001, et le « -0 ». */
const tidy = (v) => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
};

/**
 * Ramène une valeur dans sa plage et sur son pas. Renvoie la valeur corrigée
 * ainsi qu'une éventuelle note expliquant la correction.
 */
function coerceNumber(value, range, label) {
  if (!isFiniteNumber(value)) {
    return { value: null, note: `${label} : valeur absente ou non numérique` };
  }
  const snapped = round(value, range.step);
  const bounded = clamp(snapped, range.min, range.max);
  const final = tidy(bounded);
  if (final !== value) {
    const why = snapped !== value ? `arrondi au pas de ${range.step}` : `ramené dans [${range.min}, ${range.max}]`;
    return { value: final, note: `${label} : ${value} → ${final} (${why})` };
  }
  return { value: final, note: null };
}

/**
 * Normalise une balle : borne chaque paramètre, applique la limite de spin selon
 * la vitesse, et renvoie les corrections effectuées.
 *
 * Renvoie `{ ball, adjustments, errors }`. `ball` vaut `null` si la balle est
 * inexploitable.
 */
export function normalizeBall(input) {
  const adjustments = [];
  const errors = [];

  if (!input || typeof input !== 'object') {
    return { ball: null, adjustments, errors: ['balle absente ou mal formée'] };
  }

  const fields = {};
  for (const [key, range] of Object.entries(RANGES)) {
    const { value, note } = coerceNumber(input[key], range, key);
    if (note) adjustments.push(note);
    fields[key] = value;
  }

  for (const key of Object.keys(RANGES)) {
    if (fields[key] === null) errors.push(`${key} manquant ou invalide (${JSON.stringify(input[key])})`);
  }
  if (errors.length) return { ball: null, adjustments, errors };

  // Effet maximal utilisable à cette vitesse : le PLUS PETIT des deux plafonds,
  // celui du firmware et celui des roues. On l'applique ici pour que la valeur
  // retenue soit, dès l'abord, une valeur jouable.
  const maxSpin = maxSpinForSpeed(fields.speed);
  if (maxSpin !== null && Math.abs(fields.spin) > maxSpin) {
    const avant = fields.spin;
    fields.spin = tidy(Math.sign(fields.spin || 1) * maxSpin);
    const roues = wheelRpms(fields.speed, fields.spin);
    adjustments.push(
      `effet : ${avant} → ${fields.spin} — maximum jouable à vitesse ${fields.speed}. `
      + `Au-delà, les roues sortiraient de [${RPM_MIN}, ${RPM_MAX}] tr/min. `
      + `Valeurs réellement jouées : roues ${Math.round(roues.top)}/${Math.round(roues.bottom)} tr/min.`,
    );
  }

  // Les roues doivent tenir dans [RPM_MIN, RPM_MAX]. Si la combinaison demandée
  // les en fait sortir, on ne se contente PAS d'écrêter les roues en gardant les
  // valeurs affichées : on recalcule ce que le robot jouera vraiment, et c'est
  // cela que l'on renvoie. L'écran ne peut donc plus mentir.
  const voulu = { speed: fields.speed, spin: fields.spin };
  const jouable = fitToWheelRange(voulu.speed, voulu.spin);
  if (jouable.adjusted) {
    const rouesVoulues = wheelRpms(voulu.speed, voulu.spin);
    fields.speed = jouable.speed;
    fields.spin = jouable.spin;
    const roues = wheelRpms(fields.speed, fields.spin);
    adjustments.push(jouable.cause === 'spin'
      ? `effet : ${voulu.spin} → ${fields.spin} — la roue haute plafonne à ${RPM_MAX} tr/min `
        + `(il en faudrait ${Math.round(rouesVoulues.top)}). Vitesse conservée à ${fields.speed}.`
      : `vitesse : ${voulu.speed} → ${fields.speed}, effet ramené à 0 — même sans effet les roues `
        + `demanderaient ${Math.round(rouesVoulues.top)} tr/min, au-delà de ${RPM_MAX}.`);
    adjustments.push(
      `valeurs réellement jouées : vitesse ${fields.speed}, effet ${fields.spin}, `
      + `roues ${Math.round(roues.top)}/${Math.round(roues.bottom)} tr/min`,
    );
  }

  const rpms = wheelRpms(fields.speed, fields.spin);
  const top = clamp(Math.round(rpms.top), RPM_MIN, RPM_MAX);
  const bottom = clamp(Math.round(rpms.bottom), RPM_MIN, RPM_MAX);

  return {
    ball: {
      speed: fields.speed,
      spin: fields.spin,
      height: fields.height,
      dropPoint: fields.dropPoint,
      frequency: fields.frequency,
      reps: fields.reps,
      topRpm: top,
      bottomRpm: bottom,
      // Directive LOGICIELLE, pas un paramètre du robot : temps d'arrêt APRÈS
      // cette balle, avant la suivante. 0 = enchaîner directement. Elle voyage
      // avec la balle parce que c'est à cet endroit précis qu'on veut la pause.
      pauseAfter: Math.max(0, Math.min(600, Number(input.pauseAfter) || 0)),
    },
    adjustments,
    errors,
  };
}

/** Contrôle strict, sans correction : utile pour les tests et l'import CSV. */
export function validateBall(ball) {
  const errors = [];
  if (!ball || typeof ball !== 'object') return { ok: false, errors: ['balle absente'] };

  for (const [key, range] of Object.entries(RANGES)) {
    const v = ball[key];
    if (!isFiniteNumber(v)) { errors.push(`${key} doit être un nombre`); continue; }
    if (v < range.min || v > range.max) {
      errors.push(`${key} = ${v} hors plage [${range.min}, ${range.max}]`);
    } else if (Math.abs(v / range.step - Math.round(v / range.step)) > 1e-6) {
      errors.push(`${key} = ${v} n'est pas un multiple de ${range.step}`);
    }
  }
  const maxSpin = maxSpinForSpeed(ball.speed);
  if (maxSpin !== null && isFiniteNumber(ball.spin) && Math.abs(ball.spin) > maxSpin) {
    errors.push(`spin = ${ball.spin} dépasse le maximum ${maxSpin} pour la vitesse ${ball.speed}`);
  }
  return { ok: errors.length === 0, errors };
}

/* -------------------------------------------------------------------------- */
/* Encodage                                                                   */
/* -------------------------------------------------------------------------- */

/** Encode une balle (déjà normalisée) sur 24 octets. */
export function packBall(ball) {
  const buf = Buffer.alloc(24);
  buf.writeUInt32LE(ball.topRpm >>> 0, 0);
  buf.writeUInt32LE(ball.bottomRpm >>> 0, 4);
  buf.writeFloatLE(scaleHeight(ball.height), 8);
  buf.writeFloatLE(scaleDropPoint(ball.dropPoint), 12);
  buf.writeFloatLE(scaleFrequency(ball.frequency), 16);
  buf.writeUInt32LE(ball.reps >>> 0, 20);
  return buf;
}

/**
 * Encode un exercice complet.
 *
 * @param {object} drill
 * @param {object[]} drill.balls
 * @param {'minutes'|'combos'|'endless'} [drill.mode='endless']
 * @param {number} [drill.modeValue=0]
 * @param {boolean} [drill.random=false]
 * @param {boolean} [options.modify=false] encode un paquet 0x84 (modification)
 */
export function packDrill(drill, { modify = false } = {}) {
  const balls = drill.balls ?? [];
  if (balls.length === 0) throw new Error('Un exercice doit contenir au moins une balle.');
  if (balls.length > MAX_BALLS) {
    throw new Error(`Un exercice ne peut pas dépasser ${MAX_BALLS} balles (reçu : ${balls.length}).`);
  }

  const payload = Buffer.concat(balls.map(packBall));

  if (modify) {
    const header = Buffer.alloc(3);
    header.writeUInt8(CMD_MODIFY_DRILL, 0);
    header.writeUInt16LE(1 + payload.length, 1);
    return Buffer.concat([header, payload]);
  }

  const mode = drill.mode ?? 'endless';
  const modeByte = DRILL_MODE[mode.toUpperCase()];
  if (modeByte === undefined) {
    throw new Error(`Mode inconnu : ${mode} (attendu : minutes, combos ou endless).`);
  }
  const modeValue = mode === 'endless' ? 0 : (drill.modeValue ?? 0);
  if (mode !== 'endless' && (!Number.isInteger(modeValue) || modeValue < 1 || modeValue > 65535)) {
    throw new Error(`modeValue invalide pour le mode « ${mode} » : ${modeValue}`);
  }

  const header = Buffer.alloc(7);
  header.writeUInt8(CMD_NEW_DRILL, 0);
  header.writeUInt16LE(4 + payload.length, 1);
  header.writeUInt8(modeByte, 3);
  header.writeUInt16LE(modeValue, 4);
  header.writeUInt8(drill.random ? 1 : 0, 6);

  return Buffer.concat([header, payload]);
}

/* -------------------------------------------------------------------------- */
/* Aides de haut niveau                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Construit un exercice à partir d'une description souple (celle que renvoie
 * DeepSeek) : normalise les balles, agrège les corrections, lève si rien
 * d'exploitable n'en sort.
 */
export function buildDrill(input) {
  const rawBalls = Array.isArray(input?.balls) ? input.balls : [];
  if (rawBalls.length === 0) throw new Error('Aucune balle fournie.');

  const balls = [];
  const adjustments = [];
  const errors = [];

  rawBalls.forEach((raw, i) => {
    const { ball, adjustments: adj, errors: err } = normalizeBall(raw);
    if (ball) balls.push(ball);
    else errors.push(`balle ${i + 1} : ${err.join(', ')}`);
    for (const a of adj) adjustments.push(`balle ${i + 1} — ${a}`);
  });

  if (errors.length) throw new Error(`Balles invalides :\n  - ${errors.join('\n  - ')}`);
  if (balls.length > MAX_BALLS) {
    throw new Error(`Trop de balles : ${balls.length} (maximum ${MAX_BALLS}).`);
  }

  const mode = (input.mode ?? 'endless').toLowerCase();
  if (!Object.hasOwn(DRILL_MODE, mode.toUpperCase())) {
    throw new Error(`Mode inconnu : ${mode}`);
  }
  let modeValue = Number.isInteger(input.modeValue) ? input.modeValue : 0;
  if (mode === 'endless') modeValue = 0;
  if (mode !== 'endless' && modeValue < 1) {
    modeValue = 1;
    adjustments.push(`modeValue absent pour le mode « ${mode} » : forcé à 1`);
  }

  return {
    drill: { balls, mode, modeValue, random: Boolean(input.random) },
    adjustments,
  };
}

/**
 * Miroir : renvoie un exercice dont le point de chute est inversé.
 * Le protocole ne possède PAS de drapeau « miroir » — contrairement à ce
 * qu'on lit parfois, l'octet 5 de l'en-tête fait partie de la valeur de mode.
 * Le miroir se fait donc en inversant le point de chute.
 */
export function mirrorDrill(drill) {
  return {
    ...drill,
    balls: drill.balls.map((b) => ({ ...b, dropPoint: tidy(-b.dropPoint) })),
  };
}

/** Vérifie qu'un exercice complet est encodable. */
export function validateDrill(drill) {
  const errors = [];
  const warnings = [];
  const balls = drill?.balls;

  if (!Array.isArray(balls) || balls.length === 0) {
    return { ok: false, errors: ['l’exercice doit contenir au moins une balle'], warnings };
  }
  if (balls.length > MAX_BALLS) errors.push(`trop de balles : ${balls.length} (maximum ${MAX_BALLS})`);
  else if (balls.length > SAFE_BALLS) {
    warnings.push(`${balls.length} balles : au-delà de ${SAFE_BALLS}, certains clients refusent l’exercice.`);
  }

  balls.forEach((b, i) => {
    const { ok, errors: errs } = validateBall(b);
    if (!ok) for (const e of errs) errors.push(`balle ${i + 1} : ${e}`);
  });

  const mode = drill?.mode ?? 'endless';
  if (!Object.hasOwn(DRILL_MODE, String(mode).toUpperCase())) {
    errors.push(`mode inconnu : ${mode}`);
  } else if (mode !== 'endless') {
    const mv = drill.modeValue;
    if (!Number.isInteger(mv) || mv < 1) errors.push(`modeValue doit être un entier ≥ 1 pour le mode « ${mode} »`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* -------------------------------------------------------------------------- */
/* Représentations lisibles et interchangeables                               */
/* -------------------------------------------------------------------------- */

/** Résumé d'une balle, en français, pour l'affichage et le retour au modèle. */
export function describeBall(ball, index) {
  const effect = ball.spin > 0 ? 'topspin' : ball.spin < 0 ? 'backspin' : 'sans effet';
  const cote =
    ball.dropPoint < 0 ? 'à gauche (revers)' :
    ball.dropPoint > 0 ? 'à droite (coup droit)' : 'au centre';
  const prefix = index === undefined ? '' : `Balle ${index + 1} : `;
  return (
    `${prefix}vitesse ${ball.speed}/10, ${effect} ${Math.abs(ball.spin)}/10, ` +
    `hauteur ${ball.height}, chute ${cote} (${ball.dropPoint}), ` +
    `${ball.frequency} bpm, ${ball.reps} rép. — roues ${ball.topRpm}/${ball.bottomRpm} RPM`
  );
}

/** Décrit l'exercice entier en quelques lignes. */
export function describeDrill(drill) {
  const modeLabel =
    drill.mode === 'endless' ? 'sans fin (jusqu’à l’arrêt)' :
    drill.mode === 'minutes' ? `${drill.modeValue} minute(s)` :
    `${drill.modeValue} série(s)`;
  const lines = [
    `${drill.balls.length} balle(s) — mode ${modeLabel} — ordre ${drill.random ? 'aléatoire' : 'fixe'}`,
  ];
  drill.balls.forEach((b, i) => lines.push('  ' + describeBall(b, i)));
  return lines.join('\n');
}

/** En-tête CSV compatible avec le client web d'olanga/nova. */
export const CSV_HEADER = 'Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps';

/**
 * Exporte un exercice au format CSV d'olanga/nova, importable dans son
 * interface web (`Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps`).
 * Les balles de même numéro sont des variantes jouées aléatoirement.
 */
export function drillToCsv(drill, { name = 'Drill', set = 'A' } = {}) {
  const lines = [CSV_HEADER];
  drill.balls.forEach((b, i) => {
    const type = b.spin < 0 ? 'back' : 'top';
    lines.push([
      set,
      i + 1,
      name,
      b.speed,
      Math.abs(b.spin),
      type,
      b.height,
      b.dropPoint,
      b.frequency,
      b.reps,
    ].join(';'));
  });
  return lines.join('\n') + '\n';
}

/**
 * Lit un CSV au format d'olanga/nova. Les lignes partageant le même numéro de
 * balle deviennent des variantes : on les conserve toutes, dans l'ordre.
 */
export function csvToDrill(csv, { name } = {}) {
  const rawBalls = [];
  let drillName = name;
  const errors = [];

  const lines = String(csv).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  for (const [i, line] of lines.entries()) {
    const cells = line.split(';').map((c) => c.trim());
    if (i === 0 && /^set$/i.test(cells[0])) continue; // en-tête
    if (cells.length < 10) { errors.push(`ligne ${i + 1} : ${cells.length} colonnes au lieu de 10`); continue; }
    const [, , ligneName, speed, spin, type, height, drop, bpm, reps] = cells;
    drillName ??= ligneName;
    const magnitude = Number(spin);
    const signed = /^back/i.test(type) ? -Math.abs(magnitude) : Math.abs(magnitude);
    rawBalls.push({
      speed: Number(speed),
      spin: signed,
      height: Number(height),
      dropPoint: Number(drop),
      frequency: Number(bpm),
      reps: Number(reps),
    });
  }

  if (errors.length) throw new Error(`CSV illisible :\n  - ${errors.join('\n  - ')}`);
  if (rawBalls.length === 0) throw new Error('CSV vide : aucune balle trouvée.');

  const { drill, adjustments } = buildDrill({ balls: rawBalls, mode: 'endless', random: false });
  return { drill, name: drillName ?? 'Import CSV', adjustments };
}

/* -------------------------------------------------------------------------- */
/* Format texte de smee/nova-s-custom-drills (« novadrill.txt »)              */
/* -------------------------------------------------------------------------- */

/**
 * Ce format est celui du `<textarea>` du client de smee. Une balle par ligne,
 * six nombres séparés par des espaces ou des virgules :
 *
 *   <RPM roue haute> <RPM roue basse> <hauteur> <chute> <fréquence> <répétitions>
 *
 * `;` commence un commentaire jusqu'à la fin de la ligne. `|` sépare plusieurs
 * variantes d'une même balle (l'original les joue au hasard) : on les conserve
 * toutes comme des balles distinctes.
 *
 * Particularité : ce format décrit les roues en **tours/minute**, pas en
 * « vitesse + effet ». La conversion n'est pas toujours exacte : les RPM de smee
 * ne tombent pas forcément sur la grille de 0.5, et l'écart est signalé.
 */
export const SMEE_FILENAME = 'novadrill.txt';

export const SMEE_TOKEN_PER_BALL = 6;

/**
 * Inverse des formules de `wheelRpms` :
 *   haut = base + 342·spin, bas = base − 342·spin, base = 970 + 630,5·vitesse
 * donc vitesse = (base − 970)/630,5 et spin = (haut − bas)/684.
 */
export function rpmsToSpeedSpin(topRpm, bottomRpm) {
  const base = (topRpm + bottomRpm) / 2;
  return { speed: (base - 970) / 630.5, spin: (topRpm - bottomRpm) / 684 };
}

/** Arrondit à une décimale, pour éviter les 66.66666666666667 dans les fichiers. */
const round1 = (v) => Math.round(v * 10) / 10;

/** Exporte un exercice au format texte de smee. */
export function drillToSmeeText(drill) {
  const lines = drill.balls.map((b) =>
    // Le 5e champ est le pourcentage interne, pas des bpm : 60 bpm s'écrit 50.
    [b.topRpm, b.bottomRpm, b.height, b.dropPoint, round1(bpmToPercent(b.frequency)), b.reps]
      .join(' '));
  return lines.join('\n') + '\n';
}

/**
 * Lit un texte au format de smee.
 *
 * @returns {{balls: object[], variants: number, maxRpmError: number, warnings: string[]}}
 */
export function parseSmeeText(text) {
  const warnings = [];
  const withoutComments = String(text)
    .split(/\r?\n/)
    .map((line) => {
      const cut = line.indexOf(';');
      return cut === -1 ? line : line.slice(0, cut);
    })
    .join('\n');

  const variants = (withoutComments.match(/\|/g) ?? []).length;

  const tokens = withoutComments
    .split(/[\s,|]+/)
    .filter((t) => t.length > 0)
    .map(Number);

  if (tokens.some((n) => !Number.isFinite(n))) {
    throw new Error('Texte smee illisible : certains éléments ne sont pas des nombres.');
  }
  if (tokens.length === 0) {
    throw new Error('Texte smee vide : aucune balle trouvée.');
  }
  if (tokens.length % SMEE_TOKEN_PER_BALL !== 0) {
    throw new Error(
      `Texte smee invalide : ${tokens.length} nombres, or il en faut un multiple de ` +
        `${SMEE_TOKEN_PER_BALL} (un par ligne : RPM haut, RPM bas, hauteur, chute, fréquence, répétitions).`,
    );
  }

  const balls = [];
  let maxRpmError = 0;

  for (let i = 0; i < tokens.length; i += SMEE_TOKEN_PER_BALL) {
    const [topRpm, bottomRpm, height, dropPoint, frequency, reps] = tokens.slice(i, i + SMEE_TOKEN_PER_BALL);
    const ligne = i / SMEE_TOKEN_PER_BALL + 1;

    if (!(topRpm >= RPM_MIN && topRpm <= RPM_MAX) || !(bottomRpm >= RPM_MIN && bottomRpm <= RPM_MAX)) {
      throw new Error(
        `Ligne ${ligne} : les RPM des roues doivent être dans [${RPM_MIN}, ${RPM_MAX}] ` +
          `(reçu ${topRpm} et ${bottomRpm}).`,
      );
    }

    const { speed, spin } = rpmsToSpeedSpin(topRpm, bottomRpm);

    // Le format de smee exprime la cadence en pourcentage (0–100), là où notre
    // modèle parle en bpm (30–90). 0 → 30 bpm, 100 → 90 bpm.
    if (frequency < 0 || frequency > 100) {
      warnings.push(
        `Ligne ${ligne} : cadence ${frequency} hors de [0, 100] en pourcentage ; ` +
          'elle est ramenée dans la plage.',
      );
    }
    const bpm = percentToBpm(frequency);

    const { ball, errors } = normalizeBall({ speed, spin, height, dropPoint, frequency: bpm, reps });
    if (!ball) {
      throw new Error(`Ligne ${ligne} : ${errors.join(', ')}`);
    }

    const err = Math.max(Math.abs(ball.topRpm - topRpm), Math.abs(ball.bottomRpm - bottomRpm));
    maxRpmError = Math.max(maxRpmError, err);
    if (err > 0) {
      warnings.push(
        `Ligne ${ligne} : ${topRpm}/${bottomRpm} tr/min n’est pas atteignable exactement ; ` +
          `le plus proche est ${ball.topRpm}/${ball.bottomRpm} tr/min (écart ${err}).`,
      );
    }
    balls.push(ball);
  }

  return { balls, variants, maxRpmError, warnings };
}

/**
 * Construit un exercice complet depuis un texte smee.
 *
 * L'original joue les variantes séparées par `|` dans un ordre aléatoire : si le
 * texte en contient, on active `random` pour retrouver ce comportement.
 */
export function smeeTextToDrill(text, { name, random = null } = {}) {
  const parsed = parseSmeeText(text);
  const { drill, adjustments } = buildDrill({
    balls: parsed.balls,
    mode: 'endless',
    random: random ?? parsed.variants > 0,
  });
  return {
    drill,
    name: name ?? 'Import smee',
    variants: parsed.variants,
    maxRpmError: parsed.maxRpmError,
    adjustments: [...parsed.warnings, ...adjustments],
  };
}


/* -------------------------------------------------------------------------- */
/* Format CSV hérité d'olanga/nova 1.3                                        */
/* -------------------------------------------------------------------------- */

/**
 * L'ancien client (dossier `1.3/`) exportait un CSV à neuf colonnes qui donne
 * directement les RPM des roues, comme le format de smee :
 *
 *   Set;Ball;Name;Top;Bottom;Height;Drop;Freq;Reps
 *
 * `Freq` y est aussi un pourcentage (0–100), pas des bpm.
 */
export const CSV_LEGACY_HEADER = 'Set;Ball;Name;Top;Bottom;Height;Drop;Freq;Reps';

export function drillToCsvLegacy(drill, { name = 'Drill', set = 'A' } = {}) {
  const lines = [CSV_LEGACY_HEADER];
  drill.balls.forEach((b, i) => {
    lines.push([
      set,
      i + 1,
      name,
      b.topRpm,
      b.bottomRpm,
      b.height,
      b.dropPoint,
      round1(bpmToPercent(b.frequency)),
      b.reps,
    ].join(';'));
  });
  return lines.join('\n') + '\n';
}

export function csvLegacyToDrill(csv, { name } = {}) {
  const lines = String(csv).split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const warnings = [];
  const rawBalls = [];
  let drillName = name;
  let maxRpmError = 0;

  for (const [i, line] of lines.entries()) {
    const cells = line.split(';').map((c) => c.trim());
    if (i === 0 && /^set$/i.test(cells[0])) continue;
    if (cells.length < 9) {
      throw new Error(`CSV 1.3 illisible : ligne ${i + 1}, ${cells.length} colonnes au lieu de 9.`);
    }
    const [, , ligneName, top, bottom, height, dropPoint, freq, reps] = cells;
    drillName ??= ligneName;

    const topRpm = Number(top);
    const bottomRpm = Number(bottom);
    if (!Number.isFinite(topRpm) || !Number.isFinite(bottomRpm)) {
      throw new Error(`CSV 1.3 illisible : ligne ${i + 1}, RPM non numériques (« ${top} », « ${bottom} »).`);
    }
    if (!(topRpm >= RPM_MIN && topRpm <= RPM_MAX) || !(bottomRpm >= RPM_MIN && bottomRpm <= RPM_MAX)) {
      throw new Error(
        `CSV 1.3, ligne ${i + 1} : les RPM doivent être dans [${RPM_MIN}, ${RPM_MAX}] ` +
          `(reçu ${topRpm} et ${bottomRpm}).`,
      );
    }

    const { speed, spin } = rpmsToSpeedSpin(topRpm, bottomRpm);
    const { ball, errors } = normalizeBall({
      speed, spin, height: Number(height), dropPoint: Number(dropPoint),
      frequency: percentToBpm(Number(freq)), reps: Number(reps),
    });
    if (!ball) throw new Error(`CSV 1.3, ligne ${i + 1} : ${errors.join(', ')}`);

    const ecart = Math.max(Math.abs(ball.topRpm - topRpm), Math.abs(ball.bottomRpm - bottomRpm));
    maxRpmError = Math.max(maxRpmError, ecart);
    if (ecart > 0) {
      warnings.push(
        `Ligne ${i + 1} : ${topRpm}/${bottomRpm} tr/min n’est pas atteignable exactement ; ` +
          `le plus proche est ${ball.topRpm}/${ball.bottomRpm} tr/min (écart ${ecart}).`,
      );
    }
    rawBalls.push(ball);
  }

  if (rawBalls.length === 0) throw new Error('CSV 1.3 vide : aucune balle trouvée.');

  const { drill, adjustments } = buildDrill({ balls: rawBalls, mode: 'endless', random: false });
  return { drill, name: drillName ?? 'Import CSV 1.3', maxRpmError, adjustments: [...warnings, ...adjustments] };
}

/* -------------------------------------------------------------------------- */
/* Détection du format                                                        */
/* -------------------------------------------------------------------------- */

export const FORMATS = Object.freeze(['csv', 'csv-legacy', 'smee']);

/**
 * Devine le format d'un contenu d'exercice.
 *
 *   - 10 colonnes séparées par `;`  → CSV actuel d'olanga (Speed/Spin + BPM)
 *   - 9 colonnes séparées par `;`   → CSV hérité d'olanga 1.3 (RPM + pourcentage)
 *   - le reste                      → texte de smee (six nombres par balle)
 *
 * @param {string} texte
 * @param {'csv'|'csv-legacy'|'smee'|'auto'|null} force
 */
export function detectFormat(texte, force = null) {
  if (force) {
    const f = String(force).toLowerCase();
    if (f !== 'auto' && !FORMATS.includes(f)) {
      throw new Error(`Format inconnu : ${force}. Attendu : ${FORMATS.join(', ')} ou auto.`);
    }
    if (f !== 'auto') return f;
  }
  for (const ligne of String(texte).split(/\r?\n/)) {
    const propre = ligne.trim();
    if (!propre || propre.startsWith('#')) continue;
    const colonnes = propre.split(';').length;
    if (colonnes >= 10) return 'csv';
    if (colonnes === 9) return 'csv-legacy';
    return 'smee';
  }
  return 'smee';
}

/* -------------------------------------------------------------------------- */
/* Format interne d'olanga/nova (utilisé par la librairie en ligne)           */
/* -------------------------------------------------------------------------- */

/**
 * La librairie en ligne d'olanga (`nova.varandal.de`) stocke les exercices dans
 * la structure interne de son application :
 *
 *   {
 *     name:   "Nom de l'exercice",
 *     level:  1 | 2 | 3,          // difficulté
 *     random: booléen,            // ordre aléatoire
 *     params: [                   // un tableau par BALLES
 *       [                         //   les variantes de cette balle
 *         [top, bot, hauteur, chute, freqPourcent, reps, 1, speed, spin, type]
 *       ],
 *       ...
 *     ]
 *   }
 *
 * Les balles anciennes ne contiennent que 7 valeurs : `speed`, `spin` et `type`
 * sont alors recalculés depuis les RPM par l'application d'olanga (`js/state.js`,
 * fonction `reverseCalculate`). On écrit les dix valeurs, on lit les deux.
 *
 * `spin` y est une AMPLITUDE positive, avec `type` valant « top » ou « back » —
 * contrairement à notre modèle, qui utilise un spin signé.
 */
export const OLANGA_LEVELS = Object.freeze([1, 2, 3]);

/** Un exercice → la structure `params` d'olanga. */
export function drillToOlangaParams(drill) {
  return drill.balls.map((b) => [[
    b.topRpm,
    b.bottomRpm,
    b.height,
    b.dropPoint,
    round1(bpmToPercent(b.frequency)),
    b.reps,
    1,
    b.speed,
    Math.abs(b.spin),
    b.spin < 0 ? 'back' : 'top',
  ]]);
}

/**
 * La structure `params` d'olanga → nos balles.
 *
 * Les variantes d'une même balle (plusieurs options dans un même groupe) sont
 * conservées comme des balles distinctes : le robot choisit alors au hasard,
 * ce qui correspond à notre drapeau `random`.
 */
export function olangaParamsToBalls(params) {
  if (!Array.isArray(params) || params.length === 0) {
    throw new Error('Exercice en ligne invalide : « params » est vide ou absent.');
  }

  const balls = [];
  const warnings = [];
  let variantes = 0;

  params.forEach((groupe, i) => {
    if (!Array.isArray(groupe) || groupe.length === 0) {
      throw new Error(`Exercice en ligne invalide : le groupe ${i + 1} est vide.`);
    }
    if (groupe.length > 1) variantes += groupe.length - 1;

    groupe.forEach((ball, j) => {
      if (!Array.isArray(ball) || ball.length < 6) {
        throw new Error(
          `Exercice en ligne invalide : la balle ${i + 1}.${j + 1} doit contenir au moins ` +
            `6 nombres (reçu ${Array.isArray(ball) ? ball.length : typeof ball}).`,
        );
      }
      const [topRpm, bottomRpm, height, dropPoint, freqPourcent, reps] = ball.map(Number);
      if (![topRpm, bottomRpm, height, dropPoint, freqPourcent, reps].every(Number.isFinite)) {
        throw new Error(`Exercice en ligne invalide : la balle ${i + 1}.${j + 1} contient une valeur non numérique.`);
      }
      if (!(topRpm >= RPM_MIN && topRpm <= RPM_MAX) || !(bottomRpm >= RPM_MIN && bottomRpm <= RPM_MAX)) {
        throw new Error(
          `Exercice en ligne invalide : balle ${i + 1}.${j + 1}, les RPM doivent être dans ` +
            `[${RPM_MIN}, ${RPM_MAX}] (reçu ${topRpm} et ${bottomRpm}).`,
        );
      }

      const { speed, spin } = rpmsToSpeedSpin(topRpm, bottomRpm);
      const { ball: normalisee, errors } = normalizeBall({
        speed,
        spin,
        height,
        dropPoint,
        frequency: percentToBpm(freqPourcent),
        reps,
      });
      if (!normalisee) {
        throw new Error(`Exercice en ligne invalide : balle ${i + 1}.${j + 1} — ${errors.join(', ')}`);
      }

      const ecart = Math.max(
        Math.abs(normalisee.topRpm - topRpm),
        Math.abs(normalisee.bottomRpm - bottomRpm),
      );
      if (ecart > 0) {
        warnings.push(
          `Balle ${i + 1}.${j + 1} : ${topRpm}/${bottomRpm} tr/min n’est pas atteignable exactement ; ` +
            `le plus proche est ${normalisee.topRpm}/${normalisee.bottomRpm} tr/min (écart ${ecart}).`,
        );
      }
      balls.push(normalisee);
    });
  });

  const maxRpmError = warnings.length ? Math.max(...warnings.map((w) => Number(w.match(/écart (\d+)/)?.[1] ?? 0))) : 0;
  return { balls, variantes, maxRpmError, warnings };
}

/** Un exercice enregistré → la charge utile à publier sur la librairie en ligne. */
export function drillToSharedPayload(record) {
  return {
    name: record.name,
    level: OLANGA_LEVELS.includes(record.difficulty) ? record.difficulty : 1,
    params: drillToOlangaParams(record),
    random: Boolean(record.random),
  };
}

/** La charge utile d'un exercice partagé → un exercice de notre modèle. */
export function sharedPayloadToDrill(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Exercice en ligne illisible : la charge utile est vide.');
  }
  const { balls, variantes, maxRpmError, warnings } = olangaParamsToBalls(payload.params);
  const { drill, adjustments } = buildDrill({
    balls,
    mode: 'endless',
    // Une variante multiple implique un choix aléatoire, comme dans olanga.
    random: payload.random ?? variantes > 0,
  });
  return {
    name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : 'Exercice partagé',
    difficulty: OLANGA_LEVELS.includes(payload.level) ? payload.level : 1,
    drill,
    variantes,
    maxRpmError,
    adjustments: [...warnings, ...adjustments],
  };
}
