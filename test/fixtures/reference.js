/**
 * Implémentations de référence, copiées telles quelles depuis les projets
 * d'origine, uniquement pour servir d'oracle dans les tests.
 *
 *   - `packBallReference`  : olanga/nova — js/bluetooth.js
 *   - `createBallReference`: smee/nova-s-custom-drills — src/script.js
 *   - `createDrillReference`: smee/nova-s-custom-drills — src/script.js
 *   - `createDrillOlanga`  : olanga/nova — js/runner.js (en-tête 0x81)
 *   - `modifyDrillOlanga`  : olanga/nova — compiler la sortie 0x84
 *
 * Ne pas modifier ces fonctions : elles doivent rester le miroir fidèle de
 * l'original. Le test échoue si notre encodage s'en écarte d'un seul octet.
 */

import { Buffer } from 'node:buffer';

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/** olanga/nova — js/bluetooth.js `packBall` (verbatim, typé Buffer). */
export function packBallReference(us, ls, bh, dp, freq, reps) {
  const b = Buffer.alloc(24);
  const u = clamp(us, 400, 7500);
  const l = clamp(ls, 400, 7500);
  const bh_f = (clamp(bh, -50, 100) + 50) / 150 * 50 - 20;
  const dp_f = (clamp(dp, -10, 10) + 10) / 20 * 44 - 22;
  const fr_f = (clamp(freq, 0, 100) / 100) + 0.5;

  b.writeUInt32LE(u >>> 0, 0);
  b.writeUInt32LE(l >>> 0, 4);
  b.writeFloatLE(bh_f, 8);
  b.writeFloatLE(dp_f, 12);
  b.writeFloatLE(fr_f, 16);
  b.writeUInt32LE(reps >>> 0, 20);
  return b;
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}
function isDivisable(n, div) {
  return Math.abs(n / div - Math.trunc(n / div)) <= 1e-5;
}

/** smee/nova-s-custom-drills — src/script.js `createBall` (verbatim). */
export function createBallReference(us, ls, bh, dp, freq, reps) {
  assert(us >= 500 && us <= 7274 && isDivisable(us, 1), 'upper wheel speed out of range');
  assert(ls >= 500 && ls <= 7274 && isDivisable(ls, 1), 'lower wheel speed out of range');
  assert(bh >= -50 && bh <= 100 && isDivisable(bh, 1), 'ball height must be int within [-50 .. 100]');
  assert(dp >= -10 && dp <= 10 && isDivisable(dp, 0.5), 'drop point must be multiple of 0.5 within [-10 .. 10]');
  assert(freq >= 0 && freq <= 100 && isDivisable(freq, 10), 'frequency must be multiple of 10 within [0 .. 100]');
  assert(reps >= 1 && reps <= 200 && isDivisable(reps, 1), 'repetitions must be int within [1 .. 200]');

  const buffer = Buffer.alloc(6 * 4);
  buffer.writeUInt32LE(us, 0);
  buffer.writeUInt32LE(ls, 4);
  buffer.writeFloatLE((bh + 50) / 150 * 50 - 20, 8);
  buffer.writeFloatLE((dp + 10) / 20 * 44 - 22, 12);
  buffer.writeFloatLE(freq / 100 * 1 + 0.5, 16);
  buffer.writeUInt32LE(reps, 20);
  return buffer;
}

/**
 * smee/nova-s-custom-drills — src/script.js `createDrill` (verbatim).
 * `combos` occupe l'octet de mode ; pour un exercice sans fin on passe 3.
 */
export function createDrillReference(balls, combos, minutes, isRandom) {
  assert(balls.length > 0 && balls.length <= 9, 'at least one and at most 9 balls are possible');
  if (isRandom) {
    combos = 0;
    minutes = 10;
  }
  const bytes = balls.length * 24;
  const buffer = Buffer.alloc(7 + bytes);
  buffer.writeUInt8(0x81, 0);
  buffer.writeUInt16LE(4 + bytes, 1);
  buffer.writeUInt8(combos || 0, 3);
  buffer.writeUInt16LE(combos ? 0 : minutes || 3, 4);
  buffer.writeUInt8(isRandom ? 1 : 0, 6);
  for (let i = 0; i < balls.length; i++) {
    balls[i].copy(buffer, 7 + i * balls[i].length);
  }
  return buffer;
}

/** olanga/nova — js/runner.js (en-tête 0x81, mode/value explicites). */
export function createDrillOlanga(balls, modeByte, modeValue, isRandom) {
  const bytes = balls.length * 24;
  const buffer = Buffer.alloc(7 + bytes);
  buffer.writeUInt8(0x81, 0);
  buffer.writeUInt16LE(4 + bytes, 1);
  buffer.writeUInt8(modeByte, 3);
  buffer.writeUInt16LE(modeValue, 4);
  buffer.writeUInt8(isRandom ? 1 : 0, 6);
  for (let i = 0; i < balls.length; i++) {
    balls[i].copy(buffer, 7 + i * balls[i].length);
  }
  return buffer;
}

/** olanga/nova — sortie 0x84 (modification d'un exercice en cours). */
export function modifyDrillOlanga(balls) {
  const bytes = balls.length * 24;
  const buffer = Buffer.alloc(3 + bytes);
  buffer.writeUInt8(0x84, 0);
  buffer.writeUInt16LE(1 + bytes, 1);
  for (let i = 0; i < balls.length; i++) {
    balls[i].copy(buffer, 3 + i * balls[i].length);
  }
  return buffer;
}
