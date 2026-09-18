/**
 * Tests du socket de contrôle local.
 *
 * C'est lui qui permet à `nova stop` de piloter un exercice lancé depuis un
 * autre terminal. Il doit surtout se fermer VITE et sans condition : un
 * `server.close()` qui attend une connexion restée ouverte bloquait la sortie du
 * programme sur Ctrl-C.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';

import {
  CONTROL_COMMANDS,
  controlSocketPath,
  sendControlCommand,
  startControlServer,
} from '../src/control-socket.js';
import { PROJECT_ROOT } from '../src/config.js';

const tmpRoot = join(PROJECT_ROOT, '.tmp-tests');
let dataDir;

before(() => {
  mkdirSync(tmpRoot, { recursive: true });
  dataDir = mkdtempSync(join(tmpRoot, 'sock-'));
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Petit serveur d'essai qui répond ce qu'on lui demande. */
async function withServer(handler, fn) {
  const server = await startControlServer({ dataDir, onCommand: handler, logger: { debug: () => {} } });
  try {
    return await fn(server);
  } finally {
    await server.close().catch(() => {});
  }
}

test('une commande reçoit sa réponse', async () => {
  await withServer(
    async (command) => ({ status: `reçu:${command}`, detail: 'ok' }),
    async (server) => {
      const reply = await sendControlCommand(dataDir, 'stop');
      assert.deepEqual(reply, { ok: true, status: 'reçu:stop', detail: 'ok' });
      assert.equal(server.path, controlSocketPath(dataDir));
    },
  );
});

test('les quatre commandes attendues passent', async () => {
  assert.deepEqual([...CONTROL_COMMANDS].sort(), ['pause', 'resume', 'status', 'stop']);
  await withServer(
    async (command) => ({ status: command }),
    async () => {
      for (const command of CONTROL_COMMANDS) {
        const reply = await sendControlCommand(dataDir, command);
        assert.equal(reply.status, command, `la commande ${command} doit passer`);
      }
    },
  );
});

test('une commande qui échoue revient en erreur, pas en silence', async () => {
  await withServer(
    async () => { throw new Error('le robot ne répond pas'); },
    async () => {
      const reply = await sendControlCommand(dataDir, 'stop');
      assert.equal(reply.ok, false);
      assert.match(reply.error, /le robot ne répond pas/);
    },
  );
});

test('sans serveur, sendControlCommand renvoie null au lieu d’échouer', async () => {
  const autre = mkdtempSync(join(tmpRoot, 'sock-vide-'));
  try {
    assert.equal(await sendControlCommand(autre, 'stop'), null);
  } finally {
    rmSync(autre, { recursive: true, force: true });
  }
});

test('close() retire le fichier de socket', async () => {
  const server = await startControlServer({ dataDir, onCommand: async () => ({ status: 'ok' }) });
  assert.ok(existsSync(server.path), 'le socket doit exister pendant l’écoute');
  await server.close();
  assert.equal(existsSync(server.path), false, 'le socket doit disparaître à la fermeture');
});

test('close() rend la main même si un client est resté connecté', async () => {
  // Régression : `server.close()` attend que toutes les connexions se terminent.
  // Un client resté ouvert empêchait le programme de sortir sur Ctrl-C, ce qui
  // obligeait l'utilisateur à appuyer une seconde fois.
  await withServer(
    async () => ({ status: 'ok' }),
    async (server) => {
      const stuck = connect(server.path);
      await new Promise((resolve, reject) => {
        stuck.once('connect', resolve);
        stuck.once('error', reject);
      });

      const started = Date.now();
      await server.close();
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 1500, `la fermeture a pris ${elapsed} ms : elle doit être bornée`);
      assert.equal(existsSync(server.path), false);
      stuck.destroy();
    },
  );
});

test('un socket laissé par un processus mort est repris sans erreur', async () => {
  // On simule un socket orphelin en écoutant puis en fermant brutalement.
  const first = await startControlServer({ dataDir, onCommand: async () => ({ status: 'un' }) });
  const path = first.path;
  // On ferme le serveur sans passer par close(), comme un kill -9.
  await new Promise((resolve) => first.close().then(resolve));

  const second = await startControlServer({ dataDir, onCommand: async () => ({ status: 'deux' }) });
  try {
    assert.equal(second.path, path);
    const reply = await sendControlCommand(dataDir, 'status');
    assert.equal(reply.status, 'deux', 'le second serveur doit répondre');
  } finally {
    await second.close();
  }
});
