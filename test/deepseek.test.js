/**
 * Tests du générateur DeepSeek, sans réseau : on injecte un `fetch` factice.
 *
 * On vérifie surtout ce qui compte pour la fiabilité : la validation des
 * paramètres renvoyés par le modèle, la boucle de réparation quand le modèle se
 * trompe, et la qualité des messages d'erreur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSystemPrompt,
  chatCompletion,
  generateDrill,
  parseModelJson,
} from '../src/deepseek.js';

/** Fabrique un `fetch` factice qui rejoue une file de réponses. */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch : plus de réponse disponible');
    if (next.throw) throw next.throw;
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

/** Enveloppe un objet métier dans une réponse Chat Completions plausible. */
const completionOf = (payload) => ({
  status: 200,
  body: {
    model: 'deepseek-flash',
    choices: [{ message: { role: 'assistant', content: JSON.stringify(payload) } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      completion_tokens_details: { reasoning_tokens: 30 },
    },
  },
});

const VALID_DRILL = {
  name: 'Retour de services rapides',
  summary: 'Trois services rapides de même longueur, à droite, au centre et à gauche.',
  coachingNotes: 'Le robot ne produit pas d’effet latéral : la difficulté vient du placement.',
  tags: ['service', 'rapidité'],
  mode: 'endless',
  modeValue: 0,
  random: true,
  balls: [
    { speed: 9, spin: 2, height: 50, dropPoint: -6, frequency: 70, reps: 1 },
    { speed: 9, spin: 2, height: 50, dropPoint: 0, frequency: 70, reps: 1 },
    { speed: 9, spin: 2, height: 50, dropPoint: 6, frequency: 70, reps: 1 },
  ],
};

/* -------------------------------------------------------------------------- */
/* Prompt                                                                     */
/* -------------------------------------------------------------------------- */

test('le prompt système décrit les bornes et la convention de signe', () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /dropPoint/);
  assert.match(prompt, /négatif = à gauche/);
  assert.match(prompt, /positif = à droite/);
  assert.match(prompt, /effet latéral/i);
  assert.match(prompt, /20 balles maximum/);
  assert.match(prompt, /970 \+ 630,5×speed/);
  assert.match(prompt, /"balls"/);
  // La limite spin/vitesse doit être explicite, et cohérente avec celle que le
  // serveur applique vraiment : 1 (et non 2) à vitesse 0, car les roues ne
  // suivent pas au-delà.
  assert.match(prompt, /vitesse 0→1, 0\.5→2, 1→3/);
});

/* -------------------------------------------------------------------------- */
/* Analyse du JSON                                                            */
/* -------------------------------------------------------------------------- */

test('parseModelJson accepte le JSON nu, les balises Markdown et le texte autour', () => {
  assert.deepEqual(parseModelJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseModelJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseModelJson('```\n{"a":3}\n```'), { a: 3 });
  assert.deepEqual(parseModelJson('Voici l’exercice :\n{"a":4}\nVoilà.'), { a: 4 });
});

test('parseModelJson rejette une réponse vide ou sans objet', () => {
  assert.throws(() => parseModelJson(''), /réponse vide/);
  assert.throws(() => parseModelJson('aucun objet ici'), /non JSON/);
});

/* -------------------------------------------------------------------------- */
/* Appel HTTP                                                                 */
/* -------------------------------------------------------------------------- */

