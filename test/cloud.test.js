/**
 * Tests de la librairie en ligne et du format d'échange d'olanga.
 *
 * Aucun accès réseau : on injecte un `fetch` factice. La forme des données
 * reproduit ce que renvoie réellement le serveur PocketBase d'olanga
 * (`nova.varandal.de`), relevée sur une réponse authentique.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateShareCode,
  getSharedDrill,
  isValidShareCode,
  listSharedDrills,
  normalizeShareCode,
  publishSharedDrill,
  summarizeSharedItem,
} from '../src/cloud.js';
import {
  drillToSharedPayload,
  olangaParamsToBalls,
  sharedPayloadToDrill,
} from '../src/protocol.js';

/** Un enregistrement tel que le serveur en renvoie. */
const ITEM = {
  id: 'q2497sdd9loy705',
  share_code: 'JOB857',
  created: '2025-12-08 13:09:00.568Z',
  updated: '2025-12-08 13:09:00.568Z',
  drill_data: {
    level: 1,
    name: 'Shared drill example',
    random: false,
    // Trois balles de 7 valeurs (ancien format, sans speed/spin/type).
    params: [
      [[1547, 2915, 50, -5, 10, 1, 1]],
      [[1547, 2915, 50, 0, 10, 1, 1]],
      [[1547, 2915, 50, 5, 10, 1, 1]],
    ],
  },
};

/** Réponse PocketBase d'une liste. */
const listResponse = (items, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({ items, totalItems: items.length, page: 1, perPage: 30, ...extra }),
});

function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    for (const h of handlers) {
      const res = h(url, init, calls.length);
      if (res) return res;
    }
    throw new Error(`fakeFetch : aucune réponse pour ${url}`);
  };
  impl.calls = calls;
  return impl;
}

/* -------------------------------------------------------------------------- */
/* Codes de partage                                                           */
/* -------------------------------------------------------------------------- */

test('un code de partage fait trois lettres puis trois chiffres', () => {
  for (let i = 0; i < 50; i++) {
    const code = generateShareCode();
    assert.match(code, /^[A-Z]{3}\d{3}$/, `code inattendu : ${code}`);
  }
  // Deux tirages identiques d'affilée sont improbables, mais on ne teste pas
  // l'aléatoire : on vérifie seulement la forme et la variété.
  const codes = new Set(Array.from({ length: 20 }, generateShareCode));
  assert.ok(codes.size > 5, 'les codes doivent varier');
});

test('isValidShareCode n’accepte que la bonne forme', () => {
  assert.equal(isValidShareCode('JOB857'), true);
  assert.equal(isValidShareCode('job857'), true, 'la casse est tolérée');
  assert.equal(isValidShareCode('AB12'), false);
  assert.equal(isValidShareCode('ABCD12'), false);
  assert.equal(isValidShareCode('ABC1234'), false);
  assert.equal(isValidShareCode('123ABC'), false);
  assert.equal(isValidShareCode(''), false);
  assert.equal(isValidShareCode(null), false);
  assert.equal(normalizeShareCode('  job857 '), 'JOB857');
});

/* -------------------------------------------------------------------------- */
/* Lecture de la librairie                                                    */
/* -------------------------------------------------------------------------- */

test('listSharedDrills renvoie les enregistrements', async () => {
  const fetchImpl = fakeFetch([() => listResponse([ITEM])]);
  const res = await listSharedDrills({ fetchImpl, perPage: 10 });

  assert.equal(res.total, 1);
  assert.equal(res.items[0].share_code, 'JOB857');
  assert.match(fetchImpl.calls[0].url, /perPage=10/);
});

