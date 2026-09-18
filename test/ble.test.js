/**
 * Tests du transport BLE, contre le robot simulé.
 *
 * On vérifie la séquence d'authentification octet par octet, l'envoi
 * d'exercices, l'arrêt, le keepalive et la robustesse aux déconnexions.
 * Aucun matériel n'est nécessaire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NovaSession, looksLikeNova, withTimeout, BLE } from '../src/ble.js';
import { buildDrill, packDrill } from '../src/protocol.js';
import { computeAuthHash, NOTIFY_KEEPALIVE_ACK } from '../src/auth.js';
import { FakeRobotLink, silentLogger } from './fixtures/fake-robot.js';

const drillOf = (...balls) => buildDrill({
  balls: balls.length ? balls : [{ speed: 9, spin: 2, height: 50, dropPoint: -6, frequency: 70, reps: 1 }],
  mode: 'endless',
  random: true,
}).drill;

/** Prépare une session authentifiée face à un robot simulé. */
async function authenticatedSession(options = {}) {
  const link = new FakeRobotLink(options);
  const session = new NovaSession({ link, logger: silentLogger, timeouts: { standbyMs: 1000, stopAckMs: 500 } });
  const result = await session.authenticate();
  return { link, session, result };
}

/* -------------------------------------------------------------------------- */
/* Détection                                                                  */
/* -------------------------------------------------------------------------- */

test('looksLikeNova reconnaît le robot par son nom', () => {
  assert.equal(looksLikeNova({ name: 'NOVA_O38240700268' }), true);
  assert.equal(looksLikeNova({ name: 'Pongbot-Nova' }), true);
  assert.equal(looksLikeNova({ name: 'UGREEN HiTune S3' }), false);
  assert.equal(looksLikeNova({ name: '' }), false);
});

test('looksLikeNova reconnaît le robot par le service annoncé, même sans nom', () => {
  assert.equal(looksLikeNova({ name: '', services: ['0000feff-0000-1000-8000-00805f9b34fb'] }), true);
  assert.equal(looksLikeNova({ name: '', services: ['feff'] }), true);
  assert.equal(looksLikeNova({ name: '', services: ['180d'] }), false);
  // Le nom reste prioritaire sur le service.
  assert.equal(looksLikeNova({ name: 'Echo Dot', services: ['feff'] }), true);
});

test('withTimeout rejette avec un message explicite', async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20, 'la chose'), /Délai dépassé \(20 ms\) : la chose/);
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000, 'x'), 'ok');
});

/* -------------------------------------------------------------------------- */
/* Authentification                                                           */
/* -------------------------------------------------------------------------- */

test('l’authentification envoie exactement la séquence attendue', async () => {
  const { link, result } = await authenticatedSession();

  const sequence = link.writes.map((w) => w.toString('hex'));
  assert.equal(sequence[0], '07000000', 'demande de défi');
  assert.equal(sequence[1].slice(0, 6), '082000', 'réponse au défi');
  assert.equal(sequence[1].length, 70, '35 octets = 70 caractères hexadécimaux');
  assert.equal(sequence[2], '010000');
  assert.equal(sequence[3], '020000');
  assert.equal(sequence[4], '80010000', 'réveil');
  assert.equal(sequence.length, 5, 'aucune écriture superflue');

  assert.deepEqual(link.errors, [], 'le robot simulé ne doit signaler aucune erreur de protocole');
  assert.ok(link.authenticated);
  assert.equal(result.serial, 'NOVA01234567');
  assert.equal(result.firmware, 'V0130.0.5-30.0.6');
});

test('l’empreinte envoyée est bien le MD5 attendu par le robot', async () => {
  const { link } = await authenticatedSession({ serial: 'O38240700268', code: 'ZZ99' });
  const sent = link.writes[1].subarray(3).toString('ascii');
  assert.equal(sent, computeAuthHash('O38240700268', 'ZZ99'));
  assert.match(sent, /^[0-9a-f]{32}$/);
});

test('l’authentification échoue si l’empreinte est fausse', async () => {
  // On corrompt la table de sel côté client en interceptant l'écriture.
  const link = new FakeRobotLink();
  const session = new NovaSession({ link, logger: silentLogger, timeouts: { notificationMs: 300 } });
  const originalWrite = link.write.bind(link);
  link.write = async (bytes) => {
    const buf = Buffer.from(bytes);
    if (buf.length === 35 && buf[0] === 0x08) buf.write('0'.repeat(32), 3, 'ascii');
    return originalWrite(buf);
  };

  await assert.rejects(() => session.authenticate(), /déconnecté|Délai dépassé/);
  assert.ok(link.errors.some((e) => /empreinte incorrecte/.test(e)), 'le robot doit avoir détecté la mauvaise empreinte');
  assert.equal(session.authenticated, false);
});

