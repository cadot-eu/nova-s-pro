/**
 * Transport Bluetooth Low Energy vers le Pongbot Nova S Pro.
 *
 * Le module est découpé en trois couches, pour que la logique protocolaire soit
 * vérifiable sans robot :
 *
 *   Link         interface minimale d'un canal BLE : écrire des octets, recevoir
 *                des notifications, fermer. Deux implémentations : BleLink
 *                (node-ble / BlueZ) et les liens factices des tests.
 *   NovaSession  la logique : poignée de main d'authentification, envoi
 *                d'exercices, arrêt, pause, keepalive, suivi d'état.
 *   NovaRobot    la façade : scan, connexion, et les commandes de haut niveau.
 *
 * `NovaSession` ne connaît que l'interface `Link` : on peut donc lui donner un
 * lien simulé et vérifier la séquence d'authentification octet par octet.
 */

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import {
  buildAuthResponse,
  computeAuthHash,
  extractFirmwareVersion,
  parseChallenge,
  parseProgressNotification,
  parseStateNotification,
  CMD_ACK1,
  CMD_ACK2,
  CMD_CHALLENGE,
  CMD_KEEPALIVE,
  CMD_PAUSE,
  CMD_RESUME,
  CMD_STOP,
  CMD_WAKEUP,
  NOTIFY_ALREADY_STOPPED,
  NOTIFY_DRILL_REJECTED,
  NOTIFY_DONE_HEX,
  NOTIFY_KEEPALIVE_ACK,
} from './auth.js';
import { packDrill } from './protocol.js';

/* -------------------------------------------------------------------------- */
/* Identifiants GATT                                                          */
/* -------------------------------------------------------------------------- */

export const BLE = Object.freeze({
  service: '02f00000-0000-0000-0000-00000000fe00',
  write:   '02f00000-0000-0000-0000-00000000ff01',
  notify:  '02f00000-0000-0000-0000-00000000ff02',
  read1:   '02f00000-0000-0000-0000-00000000ff00',
  read2:   '02f00000-0000-0000-0000-00000000ff03',
  /** UUID court annoncé par le robot ; sert à le repérer sans se fier au nom. */
  advertisedShort: 'feff',
  advertisedLong: '0000feff-0000-1000-8000-00805f9b34fb',
});

const DEFAULT_TIMEOUTS = {
  notificationMs: 5000,
  standbyMs: 4000,
  stopAckMs: 2000,
};

/* -------------------------------------------------------------------------- */
/* Liens                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Implémentation node-ble (BlueZ / D-Bus, Linux uniquement).
 * `bluetooth` est injectable pour les tests.
 */
export class BleLink {
  #device = null;
  #writeChar = null;
  #notifyChar = null;
  #handler = null;
  #destroy = null;
  #disconnectListeners = new Set();

  constructor({ bluetooth = null, destroy = null } = {}) {
    this._bluetooth = bluetooth;
    this._destroy = destroy;
  }

  /** Initialise la session D-Bus si elle ne l'est pas déjà. */
  static async create() {
    const require = createRequire(import.meta.url);
    let createBluetooth;
    try {
      ({ createBluetooth } = require('node-ble'));
    } catch (err) {
      throw new Error(
        `La bibliothèque « node-ble » est introuvable (${err.message}). ` +
          'Lance `npm install` à la racine du projet.',
      );
    }
    const { bluetooth, destroy } = createBluetooth();
    return new BleLink({ bluetooth, destroy });
  }

  get bluetooth() {
    if (!this._bluetooth) throw new Error('Session Bluetooth non initialisée.');
    return this._bluetooth;
  }