test('la recherche construit un filtre PocketBase et échappe les apostrophes', async () => {
  const fetchImpl = fakeFetch([() => listResponse([])]);
  await listSharedDrills({ fetchImpl, search: "l'école" });
  const url = decodeURIComponent(fetchImpl.calls[0].url);
  assert.match(url, /filter=/);
  assert.ok(!/l'école/.test(url), 'l’apostrophe ne doit pas casser le filtre');
});

test('getSharedDrill retrouve un exercice par son code', async () => {
  const fetchImpl = fakeFetch([() => listResponse([ITEM])]);
  const res = await getSharedDrill('job857', { fetchImpl });

  assert.equal(res.code, 'JOB857');
  assert.equal(res.data.name, 'Shared drill example');
  assert.match(fetchImpl.calls[0].url, /JOB857/);
});

test('getSharedDrill renvoie null quand le code n’existe pas', async () => {
  const fetchImpl = fakeFetch([() => listResponse([])]);
  assert.equal(await getSharedDrill('ZZZ999', { fetchImpl }), null);
});

test('getSharedDrill refuse un code mal formé sans appeler le réseau', async () => {
  const fetchImpl = fakeFetch([]);
  await assert.rejects(() => getSharedDrill('nope', { fetchImpl }), /Code de partage invalide/);
  assert.equal(fetchImpl.calls.length, 0, 'aucun appel réseau ne doit avoir lieu');
});

test('une panne réseau donne un message compréhensible', async () => {
  const fetchImpl = fakeFetch([() => { throw new Error('ENOTFOUND'); }]);
  await assert.rejects(
    () => listSharedDrills({ fetchImpl }),
    /Impossible de joindre la librairie en ligne : ENOTFOUND/,
  );
  await assert.rejects(
    () => getSharedDrill('JOB857', { fetchImpl }),
    /Impossible de joindre la librairie en ligne/,
  );
});

test('un statut HTTP anormal est signalé', async () => {
  const fetchImpl = fakeFetch([() => ({ ok: false, status: 503, json: async () => ({}) })]);
  await assert.rejects(() => listSharedDrills({ fetchImpl }), /répondu 503/);
});

/* -------------------------------------------------------------------------- */
/* Publication                                                                */
/* -------------------------------------------------------------------------- */

test('publishSharedDrill choisit un code libre puis publie', async () => {
  let appels = 0;
  const fetchImpl = fakeFetch([
    // Les deux premiers codes essayés sont pris, le troisième est libre.
    (url, init, n) => {
      if ((init.method ?? 'GET') === 'POST') {
        appels++;
        return { ok: true, status: 200, json: async () => ({ id: 'new' }), text: async () => '' };
      }
      const pris = n <= 2;
      return listResponse(pris ? [{ id: 'x' }] : []);
    },
  ]);

  const res = await publishSharedDrill({ name: 'Test' }, { fetchImpl, maxAttempts: 5 });
  assert.match(res.code, /^[A-Z]{3}\d{3}$/);
  assert.equal(appels, 1, 'une seule publication');

  const envoi = fetchImpl.calls.find((c) => c.method === 'POST');
  assert.deepEqual(envoi.body.drill_data, { name: 'Test' });
  assert.equal(envoi.body.share_code, res.code);
});

test('publishSharedDrill abandonne si aucun code n’est libre', async () => {
  const fetchImpl = fakeFetch([
    (url, init) => ((init.method ?? 'GET') === 'POST'
      ? { ok: true, status: 200, json: async () => ({}) }
      : listResponse([{ id: 'toujours pris' }])),
  ]);
  await assert.rejects(
    () => publishSharedDrill({ name: 'X' }, { fetchImpl, maxAttempts: 3 }),
    /Impossible de trouver un code de partage libre/,
  );
});

test('une publication refusée remonte le statut et le détail', async () => {
  const fetchImpl = fakeFetch([
    (url, init) => ((init.method ?? 'GET') === 'POST'
      ? { ok: false, status: 400, text: async () => 'champ manquant' }
      : listResponse([])),
  ]);
  await assert.rejects(
    () => publishSharedDrill({ name: 'X' }, { fetchImpl }),
    /Publication refusée \(400\).*champ manquant/s,
  );
});

/* -------------------------------------------------------------------------- */
/* Format d'échange d'olanga                                                  */
/* -------------------------------------------------------------------------- */

test('olangaParamsToBalls lit le format à 7 valeurs et retrouve vitesse et effet', () => {
  // 1547/2915 correspond exactement au preset PUSH_B d'olanga : vitesse 2,
  // effet 2 en back-spin (roue basse plus rapide).
  const { balls, warnings, maxRpmError } = olangaParamsToBalls(ITEM.drill_data.params);

  assert.equal(balls.length, 3);
  assert.equal(balls[0].speed, 2);
  assert.equal(balls[0].spin, -2);
  assert.equal(balls[0].topRpm, 1547);
  assert.equal(balls[0].bottomRpm, 2915);
  assert.equal(balls[0].frequency, 36, 'le 10 du format est un pourcentage, soit 36 bpm');
  assert.deepEqual(warnings, []);
  assert.equal(maxRpmError, 0, 'un exercice d’olanga revient exactement');
});

test('olangaParamsToBalls lit aussi le format moderne à 10 valeurs', () => {
  // Vitesse 5 et effet 4 (top-spin) correspondent à 5491/2755 tr/min.
  const params = [[[5491, 2755, 50, -5, 40, 1, 1, 5, 4, 'top']]];
  const { balls, maxRpmError } = olangaParamsToBalls(params);
  assert.equal(balls[0].speed, 5);
  assert.equal(balls[0].spin, 4);
  assert.equal(balls[0].frequency, 54, '40 % → 54 bpm');
  assert.equal(maxRpmError, 0);
});

test('quand les champs se contredisent, les RPM font foi', () => {
  // Le format d'olanga contient À LA FOIS les RPM et (dans sa version récente)
  // la vitesse et l'effet. En principe ils concordent. S'ils divergent, ce sont
  // les RPM qui décrivent ce que le robot fera réellement : c'est donc eux que
  // l'on suit, plutôt que d'afficher un effet que le robot ne produira pas.
  const params = [[[1547, 2915, 50, -5, 10, 1, 1, 9, 9, 'top']]];
  const { balls } = olangaParamsToBalls(params);
  assert.equal(balls[0].speed, 2, 'déduit des RPM, pas du champ « 9 »');
  assert.equal(balls[0].spin, -2, 'back-spin, pas le « top » annoncé');
  assert.equal(balls[0].topRpm, 1547);
  assert.equal(balls[0].bottomRpm, 2915);
});

test('les variantes d’un groupe deviennent des balles distinctes', () => {
  const params = [
    [[1547, 2915, 50, -5, 10, 1, 1], [3545, 2177, 50, 5, 40, 1, 1]],
    [[1547, 2915, 50, 0, 10, 1, 1]],
  ];
  const r = sharedPayloadToDrill({ name: 'Variantes', level: 2, params });
  assert.equal(r.drill.balls.length, 3);
  assert.equal(r.variantes, 1);
  assert.equal(r.drill.random, true, 'des variantes impliquent un choix aléatoire');
  assert.equal(r.difficulty, 2);
});

test('un exercice partagé malformé est refusé clairement', () => {
  assert.throws(() => sharedPayloadToDrill(null), /charge utile est vide/);
  assert.throws(() => sharedPayloadToDrill({ params: [] }), /params/);
  assert.throws(() => sharedPayloadToDrill({ params: [[]] }), /groupe 1 est vide/);
  assert.throws(() => sharedPayloadToDrill({ params: [[[1, 2]]] }), /au moins/);
  assert.throws(() => sharedPayloadToDrill({ params: [[['a', 'b', 'c', 'd', 'e', 'f']]] }), /non numérique/);
  assert.throws(() => sharedPayloadToDrill({ params: [[[10, 20, 30, 1, 10, 1]]] }), /RPM doivent être/);
});

test('un aller-retour par la charge utile partagée est fidèle', () => {
  const balls = olangaParamsToBalls(ITEM.drill_data.params).balls;
  const payload = drillToSharedPayload({
    name: 'Aller-retour', difficulty: 3, random: true, balls,
  });

  assert.equal(payload.name, 'Aller-retour');
  assert.equal(payload.level, 3);
  assert.equal(payload.random, true);
  assert.equal(payload.params.length, 3);
  assert.deepEqual(payload.params[0][0], [1547, 2915, 50, -5, 10, 1, 1, 2, 2, 'back']);

  const retour = sharedPayloadToDrill(payload);
  assert.equal(retour.drill.balls[0].speed, 2);
  assert.equal(retour.drill.balls[0].spin, -2);
  assert.equal(retour.maxRpmError, 0);
});

/* -------------------------------------------------------------------------- */
/* Résumé pour l'affichage                                                    */
/* -------------------------------------------------------------------------- */

test('summarizeSharedItem résume sans convertir', () => {
  const s = summarizeSharedItem(ITEM);
  assert.equal(s.code, 'JOB857');
  assert.equal(s.name, 'Shared drill example');
  assert.equal(s.balls, 3);
  assert.equal(s.level, 1);
  assert.equal(s.random, false);
});

test('summarizeSharedItem survit à un enregistrement vide', () => {
  const s = summarizeSharedItem({});
  assert.equal(s.name, '(sans nom)');
  assert.equal(s.balls, 0);
});
