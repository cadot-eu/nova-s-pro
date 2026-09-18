/**
 * Vérification de la poignée de main d'authentification.
 *
 * Les deux empreintes de référence ci-dessous ont été calculées hors de ce
 * projet, avec l'implémentation Python indépendante de whoisbe/pongbot-mcp
 * (`hashlib.md5` + la même table de sel). Si notre construction de chaîne ou
 * notre MD5 diverge, ces tests tombent : c'est un contrôle croisé entre deux
 * langages, pas une simple relecture de notre propre code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  AUTH_SALT,
  buildAuthResponse,
  computeAuthHash,
  extractFirmwareVersion,
  parseChallenge,
  parseProgressNotification,
  parseStateNotification,
  NOTIFY_DRILL_REJECTED,
  NOTIFY_KEEPALIVE_ACK,
  NOTIFY_STATE_PREFIX,
  NOTIFY_PROGRESS_PREFIX,
} from '../src/auth.js';

/* Défi A : NOVA01234567 / a1b2c3d4  → 31b2c1a5e0671b8831c0d25da939c22c
   Défi B : O38240700268 / ZZ99      → fa8fd0d9f81f4247542c44d625d70fcd
   (calculés avec Python 3.12 hashlib) */
const CHALLENGE_A = Buffer.concat([
  Buffer.from([0x00, 0x02, 0x03, 0x00, 0x01, 0x00]),
  Buffer.from('NOVA01234567', 'utf8'),
  Buffer.from('a1b2c3d4', 'utf8'),
]);
const HASH_A = '31b2c1a5e0671b8831c0d25da939c22c';

const CHALLENGE_B = Buffer.concat([
  Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]),
  Buffer.from('O38240700268', 'utf8'),
  Buffer.from('ZZ99', 'utf8'),
]);
const HASH_B = 'fa8fd0d9f81f4247542c44d625d70fcd';

test('la table de sel fait bien 36 caractères', () => {
  assert.equal(AUTH_SALT.length, 36);
});

test('computeAuthHash reproduit les empreintes de référence en Python', () => {
  assert.equal(computeAuthHash('NOVA01234567', 'a1b2c3d4'), HASH_A);
  assert.equal(computeAuthHash('O38240700268', 'ZZ99'), HASH_B);
});

test('la chaîne hachée suit bien serial + sel(serial) + code', () => {
  // Contrôle manuel : on reconstruit la chaîne attendue et on la hache à part.
  const serial = 'NOVA01234567';
  const code = 'a1b2c3d4';
  let expected = serial;
  for (const ch of serial) expected += AUTH_SALT[ch.charCodeAt(0) % 36];
  expected += code;

  assert.equal(expected.slice(0, 12), 'NOVA01234567', 'la chaîne commence par le numéro de série');
  assert.equal(expected.length, 12 + 12 + 8, 'série + 12 caractères de sel + code');
  assert.equal(expected.slice(-8), 'a1b2c3d4', 'la chaîne se termine par le code');

  assert.equal(computeAuthHash(serial, code), createHash('md5').update(expected, 'utf8').digest('hex'));
});

test('parseChallenge extrait le numéro de série et le code', () => {
  assert.deepEqual(parseChallenge(CHALLENGE_A), { serial: 'NOVA01234567', code: 'a1b2c3d4' });
  assert.deepEqual(parseChallenge(CHALLENGE_B), { serial: 'O38240700268', code: 'ZZ99' });
});

test('parseChallenge tolère les octets nuls de fin et refuse un défi trop court', () => {
  const padded = Buffer.concat([CHALLENGE_B, Buffer.from([0x00, 0x00])]);
  assert.deepEqual(parseChallenge(padded), { serial: 'O38240700268', code: 'ZZ99' });
  assert.throws(() => parseChallenge(Buffer.from([1, 2, 3])), /trop court/);
  assert.throws(() => parseChallenge(null), /trop court/);
});

test('buildAuthResponse produit un paquet de 35 octets', () => {
  const pkt = buildAuthResponse(HASH_A);
  assert.equal(pkt.length, 35);
  assert.deepEqual(pkt.subarray(0, 3), Buffer.from([0x08, 0x20, 0x00]));
  assert.equal(pkt.subarray(3).toString('ascii'), HASH_A);
});

test('buildAuthResponse refuse une empreinte non conforme', () => {
  assert.throws(() => buildAuthResponse('trop court'), /Empreinte MD5 inattendue/);
  assert.throws(() => buildAuthResponse('Z'.repeat(32)), /Empreinte MD5 inattendue/);
});

test('extractFirmwareVersion lit la version dans la notification', () => {
  assert.equal(extractFirmwareVersion(Buffer.from('V0130.0.5-30.0.6')), 'V0130.0.5-30.0.6');
  assert.equal(
    extractFirmwareVersion(Buffer.concat([Buffer.from([0x00, 0x02]), Buffer.from('ok V0130.0.5-30.0.6\0')])),
    'V0130.0.5-30.0.6',
  );
  assert.equal(extractFirmwareVersion(Buffer.from([0x00, 0x01, 0x02])), null);
});

test('parseStateNotification décode les états du robot', () => {
  const mk = (stateByte) => Buffer.concat([NOTIFY_STATE_PREFIX, Buffer.from([stateByte, 0x01, 0x00])]);
  assert.equal(parseStateNotification(mk(0x02)), 'STANDBY');
  assert.equal(parseStateNotification(mk(0x03)), 'STANDBY');
  assert.equal(parseStateNotification(mk(0x04)), 'ACTIVE');
  assert.equal(parseStateNotification(mk(0x05)), 'DRILL_COMPLETE');
  assert.equal(parseStateNotification(mk(0x06)), 'PAUSED');
  assert.equal(parseStateNotification(mk(0xff)), null);
  assert.equal(parseStateNotification(Buffer.from([0x00, 0x02])), null);
  assert.equal(parseStateNotification(NOTIFY_KEEPALIVE_ACK), null);
});

test('parseProgressNotification décode la progression', () => {
  const payload = Buffer.concat([
    NOTIFY_PROGRESS_PREFIX,
    Buffer.from([0x0c, 0x00, 0x03, 0x00, 0x01, 0x00, 0x02]),
  ]);
  assert.deepEqual(parseProgressNotification(payload), {
    totalShots: 12,
    ballIndex: 3,
    sequence: 1,
    cycle: 2,
  });
  assert.equal(parseProgressNotification(NOTIFY_DRILL_REJECTED), null);
  assert.equal(parseProgressNotification(Buffer.alloc(4)), null);
});

test('les constantes de notification correspondent au protocole documenté', () => {
  assert.equal(NOTIFY_KEEPALIVE_ACK.toString('hex'), '00830000');
  assert.equal(NOTIFY_DRILL_REJECTED.toString('hex'), '01810000');
  assert.equal(NOTIFY_STATE_PREFIX.toString('hex'), '00020300');
  assert.equal(NOTIFY_PROGRESS_PREFIX.toString('hex'), '00050700');
});