test('une session non authentifiée refuse d’envoyer un exercice', async () => {
  const link = new FakeRobotLink();
  const session = new NovaSession({ link, logger: silentLogger });
  await assert.rejects(() => session.sendDrill(drillOf()), /non authentifiée/);
});

test('le firmware est exposé et émis après authentification', async () => {
  const link = new FakeRobotLink({ firmware: 'V0200.1.2-99.9.9' });
  const session = new NovaSession({ link, logger: silentLogger, timeouts: { standbyMs: 500 } });
  const seen = [];
  session.on('firmware', (v) => seen.push(v));
  await session.authenticate();
  assert.deepEqual(seen, ['V0200.1.2-99.9.9']);
  assert.equal(session.firmware, 'V0200.1.2-99.9.9');
  assert.equal(session.state, 'STANDBY');
});

test('l’authentification tolère l’absence des transitions d’état finales', async () => {
  // Certains firmwares ne renvoient qu'une seule transition après le réveil.
  const link = new FakeRobotLink();
  const originalReact = link._react.bind(link);
  link._react = (buf) => {
    if (buf.toString('hex') === '80010000') {
      link.authenticated = true;
      link._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x02, 0x01, 0x00]));
      return; // on omet volontairement la seconde
    }
    originalReact(buf);
  };
  const session = new NovaSession({ link, logger: silentLogger, timeouts: { standbyMs: 60 } });
  await assert.doesNotReject(() => session.authenticate());
  assert.equal(session.authenticated, true);
});

/* -------------------------------------------------------------------------- */
/* Envoi d'exercices                                                          */
/* -------------------------------------------------------------------------- */

test('sendDrill transmet exactement le paquet encodé par protocol.js', async () => {
  const { link, session } = await authenticatedSession();
  const drill = drillOf(
    { speed: 9, spin: 2, height: 50, dropPoint: -6, frequency: 70, reps: 1 },
    { speed: 9, spin: 2, height: 50, dropPoint: 0, frequency: 70, reps: 1 },
    { speed: 9, spin: 2, height: 50, dropPoint: 6, frequency: 70, reps: 1 },
  );

  const out = await session.sendDrill(drill);

  assert.equal(link.drillPackets.length, 1);
  assert.deepEqual(link.drillPackets[0], packDrill(drill));
  assert.deepEqual(link.drillPackets[0], packDrill(drill));
  assert.equal(out.bytes, 7 + 3 * 24);
  assert.equal(session.drilling, true);
  assert.deepEqual(link.errors, []);
});

test('sendDrill avec modify produit un paquet 0x84', async () => {
  const { link, session } = await authenticatedSession();
  await session.sendDrill(drillOf(), { modify: true });
  assert.equal(link.drillPackets[0][0], 0x84);
});

test('un exercice refusé par le robot est signalé', async () => {
  const { session } = await authenticatedSession({ rejectDrills: true });
  const rejected = new Promise((resolve) => session.once('rejected', resolve));
  await session.sendDrill(drillOf());
  await rejected;
  assert.equal(session.drilling, false, 'un refus doit remettre l’état « en cours » à faux');
});

/* -------------------------------------------------------------------------- */
/* Arrêt, pause, reprise                                                      */
/* -------------------------------------------------------------------------- */

test('stopDrill confirme l’arrêt d’un exercice en cours', async () => {
  const { link, session } = await authenticatedSession();
  await session.sendDrill(drillOf());
  assert.equal(link.drilling, true);

  const result = await session.stopDrill();
  assert.equal(result.status, 'arrêté');
  assert.equal(link.drilling, false);
  assert.equal(link.writes.at(-1).toString('hex'), '80010001');
});

test('stopDrill distingue « déjà arrêté »', async () => {
  const { session } = await authenticatedSession();
  const result = await session.stopDrill();
  assert.equal(result.status, 'déjà arrêté');
});

test('stopDrill reste utile si le robot n’accuse pas réception', async () => {
  const link = new FakeRobotLink();
  const originalReact = link._react.bind(link);
  link._react = (buf) => {
    if (buf.toString('hex') === '80010001') return; // silence total
    originalReact(buf);
  };
  const session = new NovaSession({ link, logger: silentLogger, timeouts: { standbyMs: 500, stopAckMs: 80 } });
  await session.authenticate();
  const result = await session.stopDrill();
  assert.equal(result.status, 'arrêté');
  assert.match(result.detail, /sans accusé/);
});

test('pause et reprise changent l’état', async () => {
  const { session } = await authenticatedSession();
  assert.deepEqual(await session.pauseDrill(), { status: 'en pause' });
  assert.equal(session.state, 'PAUSED');
  assert.deepEqual(await session.resumeDrill(), { status: 'reprise' });
  assert.equal(session.state, 'ACTIVE');
});

