/**
 * Tests de l'API HTTP de l'interface.
 *
 * On lance le vrai serveur sur un port éphémère et on lui parle en HTTP, avec un
 * répertoire de données isolé et un robot simulé : aucun matériel, aucun réseau.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { createNovaServer, decorateDrill, segmenterParPauses } from '../src/server.js';
import { getConfig, PROJECT_ROOT } from '../src/config.js';

const tmpRoot = join(PROJECT_ROOT, '.tmp-tests');
mkdirSync(tmpRoot, { recursive: true });

let app;
let base;
let dataDir;

/** Robot simulé : enregistre ce qu'on lui demande, sans Bluetooth. */
function fakeRobot() {
  const journal = [];
  const etat = { connected: false, address: null, state: 'DISCONNECTED', firmware: null, drilling: false };
  return {
    journal,
    get connected() { return etat.connected; },
    status: () => ({ ...etat }),
    async connect({ address } = {}) {
      etat.connected = true;
      etat.address = address ?? 'AA:BB:CC:DD:EE:FF';
      etat.firmware = 'V0130.0.5-30.0.6';
      journal.push({ action: 'connect', address: etat.address });
      return { address: etat.address, firmware: etat.firmware };
    },
    async disconnect() {
      etat.connected = false;
      journal.push({ action: 'disconnect' });
    },
    async sendDrill(drill, options) {
      journal.push({ action: 'send', balls: drill.balls.length, random: drill.random, ...options });
      etat.drilling = true;
      return { bytes: 7 + drill.balls.length * 24, hex: 'ab' };
    },
    async stopDrill() {
      journal.push({ action: 'stop' });
      etat.drilling = false;
      return { status: 'arrêté', detail: 'arrêt confirmé par le robot' };
    },
    async pauseDrill() { journal.push({ action: 'pause' }); return { status: 'en pause' }; },
    async resumeDrill() { journal.push({ action: 'resume' }); return { status: 'reprise' }; },
  };
}

let robot;

/** Requête JSON contre le serveur. */
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  const payload = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body: payload, type };
}

const BALLS = [
  { speed: 9, spin: 2, height: 50, dropPoint: -6, frequency: 70, reps: 1 },
  { speed: 9, spin: 2, height: 50, dropPoint: 0, frequency: 70, reps: 1 },
  { speed: 9, spin: 2, height: 50, dropPoint: 6, frequency: 70, reps: 1 },
];

before(async () => {
  dataDir = mkdtempSync(join(tmpRoot, 'srv-'));
  robot = fakeRobot();
  const config = { ...getConfig({}), dataDir };
  config.deepseek = { ...config.deepseek, apiKey: null };
  app = createNovaServer({
    config,
    logger: { info() {}, warn() {}, error() {} },
    // Un `fetch` factice pour la librairie en ligne, afin de rester hors réseau.
    fetchImpl: async (url, init = {}) => {
      if ((init.method ?? 'GET') === 'POST') {
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
      }
      // La vérification d'unicité d'un code interroge avec `fields=id` : on
      // répond « libre », sinon aucun code ne serait jamais disponible.
      if (url.includes('fields=id')) {
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      }
      const items = [{
        id: 'x', share_code: 'JOB857', created: '2025-12-08 13:09:00.568Z',
        drill_data: {
          level: 1, name: 'Partagé', random: false,
          params: [[[1547, 2915, 50, -5, 10, 1, 1]]],
        },
      }];
      return { ok: true, status: 200, json: async () => ({ items, totalItems: 1, page: 1, perPage: 20 }) };
    },
    robotFactory: () => robot,
  });
  base = await app.listen({ port: 0 });
});