test('chatCompletion refuse de partir sans clé API', async () => {
  await assert.rejects(
    () => chatCompletion({ apiKey: null, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', messages: [] }),
    /Aucune clé API DeepSeek/,
  );
});

test('chatCompletion appelle le bon point d’entrée avec le bon en-tête', async () => {
  const fetchImpl = fakeFetch([completionOf(VALID_DRILL)]);
  const out = await chatCompletion({
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'Réponds en JSON.' }],
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer sk-test');
  assert.equal(fetchImpl.calls[0].body.model, 'deepseek-flash');
  assert.deepEqual(fetchImpl.calls[0].body.response_format, { type: 'json_object' });
  assert.equal(fetchImpl.calls[0].body.stream, false);
  assert.equal(out.model, 'deepseek-flash');
  assert.equal(out.usage.total_tokens, 150);
});

test('chatCompletion retire response_format si le modèle le refuse', async () => {
  // On ne parie plus sur une liste de noms de modèles — elle a déjà changé une
  // fois. On essaie, et on retire le paramètre que le serveur rejette.
  const fetchImpl = fakeFetch([
    { status: 400, body: { error: { message: 'response_format of type json_object is not supported' } } },
    completionOf(VALID_DRILL),
  ]);

  const out = await chatCompletion({
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    model: 'un-modele-futur',
    messages: [{ role: 'user', content: 'Réponds en JSON.' }],
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 2, 'un second essai est attendu');
  assert.ok(fetchImpl.calls[0].body.response_format, 'le premier essai demande le mode JSON');
  assert.equal(fetchImpl.calls[1].body.response_format, undefined, 'le second s’en passe');
  assert.equal(fetchImpl.calls[1].body.temperature, 0.3, 'la température est conservée');
  assert.deepEqual(out.degraded, ['response_format']);
  assert.ok(out.content.length > 0);
});

test('chatCompletion retire temperature si le modèle la refuse', async () => {
  const fetchImpl = fakeFetch([
    { status: 400, body: { error: { message: 'temperature is not supported for this model' } } },
    completionOf(VALID_DRILL),
  ]);

  const out = await chatCompletion({
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com',
    model: 'un-modele-futur',
    messages: [{ role: 'user', content: 'Réponds en JSON.' }],
    fetchImpl,
  });

  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[1].body.temperature, undefined);
  assert.ok(fetchImpl.calls[1].body.response_format, 'le mode JSON est conservé');
  assert.deepEqual(out.degraded, ['temperature']);
});

test('chatCompletion signale un 400 qui n’a rien à voir avec les paramètres', async () => {
  const fetchImpl = fakeFetch([
    { status: 400, body: { error: { message: 'Model not found' } } },
  ]);
  await assert.rejects(
    () => chatCompletion({
      apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'inexistant',
      messages: [{ role: 'user', content: 'Réponds en JSON.' }], fetchImpl,
    }),
    /Erreur DeepSeek \(400\)|refusée par DeepSeek/,
  );
  assert.equal(fetchImpl.calls.length, 1, 'inutile de réessayer');
});

test('le mode JSON exige que le mot « json » apparaisse dans le prompt', async () => {
  const fetchImpl = fakeFetch([completionOf(VALID_DRILL)]);
  await assert.rejects(
    () => chatCompletion({
      apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'donne-moi un exercice' }], fetchImpl,
    }),
    /exige que le mot « json »/,
  );
  assert.equal(fetchImpl.calls.length, 0, 'on échoue avant l’appel réseau');
});

test('un contenu vide alors que le modèle a raisonné donne un message utile', async () => {
  // Cas réel observé : le budget de sortie part entièrement en raisonnement,
  // content revient vide et reasoning_content est rempli.
  const fetchImpl = fakeFetch([{
    status: 200,
    body: {
      model: 'deepseek-flash',
      choices: [{
        finish_reason: 'length',
        message: { role: 'assistant', content: '', reasoning_content: 'je réfléchis…' },
      }],
      usage: { prompt_tokens: 63, completion_tokens: 50, total_tokens: 113, completion_tokens_details: { reasoning_tokens: 50 } },
    },
  }]);

  await assert.rejects(
    () => chatCompletion({
      apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'Réponds en JSON.' }], fetchImpl,
    }),
    /sans contenu exploitable.*budget de sortie/s,
  );
});

test('chatCompletion traduit les erreurs HTTP en messages actionnables', async () => {
  const cases = [
    [401, /clé API/, /DEEPSEEK_API_KEY/],
    [402, /sans solde suffisant/, /Recharge/],
    [429, /Limite de débit/, /Réessaie/],
    [500, /Erreur DeepSeek \(500\)/, /boom/],
  ];
  for (const [status, re1, re2] of cases) {
    const fetchImpl = fakeFetch([{ status, body: { error: { message: 'boom' } } }]);
    await assert.rejects(
      () => chatCompletion({
        apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
        messages: [{ role: 'user', content: 'Réponds en JSON.' }], fetchImpl,
      }),
      (err) => re1.test(err.message) && re2.test(err.message),
      `le statut ${status} doit produire un message explicite`,
    );
  }
});

test('chatCompletion gère l’expiration du délai', async () => {
  const abortError = new Error('aborted');
  abortError.name = 'AbortError';
  const fetchImpl = fakeFetch([{ throw: abortError }]);
  await assert.rejects(
    () => chatCompletion({
      apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'Réponds en JSON.' }], fetchImpl, timeoutMs: 5000,
    }),
    /délai dépassé/,
  );
});

/* -------------------------------------------------------------------------- */
/* Génération complète                                                        */
/* -------------------------------------------------------------------------- */

test('generateDrill transforme une demande en exercice valide', async () => {
  const fetchImpl = fakeFetch([completionOf(VALID_DRILL)]);
  const result = await generateDrill(
    'services très rapides à droite, au centre et à gauche, aléatoirement, tous de la même longueur',
    { apiKey: 'sk-test', fetchImpl },
  );

  assert.equal(result.name, 'Retour de services rapides');
  assert.deepEqual(result.tags, ['service', 'rapidité']);
  assert.equal(result.drill.random, true);
  assert.equal(result.drill.balls.length, 3);
  assert.deepEqual(result.drill.balls.map((b) => b.dropPoint), [-6, 0, 6]);
  assert.deepEqual(result.drill.balls.map((b) => b.speed), [9, 9, 9]);
  assert.equal(result.meta.attempts, 1);
  assert.equal(result.meta.usage.totalTokens, 150);
  assert.equal(result.meta.usage.reasoningTokens, 30, 'les jetons de raisonnement sont comptabilisés');
  assert.deepEqual(result.meta.degraded, [], 'aucun paramètre n’a été retiré');
  assert.equal(result.meta.model, 'deepseek-flash');

  // L'intention d'origine doit atteindre le modèle.
  assert.match(fetchImpl.calls[0].body.messages[1].content, /même longueur/);
});