/* -------------------------------------------------------------------------- */
/* Notifications et keepalive                                                 */
/* -------------------------------------------------------------------------- */

test('les notifications d’état et de progression sont décodées et émises', async () => {
  const { link, session } = await authenticatedSession();
  const states = [];
  const progress = [];
  session.on('state', (s) => states.push(s));
  session.on('progress', (p) => progress.push(p));

  link._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x04, 0x01, 0x00]));
  link._notify(Buffer.concat([
    Buffer.from([0x00, 0x05, 0x07, 0x00]),
    Buffer.from([0x0c, 0x00, 0x03, 0x00, 0x01, 0x00, 0x02]),
  ]));
  link._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x05, 0x01, 0x00]));

  assert.deepEqual(states, ['ACTIVE', 'DRILL_COMPLETE']);
  assert.deepEqual(progress, [{ totalShots: 12, ballIndex: 3, sequence: 1, cycle: 2 }]);
  assert.equal(session.drilling, false, 'la fin d’exercice remet le drapeau à faux');
});

test('un accusé de keepalive ne satisfait pas une attente de commande', async () => {
  const { link, session } = await authenticatedSession();
  // On envoie un accusé de keepalive, puis la vraie réponse d'arrêt.
  link._notify(NOTIFY_KEEPALIVE_ACK);
  link._notify(Buffer.from([0x00, 0x80, 0x00, 0x00]));
  const result = await session.stopDrill();
  assert.equal(result.status, 'arrêté');
});

test('le keepalive envoie 83 06 00 et se réarme sur accusé', async () => {
  const { link, session } = await authenticatedSession();
  session.startKeepalive(30);
  await new Promise((r) => setTimeout(r, 120));
  session.stopKeepalive();

  const keepalives = link.writes.filter((w) => w.toString('hex') === '830600');
  assert.ok(keepalives.length >= 2, `keepalives envoyés : ${keepalives.length}`);
  // Le robot simulé acquitte : le compteur d'échecs doit rester à zéro.
  assert.equal(session._keepaliveMissed ?? 0, 0);
});

test('le keepalive ne s’émet pas pendant un exercice', async () => {
  const { link, session } = await authenticatedSession();
  await session.sendDrill(drillOf());
  session.startKeepalive(20);
  await new Promise((r) => setTimeout(r, 100));
  session.stopKeepalive();
  assert.equal(link.writes.filter((w) => w.toString('hex') === '830600').length, 0);
});

test('trois keepalives sans accusé déclarent la liaison perdue', async () => {
  const link = new FakeRobotLink();
  const originalReact = link._react.bind(link);
  link._react = (buf) => {
    if (buf.toString('hex') === '830600') return; // aucun accusé
    originalReact(buf);
  };
  const session = new NovaSession({ link, logger: silentLogger, timeouts: { standbyMs: 500 } });
  await session.authenticate();

  const stale = new Promise((resolve) => session.once('stale', resolve));
  session.startKeepalive(15);
  await withTimeout(stale, 1000, 'l’événement « stale »');
  session.stopKeepalive();
  assert.equal(session._keepaliveTimer ?? null, null);
});

/* -------------------------------------------------------------------------- */
/* Déconnexion                                                                */
/* -------------------------------------------------------------------------- */

test('une déconnexion libère les attentes et remet l’état à zéro', async () => {
  const { link, session } = await authenticatedSession();
  session.startKeepalive(1000);

  const pending = session.nextNotification(5000, { label: 'un événement qui ne viendra jamais' });
  const disconnected = new Promise((resolve) => session.once('disconnected', resolve));
  link.emitDisconnect();

  await assert.rejects(() => pending, /déconnecté/);
  await disconnected;
  assert.equal(session.authenticated, false);
  assert.equal(session.state, 'DISCONNECTED');
  assert.equal(session.drilling, false);
});

test('close ferme le lien et interdit les envois', async () => {
  const { link, session } = await authenticatedSession();
  await session.close();
  assert.equal(link.closed, true);
  assert.equal(session.authenticated, false);
  await assert.rejects(() => session.sendDrill(drillOf()), /non authentifiée/);
});

/* -------------------------------------------------------------------------- */
/* Cohérence des UUID                                                         */
/* -------------------------------------------------------------------------- */

test('les UUID GATT correspondent à ceux documentés', () => {
  assert.equal(BLE.service, '02f00000-0000-0000-0000-00000000fe00');
  assert.equal(BLE.write, '02f00000-0000-0000-0000-00000000ff01');
  assert.equal(BLE.notify, '02f00000-0000-0000-0000-00000000ff02');
});