after(async () => {
  await app?.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Fichiers statiques                                                         */
/* -------------------------------------------------------------------------- */

test('la page et ses ressources sont servies', async () => {
  const page = await call('/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /NovaKontrol/);

  for (const [chemin, type] of [['/app.js', /javascript/], ['/style.css', /css/], ['/lib/head.js', /javascript/]]) {
    const res = await call(chemin);
    assert.equal(res.status, 200, `${chemin} doit être servi`);
    assert.match(res.type, type, `${chemin} doit avoir le bon type`);
  }
});

test('le module de tête servi au navigateur est bien le vrai', async () => {
  const res = await call('/lib/head.js');
  assert.match(res.body, /export function effectiveSpin/);
  assert.match(res.body, /HEAD_ANGLE_RANGE/);
});

test('toute remontée de répertoire est bloquée', async () => {
  for (const chemin of ['/../.env', '/../../etc/passwd', '/..%2f.env']) {
    const res = await call(chemin);
    assert.ok(res.status === 404 || res.status === 403, `${chemin} → ${res.status} (attendu 403/404)`);
  }
});

test('seuls les modules explicitement autorisés sont servis', async () => {
  // Régression : un motif trop large exposait TOUT src/ au navigateur, code
  // serveur compris. La liste est désormais fermée.
  for (const nom of ['config.js', 'server.js', 'library.js', 'protocol.js', 'cloud.js', 'ble.js']) {
    const res = await call(`/lib/${nom}`);
    assert.equal(res.status, 403, `${nom} ne doit pas être exposé`);
  }
  assert.equal((await call('/lib/head.js')).status, 200, 'seul head.js est autorisé');
  assert.equal((await call('/lib/inexistant.js')).status, 403);
});

/* -------------------------------------------------------------------------- */
/* État et réglages                                                           */
/* -------------------------------------------------------------------------- */

test('l’état expose la tête, le robot et les constantes', async () => {
  const { status, body } = await call('/api/state');
  assert.equal(status, 200);
  assert.equal(body.head.angle, 0);
  assert.match(body.head.description, /tête droite/);
  assert.ok(body.head.presets.length >= 5);
  assert.equal(body.robot.connected, false);
  assert.equal(body.deepseekConfigured, false);
  assert.equal(body.constants.ranges.frequency.min, 30);
  assert.equal(body.constants.maxBalls, 20);
});

test('le placement du robot est exposé, mémorisé et borné', async () => {
  const etat = await call('/api/state');
  assert.equal(etat.body.setup.squares.length, 9, 'les neuf cases sont exposées');
  assert.equal(etat.body.setup.square, 1, 'robot au fond de sa moitié, au centre, par défaut');
  assert.equal(etat.body.setup.angle, 0, 'angle 0° par défaut');
  assert.match(etat.body.setup.description, /Fond de table · Centre/);

  const mis = await call('/api/settings', { method: 'PUT', body: { robotSquare: 8, robotAngle: 45 } });
  assert.equal(mis.body.setup.square, 8);
  assert.equal(mis.body.setup.angle, 45);
  assert.match(mis.body.setup.label, /Près du filet · Droite/);

  const borne = await call('/api/settings', { method: 'PUT', body: { robotSquare: 99, robotAngle: 900 } });
  assert.equal(borne.body.setup.square, 8);
  assert.equal(borne.body.setup.angle, 90);

  const relu = await call('/api/state');
  assert.equal(relu.body.setup.square, 8);

  await call('/api/settings', { method: 'PUT', body: { robotSquare: 1, robotAngle: 0 } });
});

test('le réglage de tête est mémorisé et borné', async () => {
  const mis = await call('/api/settings', { method: 'PUT', body: { headAngle: -90 } });
  assert.equal(mis.body.head.angle, -90);
  assert.match(mis.body.head.description, /90° vers la gauche/);

  const borne = await call('/api/settings', { method: 'PUT', body: { headAngle: 400 } });
  assert.equal(borne.body.head.angle, 90);

  const relu = await call('/api/state');
  assert.equal(relu.body.head.angle, 90);

  await call('/api/settings', { method: 'PUT', body: { headAngle: 0 } });
});

/* -------------------------------------------------------------------------- */
/* Bibliothèque                                                               */
/* -------------------------------------------------------------------------- */

test('créer, relire, modifier et supprimer un exercice', async () => {
  const cree = await call('/api/drills', {
    method: 'POST',
    body: { name: 'Exercice API', description: 'test', balls: BALLS, random: true },
  });
  assert.equal(cree.status, 200);
  const id = cree.body.drill.id;
  assert.equal(id, 'exercice-api');
  assert.equal(cree.body.drill.balls.length, 3);
  assert.equal(cree.body.drill.random, true);
  assert.equal(cree.body.drill.packetBytes, 79);

  const liste = await call('/api/drills');
  assert.equal(liste.body.count, 1);

  const lu = await call(`/api/drills/${id}`);
  assert.equal(lu.body.drill.name, 'Exercice API');

  const modifie = await call(`/api/drills/${id}`, {
    method: 'PUT',
    body: { name: 'Exercice API modifié', balls: [BALLS[0]] },
  });
  assert.equal(modifie.status, 200);
  assert.equal(modifie.body.drill.name, 'Exercice API modifié');
  assert.equal(modifie.body.drill.balls.length, 1, 'le remplacement est complet');

  const supprime = await call(`/api/drills/${id}`, { method: 'DELETE' });
  assert.equal(supprime.body.deleted, id);
  assert.equal((await call(`/api/drills/${id}`)).status, 404);
});

test('un exercice invalide est refusé en 400, pas en 500', async () => {
  for (const body of [{ balls: [] }, { balls: [{ speed: 'vite' }] }, { balls: BALLS, mode: 'sprint' }]) {
    const res = await call('/api/drills', { method: 'POST', body });
    assert.equal(res.status, 400, `corps ${JSON.stringify(body).slice(0, 40)} → ${res.status}`);
    assert.match(res.body.error, /invalide/i);
  }
});

test('un identifiant inconnu renvoie 404 avec des suggestions', async () => {
  await call('/api/drills', { method: 'POST', body: { name: 'Bloc contre topspin', balls: BALLS } });

  // Une recherche partielle qui ne trouve RIEN doit suggérer l'exercice proche.
  const res = await call('/api/drills/bloc-inexistant');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /introuvable/);
  assert.match(res.body.error, /bloc-contre-topspin/, 'l’identifiant proche est proposé');

  // Une correspondance partielle unique est, elle, acceptée.
  const partiel = await call('/api/drills/bloc');
  assert.equal(partiel.status, 200);
  assert.equal(partiel.body.drill.name, 'Bloc contre topspin');

  await call('/api/drills/bloc-contre-topspin', { method: 'DELETE' });
});

test('dupliquer un exercice crée une copie indépendante', async () => {
  const cree = await call('/api/drills', { method: 'POST', body: { name: 'Original', balls: BALLS } });
  const copie = await call(`/api/drills/${cree.body.drill.id}/duplicate`, { method: 'POST', body: {} });
  assert.equal(copie.status, 200);
  assert.match(copie.body.drill.name, /copie/);
  assert.notEqual(copie.body.drill.id, cree.body.drill.id);
  assert.equal(copie.body.drill.balls.length, 3);
});

test('une route inconnue renvoie 404 et une mauvaise méthode 405', async () => {
  assert.equal((await call('/api/bidule')).status, 404);
  assert.equal((await call('/api/state', { method: 'DELETE' })).status, 405);
});

/* -------------------------------------------------------------------------- */
/* La tête change l'interprétation, pas les octets                            */
/* -------------------------------------------------------------------------- */

test('l’exercice enregistre la position du robot et la rotation de tête', async () => {
  // Régression : ces deux réglages étaient globaux ; ils doivent être portés par
  // l'exercice, puisqu'il a été conçu avec eux.
  await call('/api/settings', { method: 'PUT', body: { headAngle: -90, robotSquare: 0, robotAngle: 30 } });

  const cree = await call('/api/drills', {
    method: 'POST',
    body: { name: 'Avec réglage', balls: BALLS },
  });
  assert.equal(cree.body.drill.headAngle, -90, 'la tête est enregistrée');
  assert.equal(cree.body.drill.robotSquare, 0, 'la case du robot est enregistrée');
  assert.equal(cree.body.drill.robotAngle, 30, 'l’angle du robot est enregistré');
  assert.match(cree.body.drill.placement.effect, /plus courtes/);

  // Changer le réglage global ne doit PAS changer l'exercice enregistré.
  await call('/api/settings', { method: 'PUT', body: { headAngle: 0, robotSquare: 8, robotAngle: 0 } });
  const relu = await call(`/api/drills/${cree.body.drill.id}`);
  assert.equal(relu.body.drill.headAngle, -90, 'l’exercice garde SA tête');
  assert.equal(relu.body.drill.robotSquare, 0, 'et SA position de robot');
  assert.equal(relu.body.drill.balls[0].color, 'blue', 'l’affichage suit la tête de l’exercice');

  await call(`/api/drills/${cree.body.drill.id}`, { method: 'DELETE' });
  await call('/api/settings', { method: 'PUT', body: { headAngle: 0, robotSquare: 1, robotAngle: 0 } });
});

test('bouger le robot change la position des balles', async () => {
  const cree = await call('/api/drills', { method: 'POST', body: { name: 'Placement', balls: BALLS } });
  const id = cree.body.drill.id;

  await call('/api/settings', { method: 'PUT', body: { robotSquare: 1 } });   // reculé centre
  const recule = (await call(`/api/drills/${id}`)).body.drill;

  await call('/api/settings', { method: 'PUT', body: { robotSquare: 8 } });   // sur la table, droite
  const avance = (await call(`/api/drills/${id}`)).body.drill;

  // L'exercice porte son propre placement : il faut le forcer pour comparer.
  assert.equal(recule.robotSquare, 1);
  assert.equal(avance.robotSquare, 1, 'l’exercice ne change pas quand le réglage global change');
  await call(`/api/drills/${id}`, { method: 'DELETE' });

  // En revanche, un exercice CONÇU avec un autre placement doit se dessiner autrement.
  await call('/api/settings', { method: 'PUT', body: { robotSquare: 1 } });
  await call('/api/drills', { method: 'POST', body: { name: 'Reculé', balls: BALLS } });
  await call('/api/settings', { method: 'PUT', body: { robotSquare: 8 } });
  await call('/api/drills', { method: 'POST', body: { name: 'Avancé', balls: BALLS } });

  const liste = (await call('/api/drills')).body.drills;
  const r = liste.find((d) => d.name === 'Reculé');
  const a = liste.find((d) => d.name === 'Avancé');
  assert.ok(a.balls[0].y > r.balls[0].y,
    `avancé (${a.balls[0].y} %) doit être plus profond que reculé (${r.balls[0].y} %)`);
  // Le décalage latéral de la colonne droite doit apparaître.
  assert.ok(a.balls[0].x > r.balls[0].x, 'et décalé vers la droite');

  for (const d of [r, a]) await call(`/api/drills/${d.id}`, { method: 'DELETE' });
  await call('/api/settings', { method: 'PUT', body: { robotSquare: 1 } });
});

test('tourner la tête change l’effet affiché SANS changer le paquet envoyé', async () => {
  const balle = { speed: 9, spin: 2, height: 50, dropPoint: -6, frequency: 70, reps: 1 };

  // La tête est portée par l'EXERCICE : on crée donc un exercice à tête droite,
  // puis on le réenregistre avec la tête tournée.
  await call('/api/settings', { method: 'PUT', body: { headAngle: 0 } });
  const cree = await call('/api/drills', { method: 'POST', body: { name: 'Tête', balls: [balle] } });
  const id = cree.body.drill.id;
  const droite = cree.body.drill;

  const tournee = (await call(`/api/drills/${id}`, {
    method: 'PUT',
    body: { name: 'Tête', balls: [balle], headAngle: -90 },
  })).body.drill;

  assert.equal(droite.headAngle, 0);
  assert.equal(droite.balls[0].color, 'green');
  assert.equal(droite.balls[0].effect, 'top-spin');

  assert.equal(tournee.headAngle, -90);
  assert.equal(tournee.balls[0].color, 'blue');
  assert.equal(tournee.balls[0].effect, 'effet latéral gauche');

  // Le robot ne reçoit AUCUN angle : les octets sont identiques.
  assert.equal(droite.packetHex, tournee.packetHex,
    'la rotation est physique, pas protocolaire : le paquet ne doit pas changer');
  assert.equal(droite.balls[0].spin, tournee.balls[0].spin);

  await call(`/api/drills/${id}`, { method: 'DELETE' });
  await call('/api/settings', { method: 'PUT', body: { headAngle: 0, robotSquare: 1, robotAngle: 0 } });
});

test('decorateDrill place les balles selon le placement latéral', () => {
  const record = {
    name: 'Géométrie', mode: 'endless', modeValue: 0, random: false,
    balls: [
      { speed: 5, spin: 0, height: 50, dropPoint: -10, frequency: 60, reps: 1, topRpm: 4123, bottomRpm: 4123 },
      { speed: 5, spin: 0, height: 50, dropPoint: 10, frequency: 60, reps: 1, topRpm: 4123, bottomRpm: 4123 },
    ],
  };
  const d = decorateDrill(record, 0);
  assert.equal(d.balls[0].x, 0, 'placement négatif (revers) → bord gauche du schéma');
  assert.equal(d.balls[1].x, 100, 'placement positif (coup droit) → bord droit');
  assert.equal(d.balls[0].y, d.balls[1].y, 'même vitesse et même hauteur → même profondeur estimée');
  assert.equal(d.balls[0].depthEstimated, true, 'la profondeur doit être annoncée comme estimée');
  // La profondeur dépend de l'effet : c'est ce que l'utilisateur a demandé.
  assert.ok(d.balls[0].flight, 'chaque balle porte sa trajectoire résumée');
  assert.ok(d.balls[0].flight.clearsNet !== undefined);
  assert.ok(d.balls[0].flight.flightTimeMs > 0);
});

test('changer l’effet change la profondeur, à vitesse et hauteur égales', () => {
  const base = {
    name: 'Effet', mode: 'endless', modeValue: 0, random: false,
    balls: [
      { speed: 5, spin: 8, height: 50, dropPoint: 0, frequency: 60, reps: 1, topRpm: 4000, bottomRpm: 4000 },
      { speed: 5, spin: -8, height: 50, dropPoint: 0, frequency: 60, reps: 1, topRpm: 4000, bottomRpm: 4000 },
    ],
  };
  const d = decorateDrill(base, 0);
  const [top, back] = d.balls;
  assert.ok(back.y > top.y, `le back-spin (${back.y} %) doit aller plus loin que le top-spin (${top.y} %)`);
  assert.ok(Math.abs(back.y - top.y) > 20, 'l’écart doit être net, pas cosmétique');
});

/* -------------------------------------------------------------------------- */
/* Robot simulé                                                               */
/* -------------------------------------------------------------------------- */

test('le cycle connexion → envoi → arrêt fonctionne', async () => {
  const cree = await call('/api/drills', { method: 'POST', body: { name: 'À envoyer', balls: BALLS, random: true } });

  assert.equal((await call('/api/robot/connect', { method: 'POST', body: {} })).status, 200);
  const statut = await call('/api/robot/status');
  assert.equal(statut.body.robot.connected, true);

  const envoi = await call('/api/robot/send', { method: 'POST', body: { id: cree.body.drill.id } });
  assert.equal(envoi.status, 200);
  assert.equal(envoi.body.sent, true);
  assert.equal(envoi.body.bytes, 79);
  const dernier = robot.journal.filter((j) => j.action === 'send').at(-1);
  assert.equal(dernier.balls, 3);
  assert.equal(dernier.random, true);

  const arret = await call('/api/robot/stop', { method: 'POST', body: {} });
  assert.equal(arret.body.status, 'arrêté');

  await call('/api/robot/disconnect', { method: 'POST', body: {} });
  assert.equal((await call('/api/robot/status')).body.robot.connected, false);
});

test('envoyer un brouillon non enregistré est possible', async () => {
  await call('/api/robot/connect', { method: 'POST', body: {} });
  const res = await call('/api/robot/send', { method: 'POST', body: { balls: BALLS } });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Brouillon');
  await call('/api/robot/disconnect', { method: 'POST', body: {} });
});

test('envoyer un brouillon invalide renvoie 400', async () => {
  const res = await call('/api/robot/send', { method: 'POST', body: { balls: [] } });
  assert.equal(res.status, 400);
});

/* -------------------------------------------------------------------------- */
/* Recalcul à la volée (l'écran ne doit jamais mentir)                         */
/* -------------------------------------------------------------------------- */

test('/api/normalize renvoie les valeurs réellement jouables', async () => {
  const res = await call('/api/normalize', {
    method: 'POST',
    body: { balls: [balle(0, { speed: 8.5, spin: 3 })] },
  });
  assert.equal(res.status, 200);
  // 8,5 / 3 demanderait 7355 tr/min : la roue plafonne à 7200.
  assert.equal(res.body.balls[0].speed, 8.5);
  assert.equal(res.body.balls[0].spin, 2.5);
  assert.equal(res.body.balls[0].topRpm, 7184);
  assert.ok(res.body.adjustments.some((a) => /effet : 3 → 2\.5/.test(a)));
});

test('/api/normalize bloque la vitesse quand les roues ne suivent pas', async () => {
  const res = await call('/api/normalize', {
    method: 'POST',
    body: { balls: [balle(0, { speed: 10, spin: 0 })] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.balls[0].speed, 9.5);
  assert.equal(res.body.balls[0].topRpm, 6960);
});

test('/api/normalize ne corrige rien quand la balle est jouable', async () => {
  const res = await call('/api/normalize', {
    method: 'POST',
    body: { balls: [balle(0, { speed: 7, spin: 5 })] },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.adjustments, [], 'aucune correction inventée');
  assert.equal(res.body.balls[0].speed, 7);
  assert.equal(res.body.balls[0].spin, 5);
});

test('/api/normalize n’écrit rien dans la librairie', async () => {
  const avant = (await call('/api/drills')).body.drills.length;
  await call('/api/normalize', { method: 'POST', body: { balls: [balle(0, { speed: 10, spin: 8 })] } });
  assert.equal((await call('/api/drills')).body.drills.length, avant);
});

test('/api/normalize refuse une liste vide', async () => {
  const res = await call('/api/normalize', { method: 'POST', body: { balls: [] } });
  assert.equal(res.status, 400);
});

/* -------------------------------------------------------------------------- */
/* Pauses placées entre deux balles                                           */
/* -------------------------------------------------------------------------- */

/** Balle minimale, avec la pause éventuelle placée APRÈS elle. */
function balle(pauseAfter = 0, extra = {}) {
  return { speed: 5, spin: 0, height: 50, dropPoint: 0, frequency: 60, reps: 1, pauseAfter, ...extra };
}

test('sans aucune pause, l’exercice reste un seul envoi', () => {
  const segments = segmenterParPauses([balle(), balle(), balle()]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].balls.length, 3);
  assert.equal(segments[0].pause, 0);
});

test('une pause coupe l’exercice à l’endroit exact où elle est posée', () => {
  // L'utilisateur veut une pause après la 2e balle, et nulle part ailleurs.
  const segments = segmenterParPauses([balle(), balle(5), balle()]);
  assert.equal(segments.length, 2);
  // Les balles 1 et 2 s'enchaînent normalement : même segment.
  assert.deepEqual(segments[0].balls.map((b) => b.numero), [1, 2]);
  assert.equal(segments[0].pause, 5);
  assert.deepEqual(segments[1].balls.map((b) => b.numero), [3]);
  assert.equal(segments[1].pause, 0);
});

test('deux pauses donnent trois segments', () => {
  const segments = segmenterParPauses([balle(3), balle(), balle(7), balle()]);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map((sg) => sg.balls.map((b) => b.numero)), [[1], [2, 3], [4]]);
  assert.deepEqual(segments.map((sg) => sg.pause), [3, 7, 0]);
});

test('les pauses consécutives restent distinctes', () => {
  const segments = segmenterParPauses([balle(4), balle(4), balle()]);
  assert.deepEqual(segments.map((sg) => sg.balls.length), [1, 1, 1]);
  assert.deepEqual(segments.map((sg) => sg.pause), [4, 4, 0]);
});

test('une pause sur la dernière balle est ignorée : il n’y a plus rien à attendre', () => {
  const segments = segmenterParPauses([balle(), balle(), balle(9)]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].pause, 0);
});

test('une pause nulle ou absente ne coupe rien', () => {
  const segments = segmenterParPauses([
    { ...balle(), pauseAfter: undefined },
    { ...balle(), pauseAfter: null },
    balle(0),
  ]);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].balls.length, 3);
});

