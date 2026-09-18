/**
 * Robot simulé pour les tests.
 *
 * Il implémente l'interface `Link` attendue par `NovaSession` et joue le rôle
 * du firmware : il répond aux commandes, et surtout il VÉRIFIE l'empreinte MD5
 * que le client lui envoie. Une erreur d'authentification fait donc échouer les
 * tests au lieu de passer inaperçue.
 */

import { computeAuthHash, NOTIFY_KEEPALIVE_ACK } from '../../src/auth.js';

export class FakeRobotLink {
  /** @param {object} [options] @param {string} [options.serial] @param {string} [options.code] */
  constructor({ serial = 'NOVA01234567', code = 'a1b2c3d4', firmware = 'V0130.0.5-30.0.6', rejectDrills = false } = {}) {
    this.serial = serial;
    this.code = code;
    this.firmware = firmware;
    this.rejectDrills = rejectDrills;

    /** Toutes les écritures reçues, dans l'ordre. */
    this.writes = [];
    /** Erreurs de protocole détectées côté « robot ». */
    this.errors = [];
    this.authenticated = false;
    this.closed = false;
    this.drillPackets = [];

    this._handler = null;
    this._disconnectHandler = null;
  }

  onNotification(handler) { this._handler = handler; }
  onDisconnect(handler) { this._disconnectHandler = handler; }

  async write(bytes) {
    const buf = Buffer.from(bytes);
    this.writes.push(buf);
    // Le vrai robot répond de façon asynchrone ; on reproduit ce comportement
    // pour ne pas masquer un éventuel problème d'ordre.
    queueMicrotask(() => this._react(buf));
  }

  async close() { this.closed = true; }

  /** Simule une déconnexion côté robot. */
  emitDisconnect() { this._disconnectHandler?.(); }

  _notify(buf) { this._handler?.(Buffer.from(buf)); }

  /** Fabrique la notification de défi : 6 octets d'en-tête + série + code. */
  _challenge() {
    return Buffer.concat([
      Buffer.from([0x00, 0x02, 0x03, 0x00, 0x01, 0x00]),
      Buffer.from(this.serial, 'utf8'),
      Buffer.from(this.code, 'utf8'),
    ]);
  }

  _react(buf) {
    const hex = buf.toString('hex');

    // 1. Demande de défi
    if (hex === '07000000') {
      if (this.authenticated) this.errors.push('nouvelle demande de défi alors que déjà authentifié');
      this._notify(this._challenge());
      return;
    }

    // 2. Réponse au défi — c'est ici que l'empreinte est contrôlée.
    if (buf.length === 35 && buf[0] === 0x08 && buf[1] === 0x20 && buf[2] === 0x00) {
      const got = buf.subarray(3).toString('ascii');
      const expected = computeAuthHash(this.serial, this.code);
      if (got !== expected) {
        this.errors.push(`empreinte incorrecte : reçu ${got}, attendu ${expected}`);
        // Le vrai robot couperait la connexion.
        this.emitDisconnect();
        return;
      }
      this._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x01, 0x01, 0x00]));
      return;
    }

    // 3. Acquittement 1/3
    if (hex === '010000') {
      this._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x01, 0x02, 0x00]));
      return;
    }

    // 4. Acquittement 2/3 — transporte la version de firmware
    if (hex === '020000') {
      this._notify(Buffer.concat([
        Buffer.from([0x00, 0x02, 0x03, 0x00, 0x01, 0x03, 0x00, 0x00]),
        Buffer.from(this.firmware, 'ascii'),
        Buffer.from([0x00]),
      ]));
      return;
    }

    // 5. Réveil → deux transitions d'état, puis le robot est prêt
    if (hex === '80010000') {
      this.authenticated = true;
      this._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x02, 0x01, 0x00]));
      this._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x03, 0x01, 0x00]));
      return;
    }

    // 6. Arrêt
    if (hex === '80010001') {
      // Le robot répond 01 80 00 00 s'il était déjà à l'arrêt.
      this._notify(this.drilling ? Buffer.from([0x00, 0x80, 0x00, 0x00]) : Buffer.from([0x01, 0x80, 0x00, 0x00]));
      this.drilling = false;
      return;
    }

    // 7. Pause / reprise
    if (hex === '80010002') {
      this.drilling = false;
      this._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x06, 0x01, 0x00]));
      return;
    }
    if (hex === '80010003') {
      this.drilling = true;
      this._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x04, 0x01, 0x00]));
      return;
    }

    // 8. Keepalive
    if (hex === '830600') {
      this._notify(NOTIFY_KEEPALIVE_ACK);
      return;
    }

    // 9. Exercice (0x81 ou 0x84)
    if (buf[0] === 0x81 || buf[0] === 0x84) {
      if (!this.authenticated) {
        this.errors.push('exercice reçu avant authentification');
        return;
      }
      if (this.rejectDrills) {
        this._notify(Buffer.from([0x01, 0x81, 0x00, 0x00]));
        return;
      }
      this.drillPackets.push(buf);
      this.drilling = true;
      this._notify(Buffer.from([0x00, 0x02, 0x03, 0x00, 0x04, 0x01, 0x00]));
      return;
    }

    this.errors.push(`commande inconnue : ${hex}`);
  }
}

/** Journal silencieux pour les tests. */
export const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