test('generateDrill ramène automatiquement un spin impossible sans rappeler le modèle', async () => {
  // Vitesse 10 avec spin 6 : le firmware plafonne le spin à 0 à cette vitesse,
  // et 10 sans effet demanderait encore 7275 tr/min à des roues limitées à 7200.
  // Ce sont des corrections bénignes et sans ambiguïté, donc on les applique
  // directement plutôt que de gaspiller un aller-retour avec le modèle.
  const bad = {
    ...VALID_DRILL,
    balls: [{ speed: 10, spin: 6, height: 50, dropPoint: 0, frequency: 60, reps: 1 }],
  };
  const fetchImpl = fakeFetch([completionOf(bad)]);

  const result = await generateDrill('balle très rapide avec beaucoup d’effet', { apiKey: 'sk-test', fetchImpl });

  assert.equal(fetchImpl.calls.length, 1, 'une correction automatique ne doit pas coûter d’appel');
  assert.equal(result.meta.attempts, 1);
  assert.equal(result.drill.balls[0].speed, 9.5, 'la vitesse est bloquée à ce que les roues acceptent');
  assert.equal(result.drill.balls[0].spin, 0);
  assert.ok(
    result.adjustments.some((a) => /effet : 6 → 0/.test(a)),
    `la correction doit être signalée, obtenu : ${JSON.stringify(result.adjustments)}`,
  );
});

test('generateDrill répare un mode inconnu', async () => {
  const bad = { ...VALID_DRILL, mode: 'sprint', modeValue: 0 };
  const fetchImpl = fakeFetch([completionOf(bad), completionOf(VALID_DRILL)]);
  const result = await generateDrill('un exercice', { apiKey: 'sk-test', fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
  assert.match(fetchImpl.calls[1].body.messages.at(-1).content, /refusé par le robot/);
  assert.equal(result.drill.mode, 'endless');
});

test('generateDrill répare un JSON illisible', async () => {
  const fetchImpl = fakeFetch([
    { status: 200, body: { choices: [{ message: { content: 'désolé, je ne peux pas' } }] } },
    completionOf(VALID_DRILL),
  ]);
  const result = await generateDrill('un exercice', { apiKey: 'sk-test', fetchImpl });
  assert.equal(result.meta.attempts, 2);
  assert.match(fetchImpl.calls[1].body.messages.at(-1).content, /JSON/);
});

test('generateDrill répare un exercice vide', async () => {
  const fetchImpl = fakeFetch([
    completionOf({ ...VALID_DRILL, balls: [] }),
    completionOf(VALID_DRILL),
  ]);
  const result = await generateDrill('un exercice', { apiKey: 'sk-test', fetchImpl });
  assert.equal(result.meta.attempts, 2);
  assert.match(fetchImpl.calls[1].body.messages.at(-1).content, /refusé par le robot|Aucune balle/);
});

test('generateDrill abandonne avec un message clair après épuisement des tentatives', async () => {
  // Des valeurs non numériques ne peuvent pas être ramenées dans les bornes :
  // le modèle doit vraiment se corriger, et ici il ne le fait jamais.
  const bad = { ...VALID_DRILL, balls: [{ speed: 'très vite', spin: 'beaucoup', height: 0, dropPoint: 0, frequency: 60, reps: 1 }] };
  const fetchImpl = fakeFetch([completionOf(bad), completionOf(bad), completionOf(bad)]);
  await assert.rejects(
    () => generateDrill('impossible', { apiKey: 'sk-test', fetchImpl, maxRepairAttempts: 2 }),
    /n’a pas produit d’exercice valide après 3 tentative/,
  );
  assert.equal(fetchImpl.calls.length, 3, 'une tentative initiale plus deux réparations');
});

test('generateDrill refuse une demande vide', async () => {
  await assert.rejects(() => generateDrill('   ', { apiKey: 'sk-test' }), /Décris l’exercice/);
});

test('generateDrill normalise les valeurs juste hors bornes sans rappeler le modèle', async () => {
  // 9.4 sera arrondi à 9.5, dropPoint 6.2 à 6 : ce sont des corrections
  // bénignes, on ne gaspille pas un aller-retour pour elles.
  const slightlyOff = {
    ...VALID_DRILL,
    balls: [{ speed: 9.4, spin: 2, height: 50, dropPoint: 6.2, frequency: 70, reps: 1 }],
  };
  const fetchImpl = fakeFetch([completionOf(slightlyOff)]);
  const result = await generateDrill('presque bon', { apiKey: 'sk-test', fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(result.meta.attempts, 1);
  assert.equal(result.drill.balls[0].speed, 9.5);
  assert.equal(result.drill.balls[0].dropPoint, 6);
  assert.ok(result.adjustments.length >= 2, 'les corrections doivent être rapportées');
});