test('une pause est bornée à 600 s', () => {
  assert.equal(segmenterParPauses([balle(99999), balle()])[0].pause, 600);
});

test('le découpage conserve les paramètres de chaque balle', () => {
  const segments = segmenterParPauses([
    balle(0, { speed: 8, spin: -3, dropPoint: -6 }),
    balle(2, { speed: 2, spin: 5, dropPoint: 6 }),
  ]);
  const [a, b] = segments[0].balls;
  assert.equal(a.speed, 8);
  assert.equal(a.dropPoint, -6);
  assert.equal(b.speed, 2);
  assert.equal(b.dropPoint, 6);
  // `numero` est ajouté pour l'affichage, il ne perturbe rien d'autre.
  assert.equal(a.numero, 1);
  assert.equal(b.numero, 2);
});

test('un exercice avec pause est annoncé comme une séquence, pas comme un envoi simple', async () => {
  await call('/api/robot/connect', { method: 'POST', body: {} });
  const cree = await call('/api/drills', {
    method: 'POST',
    body: { name: 'Avec pause', balls: [balle(), balle(1, { frequency: 90 }), balle()] },
  });
  assert.equal(cree.status, 200);

  const res = await call('/api/robot/send', {
    method: 'POST',
    body: { id: cree.body.drill.id },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.sequence, true);
  assert.equal(res.body.segments, 2);
  assert.deepEqual(res.body.pauses, [1]);

  // Le premier segment part tout de suite, avec ses deux balles enchaînées.
  const envois = robot.journal.filter((j) => j.action === 'send');
  assert.equal(envois.at(-1).balls, 2);

  // On coupe la séquence pour ne pas laisser de minuterie traîner.
  await call('/api/robot/stop', { method: 'POST', body: {} });
  await call('/api/robot/disconnect', { method: 'POST', body: {} });
});

test('la pause est enregistrée avec l’exercice, et relue telle quelle', async () => {
  const cree = await call('/api/drills', {
    method: 'POST',
    body: { name: 'Pause mémorisée', balls: [balle(), balle(6), balle()] },
  });
  assert.equal(cree.status, 200);
  const id = cree.body.drill.id;

  // Relecture depuis le serveur : la pause est bien sur la 2e balle, nulle part ailleurs.
  const relu = await call(`/api/drills/${encodeURIComponent(id)}`);
  assert.deepEqual(relu.body.drill.balls.map((b) => b.pauseAfter), [0, 6, 0]);

  // Et elle survit à une modification qui ne la touche pas.
  const modifie = await call(`/api/drills/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { name: 'Pause mémorisée (renommée)' },
  });
  assert.equal(modifie.status, 200);
  assert.deepEqual(modifie.body.drill.balls.map((b) => b.pauseAfter), [0, 6, 0]);

  await call(`/api/drills/${encodeURIComponent(id)}`, { method: 'DELETE' });
});

test('les balles envoyées par le client priment sur la version enregistrée', async () => {
  // Cas vécu : on modifie un exercice, on clique « Envoyer au robot », et le
  // robot rejoue l'ancienne version. L'interface expédie donc l'exercice tel
  // qu'il est affiché, et le serveur doit le préférer à ce qu'il a sur disque.
  const cree = await call('/api/drills', {
    method: 'POST',
    body: { name: 'Version disque', balls: [balle(), balle(), balle()] },
  });
  const id = cree.body.drill.id;

  await call('/api/robot/connect', { method: 'POST', body: {} });
  const res = await call('/api/robot/send', {
    method: 'POST',
    body: { id, name: 'Version écran', balls: [balle(), balle(4, { speed: 9 })] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, 'Version écran');
  assert.equal(res.body.bytes, 7 + 2 * 24, 'deux balles, pas les trois du disque');

  // La librairie, elle, n’a pas bougé : envoyer n’est pas enregistrer.
  const relu = await call(`/api/drills/${encodeURIComponent(id)}`);
  assert.equal(relu.body.drill.balls.length, 3);

  await call('/api/robot/stop', { method: 'POST', body: {} });
  await call('/api/robot/disconnect', { method: 'POST', body: {} });
  await call(`/api/drills/${encodeURIComponent(id)}`, { method: 'DELETE' });
});

test('sans balle ni identifiant, l’envoi est refusé', async () => {
  await call('/api/robot/connect', { method: 'POST', body: {} });
  const res = await call('/api/robot/send', { method: 'POST', body: {} });
  assert.equal(res.status, 400);
  await call('/api/robot/disconnect', { method: 'POST', body: {} });
});

test('un exercice sans pause reste un envoi unique', async () => {
  await call('/api/robot/connect', { method: 'POST', body: {} });
  const res = await call('/api/robot/send', {
    method: 'POST',
    body: { name: 'Sans pause', balls: [balle(), balle(), balle()] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.sequence, undefined);
  assert.equal(res.body.bytes, 7 + 3 * 24);
  await call('/api/robot/disconnect', { method: 'POST', body: {} });
});

/* -------------------------------------------------------------------------- */
/* Import / export                                                            */
/* -------------------------------------------------------------------------- */

test('l’export produit les trois formats', async () => {
  for (const [format, motif] of [
    ['csv', /^Set;Ball;Name;Speed;Spin;Type/],
    ['csv-legacy', /^Set;Ball;Name;Top;Bottom/],
    ['smee', /^\d+ \d+ /],
  ]) {
    const res = await call(`/api/export/retour-service-rapide-source?format=${format}`);
    assert.equal(res.status, 404, 'l’exercice n’existe pas encore');

    const cree = await call('/api/drills', { method: 'POST', body: { name: 'retour-service-rapide-source', balls: BALLS } });
    assert.equal(cree.status, 200);
    const exp = await call(`/api/export/${cree.body.drill.id}?format=${format}`);
    assert.equal(exp.status, 200);
    assert.match(exp.body.text, motif, `format ${format}`);
    assert.match(exp.body.filename, format === 'smee' ? /\.txt$/ : /\.csv$/);
    await call(`/api/drills/${cree.body.drill.id}`, { method: 'DELETE' });
  }
});

test('un format d’export inconnu est refusé', async () => {
  const cree = await call('/api/drills', { method: 'POST', body: { name: 'Export', balls: BALLS } });
  const res = await call(`/api/export/${cree.body.drill.id}?format=xml`);
  assert.equal(res.status, 500, 'format inconnu → erreur explicite');
  assert.match(res.body.error, /Format inconnu/);
  await call(`/api/drills/${cree.body.drill.id}`, { method: 'DELETE' });
});

test('importer un CSV le prépare sans l’enregistrer', async () => {
  const csv = 'Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps\nA;1;Test;7.5;5;top;50;-5;60;1';
  const res = await call('/api/import', { method: 'POST', body: { content: csv } });
  assert.equal(res.status, 200);
  assert.equal(res.body.saved, false, 'l’import se confirme, il ne s’enregistre pas seul');
  assert.equal(res.body.format, 'csv');
  assert.equal(res.body.drill.balls.length, 1);
  assert.equal(res.body.drill.balls[0].speed, 7.5);

  const avecSauvegarde = await call('/api/import', {
    method: 'POST',
    body: { content: csv, name: 'Importé et gardé', save: true },
  });
  assert.equal(avecSauvegarde.body.saved, true);
  assert.ok(avecSauvegarde.body.drill.id);
});

test('importer du texte smee signale l’écart de RPM', async () => {
  const smee = '4000 700 100 2 20 1';
  const res = await call('/api/import', { method: 'POST', body: { content: smee } });
  assert.equal(res.body.format, 'smee');
  assert.ok(res.body.maxRpmError > 0);
  assert.equal(res.body.drill.balls[0].topRpm, 3941);
});

test('importer un contenu vide renvoie 400', async () => {
  assert.equal((await call('/api/import', { method: 'POST', body: { content: '  ' } })).status, 400);
});

/* -------------------------------------------------------------------------- */
/* Librairie en ligne                                                         */
/* -------------------------------------------------------------------------- */

test('la librairie en ligne est listée et convertie', async () => {
  const res = await call('/api/cloud?perPage=20');
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 1);
  const item = res.body.items[0];
  assert.equal(item.code, 'JOB857');
  assert.equal(item.readable, true);
  assert.equal(item.drill.balls.length, 1);
  assert.equal(item.drill.balls[0].color, 'yellow', 'back-spin → jaune');
  assert.equal(item.drill.balls[0].effect, 'back-spin');
});

test('un code en ligne est récupérable directement', async () => {
  const res = await call('/api/cloud/JOB857');
  assert.equal(res.status, 200);
  assert.equal(res.body.code, 'JOB857');
  assert.equal(res.body.drill.balls[0].frequency, 36);
});

test('publier un exercice renvoie un code de partage', async () => {
  const cree = await call('/api/drills', { method: 'POST', body: { name: 'À publier', balls: BALLS } });
  const res = await call('/api/cloud', { method: 'POST', body: { id: cree.body.drill.id } });
  assert.equal(res.status, 200);
  assert.equal(res.body.published, true);
  assert.match(res.body.code, /^[A-Z]{3}\d{3}$/);
  // La charge utile publiée est bien au format d'olanga.
  assert.equal(res.body.payload.name, 'À publier');
  assert.equal(res.body.payload.params.length, 3);
  assert.equal(res.body.payload.params[0][0].length, 10);
  await call(`/api/drills/${cree.body.drill.id}`, { method: 'DELETE' });
});

/* -------------------------------------------------------------------------- */
/* Intelligence artificielle                                                  */
/* -------------------------------------------------------------------------- */

test('sans clé DeepSeek, la génération explique quoi faire', async () => {
  const res = await call('/api/generate', { method: 'POST', body: { description: 'topspin rapide' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Aucune clé DeepSeek/);
  assert.match(res.body.error, /DEEPSEEK_API_KEY/);
});

test('sans description, la génération refuse', async () => {
  const res = await call('/api/generate', { method: 'POST', body: { description: '   ' } });
  assert.equal(res.status, 400);
});