  async connect(address, { timeoutMs = 20000 } = {}) {
    const adapter = await this.bluetooth.defaultAdapter();
    if (!(await adapter.isPowered())) {
      throw new Error(
        'L’adaptateur Bluetooth est éteint. Active-le : `bluetoothctl power on` ' +
          '(ou `rfkill unblock bluetooth`).',
      );
    }

    try {
      this.#device = await adapter.getDevice(address);
    } catch (err) {
      // BlueZ ne connaît pas cette adresse : « Device not found ». On le dit en
      // français, avec la cause probable, plutôt que de laisser passer le code
      // brut de la bibliothèque.
      throw new Error(
        `Le robot n’est pas joignable à l’adresse ${address}. Vérifie qu’il est allumé, `
        + `à moins de 10 m, et qu’il n’est pas déjà connecté à l’application officielle. `
        + `(détail : ${err.message})`,
      );
    }
    this.#device.on('disconnect', () => {
      for (const fn of this.#disconnectListeners) {
        try { fn(); } catch { /* un écouteur défaillant ne doit rien casser */ }
      }
    });

    await withTimeout(this.#device.connect(), timeoutMs, `connexion à ${address}`);

    const gatt = await this.#device.gatt();
    const service = await gatt.getPrimaryService(BLE.service);
    this.#writeChar = await service.getCharacteristic(BLE.write);
    this.#notifyChar = await service.getCharacteristic(BLE.notify);

    this.#notifyChar.on('valuechanged', (buffer) => {
      // node-ble remet un Buffer ; on normalise en copie pour éviter les
      // surprises si BlueZ réutilise la mémoire sous-jacente.
      if (this.#handler) this.#handler(Buffer.from(buffer));
    });
    await this.#notifyChar.startNotifications();
  }

  onNotification(handler) {
    this.#handler = handler;
  }

  onDisconnect(handler) {
    this.#disconnectListeners.add(handler);
  }

  /** Écrit avec réponse : c'est ce qu'utilisent les deux clients de référence. */
  async write(bytes) {
    if (!this.#writeChar) throw new Error('Caractéristique d’écriture indisponible (non connecté ?).');
    try {
      await this.#writeChar.writeValueWithResponse(Buffer.from(bytes));
    } catch (err) {
      throw new Error(`Écriture BLE refusée : ${err.message}`);
    }
  }

  async close() {
    try { await this.#notifyChar?.stopNotifications(); } catch { /* déjà déconnecté */ }
    try { await this.#device?.disconnect(); } catch { /* déjà déconnecté */ }
    this.#device = null;
    this.#writeChar = null;
    this.#notifyChar = null;
    try { this._destroy?.(); } catch { /* rien à faire */ }
  }
}

/** Enveloppe une promesse d'un délai maximum, avec un message clair. */
export function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Délai dépassé (${ms} ms) : ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* -------------------------------------------------------------------------- */
/* Session : authentification et commandes                                    */
/* -------------------------------------------------------------------------- */

/**
 * Pilote une session authentifiée sur un lien BLE.
 *
 * Événements émis :
 *   'notification' (Buffer)      toute notification reçue
 *   'state'        (string)      nouvel état du robot
 *   'progress'     (object)      progression de l'exercice
 *   'firmware'     (string)      version lue pendant l'authentification
 *   'disconnected' ()            le lien est tombé
 */
export class NovaSession extends EventEmitter {
  #waiters = [];
  #buffered = [];
  #keepaliveTimer = null;
  #keepaliveMissed = 0;
  #closed = false;

  constructor({ link, timeouts = {}, logger = console } = {}) {
    super();
    if (!link) throw new Error('NovaSession a besoin d’un lien BLE.');
    this.link = link;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts };
    this.log = logger;
    this.state = 'DISCONNECTED';
    this.firmware = null;
    this.drilling = false;
    this.authenticated = false;

    link.onNotification((buf) => this.#handleNotification(buf));
    link.onDisconnect?.(() => {
      this.authenticated = false;
      this.drilling = false;
      this.state = 'DISCONNECTED';
      this.stopKeepalive();
      // On libère les attentes en cours pour échouer vite, sans attendre le délai.
      this.#rejectAllWaiters(new Error('Le robot s’est déconnecté.'));
      this.emit('disconnected');
    });
  }

  /* ---------------------------------------------------------------- attente */

  /** Attend la prochaine notification, ou consomme la file tamponnée. */
  nextNotification(timeoutMs = this.timeouts.notificationMs, { label = 'notification' } = {}) {
    if (this.#buffered.length) return Promise.resolve(this.#buffered.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`Délai dépassé en attendant : ${label}`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  #resolveWaiter(buf) {
    const waiter = this.#waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(buf);
      return true;
    }
    return false;
  }

  #rejectAllWaiters(err) {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /* ------------------------------------------------------------ réception  */

  #handleNotification(buf) {
    this.emit('notification', buf);

    if (buf.equals(NOTIFY_KEEPALIVE_ACK)) {
      this.#keepaliveMissed = 0;
      // Un accusé de keepalive ne doit pas satisfaire une attente de commande.
      this.emit('keepalive-ack');
      return;
    }

    const state = parseStateNotification(buf);
    if (state) {
      this.state = state;
      if (state === 'DRILL_COMPLETE') {
        this.drilling = false;
        this.emit('drill-complete');
      }
      this.emit('state', state);
    }

    const progress = parseProgressNotification(buf);
    if (progress) this.emit('progress', progress);

    if (buf.includes(Buffer.from(NOTIFY_DONE_HEX, 'hex'))) {
      this.drilling = false;
      this.emit('drill-complete');
    }

    if (buf.equals(NOTIFY_DRILL_REJECTED)) {
      this.drilling = false;
      this.emit('rejected', buf);
    }

    if (!this.#resolveWaiter(buf)) {
      this.#buffered.push(buf);
      if (this.#buffered.length > 64) this.#buffered.shift();
    }
  }

  /* ------------------------------------------------------- authentification */

  /**
   * Exécute la poignée de main complète. À l'issue, le robot est en attente
   * (standby) et prêt à recevoir un exercice.
   */
  async authenticate({ notificationMs = this.timeouts.notificationMs } = {}) {
    this.#buffered = [];
    this.log.info?.('Authentification : demande du défi…');

    // 1. Demande du défi (numéro de série + code dynamique).
    await this.link.write(CMD_CHALLENGE);
    const challenge = await this.nextNotification(notificationMs, { label: 'le défi d’authentification' });
    const { serial, code } = parseChallenge(challenge);

    // 2. Réponse au défi.
    const hash = computeAuthHash(serial, code);
    this.log.debug?.(`Authentification : série ${serial}, empreinte ${hash}`);
    await this.link.write(buildAuthResponse(hash));
    await this.nextNotification(notificationMs, { label: 'l’accusé du défi' });

    // 3. Acquittement 1/3.
    await this.link.write(CMD_ACK1);
    await this.nextNotification(notificationMs, { label: 'l’acquittement 1/3' });

    // 4. Acquittement 2/3 — la réponse transporte la version du firmware.
    await this.link.write(CMD_ACK2);
    const authR3 = await this.nextNotification(notificationMs, { label: 'l’acquittement 2/3' });
    const firmware = extractFirmwareVersion(authR3);
    if (firmware) {
      this.firmware = firmware;
      this.emit('firmware', firmware);
      this.log.info?.(`Firmware du robot : ${firmware}`);
    }

    // 5. Réveil.
    await this.link.write(CMD_WAKEUP);

    // 6-7. Deux notifications de transition d'état. Elles sont tolérantes à
    // l'absence : selon le firmware, la seconde peut coïncider avec l'accusé du
    // premier exercice. On ne bloque donc pas dessus.
    for (const label of ['la transition 1/3', 'la transition 2/3']) {
      try {
        await this.nextNotification(this.timeouts.standbyMs, { label });
      } catch (err) {
        this.log.warn?.(`Transition d’état non reçue (${label}) : ${err.message}. On continue.`);
        break;
      }
    }

    this.authenticated = true;
    this.state = 'STANDBY';
    this.log.info?.('Authentification réussie : le robot est prêt.');
    return { serial, firmware };
  }

  /* ------------------------------------------------------------- commandes */

  /** Envoie un exercice. `modify` encode une modification de l'exercice en cours. */
  async sendDrill(drill, { modify = false } = {}) {
    if (!this.authenticated) throw new Error('Session non authentifiée : impossible d’envoyer un exercice.');
    const packet = packDrill(drill, { modify });
    this.drilling = true;
    this.log.info?.(
      `Envoi de l’exercice : ${drill.balls.length} balle(s), mode ${drill.mode}, ` +
        `${drill.random ? 'ordre aléatoire' : 'ordre fixe'}, ${packet.length} octets.`,
    );
    this.log.debug?.(`Octets : ${packet.toString('hex')}`);
    await this.link.write(packet);
    return { bytes: packet.length, hex: packet.toString('hex') };
  }

  /** Arrêt. Renvoie une description de ce qui s'est passé. */
  async stopDrill() {
    this.drilling = false;
    try {
      await this.link.write(CMD_STOP);
    } catch (err) {
      return { status: 'échec', detail: `écriture impossible : ${err.message}` };
    }
    try {
      const ack = await this.nextNotification(this.timeouts.stopAckMs, { label: 'l’accusé d’arrêt' });
      if (ack.subarray(0, 4).equals(NOTIFY_ALREADY_STOPPED)) {
        return { status: 'déjà arrêté', detail: 'le robot ne diffusait pas d’exercice' };
      }
      return { status: 'arrêté', detail: 'arrêt confirmé par le robot' };
    } catch {
      // Pas d'accusé : la commande est bien partie, le robot ne répond pas
      // toujours quand il était déjà à l'arrêt.
      return { status: 'arrêté', detail: 'commande envoyée, sans accusé de réception' };
    }
  }

  async pauseDrill() {
    await this.link.write(CMD_PAUSE);
    this.state = 'PAUSED';
    return { status: 'en pause' };
  }

  async resumeDrill() {
    await this.link.write(CMD_RESUME);
    this.state = 'ACTIVE';
    return { status: 'reprise' };
  }

  /* -------------------------------------------------------------- keepalive */

  startKeepalive(intervalMs = 10000) {
    this.stopKeepalive();
    this.#keepaliveMissed = 0;
    this.#keepaliveTimer = setInterval(async () => {
      if (this.#closed || !this.authenticated) return;
      if (this.drilling) return; // le robot n'attend pas de keepalive pendant un exercice
      try {
        await this.link.write(CMD_KEEPALIVE);
        this.#keepaliveMissed += 1;
        this.log.debug?.(`Keepalive envoyé (non acquittés : ${this.#keepaliveMissed}).`);
        if (this.#keepaliveMissed >= 3) {
          this.log.warn?.('Trois keepalives sans accusé : la liaison est considérée perdue.');
          this.stopKeepalive();
          this.emit('stale');
        }
      } catch (err) {
        this.#keepaliveMissed += 1;
        this.log.warn?.(`Échec du keepalive : ${err.message}`);
      }
    }, intervalMs);
    // Un timer ne doit pas empêcher le processus de se terminer.
    this.#keepaliveTimer.unref?.();
    return this;
  }

  stopKeepalive() {
    if (this.#keepaliveTimer) clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = null;
  }

  async close() {
    this.#closed = true;
    this.stopKeepalive();
    this.#rejectAllWaiters(new Error('Session fermée.'));
    await this.link.close();
    this.authenticated = false;
    this.state = 'DISCONNECTED';
  }
}

/* -------------------------------------------------------------------------- */
/* Découverte                                                                 */
/* -------------------------------------------------------------------------- */

/** Un appareil découvert correspond-il à un robot Nova ? */
export function looksLikeNova({ name = '', services = [] }, keywords = ['nova', 'pongbot']) {
  const lower = String(name).toLowerCase();
  if (keywords.some((k) => lower.includes(k))) return true;
  const normalised = services.map((s) => String(s).toLowerCase());
  return normalised.some((s) => s.includes(BLE.advertisedShort));
}

/** Extrait les UUID de service d'un dictionnaire d'annonce BlueZ. */
function servicesFromAdvertising(advertisingData) {
  if (!advertisingData || typeof advertisingData !== 'object') return [];
  const raw = advertisingData.Services ?? advertisingData.UUIDs ?? advertisingData.uuids ?? [];
  if (Array.isArray(raw)) return raw.map((s) => String(s));
  if (typeof raw === 'object') return Object.keys(raw);
  return [String(raw)];
}

/** Scanne les robots à proximité. */
export async function scanRobots({ link = null, timeoutMs = 12000, keywords = ['nova', 'pongbot'] } = {}) {
  const ble = link ?? (await BleLink.create());
  const ownsLink = !link;
  const adapter = await ble.bluetooth.defaultAdapter();

  if (!(await adapter.isPowered())) {
    throw new Error('L’adaptateur Bluetooth est éteint. Active-le : `bluetoothctl power on`.');
  }

  const alreadyDiscovering = await adapter.isDiscovering();
  if (!alreadyDiscovering) {
    try {
      await adapter.startDiscovery();
    } catch (err) {
      // BlueZ répond « Operation already in progress » quand un autre client
      // (bluetoothctl, une application, un scan précédent) explore déjà. Ce n'est
      // pas une erreur : on se contente de lire les appareils déjà connus.
      if (!/already in progress|InProgress/i.test(err.message)) throw err;
    }
  }

  const found = new Map();
  // On mémorise aussi les appareils déjà EXAMINÉS et rejetés. Sans cela, chaque
  // tour de boucle les réinterrogerait via BlueZ, ce qui accumule des écouteurs
  // D-Bus et déclenche un avertissement de fuite mémoire.
  const examined = new Set();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      for (const address of await adapter.devices()) {
        if (examined.has(address)) continue;
        examined.add(address);
        let info;
        try {
          const device = await adapter.getDevice(address);
          const [name, rssi, advertising] = await Promise.all([
            device.getAlias().catch(() => ''),
            device.getRSSI().catch(() => null),
            device.getAdvertisingData().catch(() => ({})),
          ]);
          info = { address, name, rssi, services: servicesFromAdvertising(advertising) };
        } catch {
          continue;
        }
        if (looksLikeNova(info, keywords)) {
          found.set(address, { address, name: info.name, rssi: info.rssi, services: info.services });
        }
      }
      if (Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    if (!alreadyDiscovering) await adapter.stopDiscovery().catch(() => {});
    if (ownsLink) await ble.close?.();
  }

  return [...found.values()];
}

/* -------------------------------------------------------------------------- */
/* Façade                                                                     */
/* -------------------------------------------------------------------------- */

/** Pilote de haut niveau : scan, connexion authentifiée, envoi, arrêt. */
export class NovaRobot extends EventEmitter {
  constructor({ config, logger = console, linkFactory = BleLink.create } = {}) {
    super();
    this.config = config;
    this.log = logger;
    this.linkFactory = linkFactory;
    this.link = null;
    this.session = null;
    this.address = null;
  }

  get connected() {
    return Boolean(this.session?.authenticated);
  }

  /** Scanne et renvoie les robots trouvés. */
  async scan({ timeoutMs = this.config?.robot?.scanTimeoutMs ?? 12000 } = {}) {
    const keywords = this.config?.robot?.nameKeywords ?? ['nova', 'pongbot'];
    return scanRobots({ timeoutMs, keywords });
  }

  /**
   * Se connecte et s'authentifie. Sans adresse, on scanne d'abord.
   */
  async connect({ address = null, scanIfNeeded = true } = {}) {
    if (this.connected) return { address: this.address, alreadyConnected: true };

    let target = address ?? this.config?.robot?.address ?? null;
    let issueDUneAdresseMemorisee = Boolean(target);

    if (!target && scanIfNeeded) {
      this.log.info?.('Recherche du robot…');
      const found = await this.scan();
      if (found.length === 0) {
        throw new Error(
          'Aucun robot Nova trouvé. Vérifie qu’il est allumé, à moins de 10 m, et qu’il n’est pas ' +
            'déjà connecté à l’application officielle sur un téléphone.',
        );
      }
      if (found.length > 1) {
        this.log.warn?.(
          `Plusieurs robots détectés (${found.map((f) => f.address).join(', ')}). ` +
            'Utilisation du premier ; précise l’adresse avec NOVA_ADDRESS ou --address.',
        );
      }
      target = found[0].address;
      issueDUneAdresseMemorisee = false;
      this.log.info?.(`Robot retenu : ${found[0].name || '(sans nom)'} [${target}]`);
    }
    if (!target) throw new Error('Aucune adresse fournie et aucun robot détecté.');

    // Si l'adresse mémorisée ne répond plus (robot déplacé, réappairé, adresse
    // aléatoire renouvelée), on retente par un scan plutôt que d'échouer sec :
    // c'est de loin la cause la plus fréquente.
    if (issueDUneAdresseMemorisee && scanIfNeeded) {
      try {
        return await this.#connecterEtAuthentifier(target);
      } catch (err) {
        this.log.warn?.(
          `Échec sur l’adresse mémorisée ${target} (${err.message}). Nouvelle recherche…`,
        );
        const found = await this.scan();
        const autre = found.find((f) => f.address.toLowerCase() !== target.toLowerCase()) ?? found[0];
        if (!autre) throw err;
        this.log.info?.(`Robot trouvé au scan : ${autre.name || '(sans nom)'} [${autre.address}]`);
        return await this.#connecterEtAuthentifier(autre.address);
      }
    }

    return await this.#connecterEtAuthentifier(target);
  }

  /**
   * Connexion + authentification sur une adresse précise, avec réessais.
   *
   * Les connexions BLE échouent souvent au premier essai (radio endormie,
   * cache BlueZ incomplet) : on retente quelques fois avant d'abandonner.
   */
  async #connecterEtAuthentifier(target, { maxRetries = 3, backoff = 2000 } = {}) {
    let derniereErreur = null;
    for (let tentative = 1; tentative <= maxRetries; tentative++) {
      try {
        return await this.#tenterConnexion(target);
      } catch (err) {
        derniereErreur = err;
        this.emit('attempt', { tentative, maxRetries, message: err.message });

        // Une adresse que BlueZ ne connaît pas ne deviendra pas connue en
        // réessayant : c'est un cas définitif, on passe tout de suite au scan.
        if (/n’est pas joignable|not found|Unknown device/i.test(err.message)) {
          this.log.warn?.(`Adresse ${target} inconnue de BlueZ : réessais inutiles, on passe au scan.`);
          break;
        }

        if (tentative < maxRetries) {
          this.log.warn?.(
            `Tentative ${tentative}/${maxRetries} échouée (${err.message}). Nouvel essai dans ${backoff / 1000} s…`,
          );
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    throw derniereErreur;
  }

  /** Une tentative : lien, connexion GATT, authentification, keepalive. */
  async #tenterConnexion(target) {
    const link = await this.linkFactory();
    this.link = link;
    this.address = target;

    await link.connect(target, { timeoutMs: this.config?.robot?.connectTimeoutMs ?? 20000 });
    this.log.info?.(`Connecté à ${target}.`);

    this.session = new NovaSession({
      link,
      timeouts: { notificationMs: 5000, standbyMs: 4000 },
      logger: this.log,
    });
    for (const event of ['state', 'progress', 'firmware', 'drill-complete', 'rejected', 'disconnected', 'stale']) {
      this.session.on(event, (payload) => this.emit(event, payload));
    }

    await this.session.authenticate();
    this.session.startKeepalive(this.config?.robot?.keepaliveMs ?? 10000);
    this.emit('connected', { address: target, firmware: this.session.firmware });
    return { address: target, firmware: this.session.firmware };
  }

  async sendDrill(drill, { modify = false } = {}) {
    if (!this.session) throw new Error('Non connecté. Lance d’abord une connexion.');
    return this.session.sendDrill(drill, { modify });
  }

  async stopDrill() {
    if (!this.session) throw new Error('Non connecté : rien à arrêter.');
    return this.session.stopDrill();
  }

  async pauseDrill() {
    if (!this.session) throw new Error('Non connecté.');
    return this.session.pauseDrill();
  }

  async resumeDrill() {
    if (!this.session) throw new Error('Non connecté.');
    return this.session.resumeDrill();
  }

  status() {
    return {
      connected: this.connected,
      address: this.address,
      state: this.session?.state ?? 'DISCONNECTED',
      firmware: this.session?.firmware ?? null,
      drilling: this.session?.drilling ?? false,
    };
  }

  async disconnect() {
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
    this.link = null;
    this.address = null;
  }
}
