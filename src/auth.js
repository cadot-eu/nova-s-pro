/**
 * Poignée de main d'authentification du Pongbot Nova S Pro.
 *
 * Le robot refuse toute commande si cette séquence n'a pas été exécutée : il
 * coupe la connexion. Elle repose sur un défi/réponse MD5 dont les constantes
 * viennent de olanga/nova (js/constants.js) et smee/nova-s-custom-drills.
 *
 * Séquence complète :
 *   1. écrire 07 00 00 00      → notification : octets 6-17 = numéro de série,
 *                                octets 18+ = code dynamique
 *   2. écrire 08 20 00 + hash  → hash = MD5(serial + sel(serial) + code), 32 caractères ASCII
 *   3. attendre la notification → écrire 01 00 00
 *   4. attendre la notification → écrire 02 00 00 (la réponse contient le firmware)
 *   5. attendre la notification → écrire 80 01 00 00 (réveil)
 *   6. attendre deux notifications de transition : le robot est prêt
 *
 * Après le réveil, seules DEUX notifications arrivent avant que le robot ne soit
 * prêt. La troisième (état 0x04 = actif) accompagne l'accusé de réception du
 * premier exercice : l'attendre ici provoque un délai d'attente de 15 secondes.
 */

import { createHash } from 'node:crypto';

/** Table de sel, 36 caractères, indexée par `code(lettre) % 36`. */
export const AUTH_SALT = 'Mjgx1jAwXDBaMFcxCz3JBgNVBAYT4kJF7Rkw';

export const CMD_CHALLENGE = Buffer.from([0x07, 0x00, 0x00, 0x00]);
export const CMD_ACK1 = Buffer.from([0x01, 0x00, 0x00]);
export const CMD_ACK2 = Buffer.from([0x02, 0x00, 0x00]);
export const CMD_WAKEUP = Buffer.from([0x80, 0x01, 0x00, 0x00]);

export const CMD_STOP = Buffer.from([0x80, 0x01, 0x00, 0x01]);
export const CMD_PAUSE = Buffer.from([0x80, 0x01, 0x00, 0x02]);
export const CMD_RESUME = Buffer.from([0x80, 0x01, 0x00, 0x03]);
export const CMD_KEEPALIVE = Buffer.from([0x83, 0x06, 0x00]);

/** Notifications du robot. */
export const NOTIFY_KEEPALIVE_ACK = Buffer.from([0x00, 0x83, 0x00, 0x00]);
export const NOTIFY_ALREADY_STOPPED = Buffer.from([0x01, 0x80, 0x00, 0x00]);
export const NOTIFY_DRILL_REJECTED = Buffer.from([0x01, 0x81, 0x00, 0x00]);
export const NOTIFY_DONE_HEX = '00020300050100';
export const NOTIFY_STATE_PREFIX = Buffer.from([0x00, 0x02, 0x03, 0x00]);
export const NOTIFY_PROGRESS_PREFIX = Buffer.from([0x00, 0x05, 0x07, 0x00]);

/** États du robot, encodés dans l'octet 4 des notifications d'état. */
export const ROBOT_STATE_BYTE = Object.freeze({
  0x02: 'STANDBY',        // première notification après le réveil
  0x03: 'STANDBY',        // deuxième notification après le réveil
  0x04: 'ACTIVE',
  0x05: 'DRILL_COMPLETE',
  0x06: 'PAUSED',
});

/**
 * Construit la chaîne hachée puis son MD5 hexadécimal minuscule.
 *
 * @param {string} serial numéro de série (les 12 caractères du défi)
 * @param {string} code   code dynamique renvoyé par le robot
 */
export function computeAuthHash(serial, code) {
  let hashme = serial;
  for (const ch of serial) {
    hashme += AUTH_SALT[ch.charCodeAt(0) % AUTH_SALT.length];
  }
  hashme += code;
  return createHash('md5').update(hashme, 'utf8').digest('hex');
}

/**
 * Extrait le numéro de série et le code du défi.
 *
 * Le client d'olanga lit `serial = str.slice(6,18)` et `code = str.slice(18)`.
 * On reste tolérant sur l'encodage : on décode en UTF-8 puis on nettoie les
 * caractères nuls et les espaces de fin que certains firmwares ajoutent.
 */
export function parseChallenge(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 19) {
    throw new Error(
      `Défi d'authentification trop court : ${payload?.length ?? 0} octet(s), 19 attendus. ` +
        `Brut : ${payload?.toString('hex') ?? '(vide)'}`,
    );
  }
  const serial = payload.subarray(6, 18).toString('utf8');
  const code = payload.subarray(18).toString('utf8').replace(/\0+$/, '').trim();
  return { serial, code };
}

/** Construit le paquet de réponse : 08 20 00 + 32 caractères ASCII. */
export function buildAuthResponse(hashHex) {
  if (!/^[0-9a-f]{32}$/.test(hashHex)) {
    throw new Error(`Empreinte MD5 inattendue : ${JSON.stringify(hashHex)}`);
  }
  return Buffer.concat([Buffer.from([0x08, 0x20, 0x00]), Buffer.from(hashHex, 'ascii')]);
}

/** Récupère le numéro de firmware dans la notification de l'étape 4. */
export function extractFirmwareVersion(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('latin1') : String(payload);
  const match = text.match(/V\d+[\w.\-]*/);
  return match ? match[0] : null;
}

/** Décode une notification d'état : renvoie l'état ou null. */
export function parseStateNotification(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 7) return null;
  if (!payload.subarray(0, 4).equals(NOTIFY_STATE_PREFIX)) return null;
  return ROBOT_STATE_BYTE[payload[4]] ?? null;
}

/** Décode une notification de progression d'exercice. */
export function parseProgressNotification(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 11) return null;
  if (!payload.subarray(0, 4).equals(NOTIFY_PROGRESS_PREFIX)) return null;
  return {
    totalShots: payload.readUInt16LE(4),
    ballIndex: payload.readUInt16LE(6),
    sequence: payload.readUInt16LE(8),
    cycle: payload[10],
  };
}
