/**
 * Socket de contrôle local.
 *
 * Le Bluetooth Low Energy n'accepte qu'un seul maître à la fois. Quand
 * `nova send` garde la connexion ouverte pendant que l'exercice tourne, une
 * autre invocation de `nova` ne peut donc pas se connecter au robot pour
 * l'arrêter. On résout le problème avec un socket Unix : le processus qui
 * détient la liaison écoute les commandes, et `nova stop` les lui transmet.
 */

import { createServer, connect } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export const CONTROL_COMMANDS = ['stop', 'pause', 'resume', 'status'];

/** Chemin du socket pour un dossier de données donné. */
export const controlSocketPath = (dataDir) => join(dataDir, 'robot.sock');

/**
 * Ouvre le socket d'écoute.
 *
 * @param {object} options
 * @param {string} options.dataDir
 * @param {(command: string) => Promise<object>} options.onCommand
 * @returns {Promise<{path: string, close: () => Promise<void>}>}
 */
export async function startControlServer({ dataDir, onCommand, logger = console }) {
  const path = controlSocketPath(dataDir);

  // Un socket laissé par un processus mort empêcherait l'écoute.
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch (err) {
      throw new Error(`Impossible de libérer l’ancien socket ${path} : ${err.message}`);
    }
  }

  // On garde une trace des connexions : `server.close()` attend que TOUTES se
  // terminent, et un client resté ouvert bloquerait la sortie du programme.
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const command = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      Promise.resolve(onCommand(command))
        .then((reply) => socket.end(JSON.stringify({ ok: true, ...reply }) + '\n'))
        .catch((err) => socket.end(JSON.stringify({ ok: false, error: err.message }) + '\n'));
    });
    socket.on('error', () => { /* le client a raccroché : rien à signaler */ });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });

  logger.debug?.(`Socket de contrôle à l’écoute : ${path}`);

  return {
    path,
    async close() {
      // On coupe d'abord les connexions en cours, sinon `server.close()` ne
      // rend jamais la main.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => {
        server.close(resolve);
        // Ceinture et bretelles : si la fermeture traîne, on n'attend pas.
        setTimeout(resolve, 500).unref?.();
      });
      if (existsSync(path)) {
        try { unlinkSync(path); } catch { /* déjà retiré */ }
      }
    },
  };
}

/**
 * Envoie une commande au processus qui détient la liaison.
 * Renvoie `null` si personne n'écoute.
 */
export async function sendControlCommand(dataDir, command, { timeoutMs = 3000 } = {}) {
  const path = controlSocketPath(dataDir);
  if (!existsSync(path)) return null;

  return await new Promise((resolve, reject) => {
    const socket = connect(path);
    let data = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Le processus qui pilote le robot n’a pas répondu en ${timeoutMs} ms.`));
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(command + '\n'));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(data.trim()));
      } catch {
        reject(new Error(`Réponse illisible du socket de contrôle : ${data.slice(0, 200)}`));
      }
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      // Le socket existe mais personne n'écoute : traité comme « aucun pilote ».
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') resolve(null);
      else reject(err);
    });
  });
}
