/**
 * Génération d'exercices par DeepSeek.
 *
 * DeepSeek expose une API compatible OpenAI ; on l'appelle directement en
 * `fetch` pour ne pas ajouter de dépendance. Le modèle renvoie du JSON, que
 * l'on valide avec les mêmes règles que le reste du projet. Si le JSON est
 * invalide ou sort des bornes matérielles, on renvoie les erreurs au modèle et
 * on lui demande une correction — jusqu'à `maxRepairAttempts` fois.
 */

import {
  buildDrill,
  validateDrill,
  DROP_POINT_SIGN_HELP,
  RANGES,
} from './protocol.js';
import { maxSpinForSpeed, RPM_MIN, RPM_MAX } from './wheels.js';

/**
 * Table « vitesse → amplitude de spin réellement utilisable », mise en forme
 * pour le prompt.
 *
 * ENGENDRÉE, jamais recopiée à la main : c'est la même fonction que celle qui
 * borne les balles à l'enregistrement. Une table écrite en dur finit toujours
 * par diverger — c'est exactement ce qui se passait quand le prompt annonçait
 * « effet 3 à vitesse 8,5 » alors que les roues plafonnaient à 2,5 : l'IA
 * proposait un réglage que le robot refusait.
 */
function spinLimitTable() {
  const lignes = [];
  for (let vitesse = 0; vitesse <= 10; vitesse += 0.5) {
    lignes.push(`${vitesse}→${maxSpinForSpeed(vitesse)}`);
  }
  return lignes.join(', ');
}
import { DEFAULT_MODEL } from './config.js';

/**
 * Décrit au modèle le matériel, les bornes et la traduction attendue.
 *
 * @param {object} [options]
 * @param {number} [options.headAngle=0] orientation du pivot latéral, en degrés
 */
export function buildSystemPrompt({ headAngle = 0, setup = null } = {}) {
  const angle = Number.isFinite(Number(headAngle)) ? Math.round(Number(headAngle)) : 0;
  return `Tu es entraîneur de tennis de table et technicien du robot lance-balles « Pongbot Nova S Pro ».
Ta tâche : traduire une intention d'entraînement exprimée en langage naturel en un exercice que le robot peut exécuter.

CONTRAINTES MATÉRIELLES (à respecter absolument)
- Le robot a DEUX roues (supérieure et inférieure). Leurs vitesses relatives produisent l'effet,
  et c'est le SEUL réglage d'effet que le logiciel puisse envoyer.
- L'AXE de cet effet dépend d'un réglage PHYSIQUE : le pivot latéral de la tête, que l'utilisateur
  tourne À LA MAIN (manuel : « Einstellung des Seitenspins : Manuell, 180° ± 90° »). Aucune commande
  Bluetooth ne permet de le lire ni de le changer.

ORIENTATION ACTUELLE DE LA TÊTE : ${angle}° — ${describeHeadForPrompt(angle)}
${setup ? `\nPLACEMENT DU ROBOT : ${setup}. Tiens-en compte : une balle partant d'un robot reculé\narrive avec plus de temps de vol, et un robot orienté couvre mieux le côté vers lequel il pointe.\n` : ''}

Comment en tenir compte :
- Tête droite (0°) : la valeur « spin » positive donne du top-spin, négative du back-spin.
  Un effet latéral ne peut alors venir QUE de la variation de placement (dropPoint).
- Tête tournée : une partie de l'effet devient latérale. À ±90° l'effet est purement latéral.
  La MÊME valeur « spin » ne veut donc plus dire « top-spin ».
- Si la tête est déjà tournée, ne double-compte pas l'effet latéral : n'ajoute pas en plus une
  variation de placement « pour faire latéral ». Sers-toi du placement uniquement pour la zone
  de table visée.
- Si l'utilisateur demande un effet latéral et que la tête est droite, dis-le dans coachingNotes :
  il doit tourner le pivot à la main, le logiciel ne peut pas le faire.
- Rappelle dans coachingNotes quelle position de tête correspond à ce que tu proposes.
- Paramètres, en unités utilisateur :
  * speed       ${RANGES.speed.min} à ${RANGES.speed.max}, pas de ${RANGES.speed.step}. Vitesse de la balle : 0 = très lent, 10 = très rapide.
  * spin        ${RANGES.spin.min} à ${RANGES.spin.max}, pas de ${RANGES.spin.step}. Positif = top-spin, négatif = back-spin.
  * height      ${RANGES.height.min} à ${RANGES.height.max}, pas de ${RANGES.height.step}. Hauteur de la balle ; 50 = hauteur moyenne.
  * dropPoint   ${RANGES.dropPoint.min} à ${RANGES.dropPoint.max}, pas de ${RANGES.dropPoint.step}. ${DROP_POINT_SIGN_HELP}.
  * frequency   ${RANGES.frequency.min} à ${RANGES.frequency.max}, pas de ${RANGES.frequency.step}. Cadence, en balles par minute.
  * reps        ${RANGES.reps.min} à ${RANGES.reps.max}, entier. Nombre de fois que la balle est répétée avant de passer à la suivante.
  * pauseAfter  FACULTATIF. Temps d'arrêt APRÈS cette balle précise, avant la suivante, EN SECONDES.
                L'utilisateur le donne souvent comme une CADENCE : « une pause à 30 bpm » signifie
                la durée d'un battement à 30 bpm, donc pauseAfter = 60 / 30 = 2. Absent ou 0 = les
                balles s'enchaînent sans interruption.
- Limite physique : pour une vitesse donnée, l'amplitude du spin est plafonnée.
  vitesse ${spinLimitTable()}
  Autrement dit : plus la balle est rapide, moins on peut y mettre d'effet.
- Les roues tournent entre ${RPM_MIN} et ${RPM_MAX} tr/min. Formules : roue haute = 970 + 630,5×speed + 342×spin ;
  roue basse = 970 + 630,5×speed − 342×spin. N'écris jamais ces valeurs toi-même : donne seulement speed et spin.
  La table ci-dessus tient déjà compte de cette limite : ne la dépasse jamais.
- 20 balles maximum par exercice. 2 à 6 balles suffisent dans presque tous les cas.

RÈGLES DE TRADUCTION
- La cadence est en BALLES PAR MINUTE (30 à 90). 30 = très lent, 60 = soutenu, 90 = très rapide.
- « même longueur », « même profondeur » ⇒ mêmes speed ET même height pour toutes les balles concernées.
- « à droite / au centre / à gauche » ⇒ trois balles de dropPoint POSITIF / 0 / NÉGATIF, de même
  amplitude (par exemple +6, 0, −6). Le signe positif place la balle à droite du joueur.
- « aléatoirement », « dans le désordre », « au hasard » ⇒ "random": true.
- « très rapide » ⇒ speed 8 à 9.5 ; « rapide » ⇒ 6.5 à 8 ; « moyen » ⇒ 4.5 à 6 ;
  « lent » ⇒ 2 à 4 ; « très lent » ⇒ 0.5 à 2.
- « beaucoup d'effet » ⇒ spin proche du plafond autorisé pour la vitesse choisie.
- Une durée (« 5 minutes », « 10 min ») ⇒ mode "minutes", modeValue = nombre de minutes.
- Un nombre de séries (« 3 séries », « trois fois la séquence ») ⇒ mode "combos", modeValue = ce nombre.
- Sinon ⇒ mode "endless" et modeValue 0 : le robot tourne jusqu'à l'arrêt.
- reps > 1 seulement si l'utilisateur veut la même balle répétée plusieurs fois de suite.
- Une pause n'est JAMAIS générale : elle se place entre deux balles précises. Si l'utilisateur dit
  « une pause de 5 s après la 2e balle », mets "pauseAfter": 5 sur la DEUXIÈME balle seulement et
  rien sur les autres. S'il la donne en bpm (« une pause à 30 bpm »), convertis en secondes :
  pauseAfter = 60 / bpm. S'il ne demande aucune pause, n'écris aucun pauseAfter.
- Ne crée pas de doublons inutiles : si deux balles sont identiques, fusionne-les en augmentant reps.

SORTIE
Réponds UNIQUEMENT par un objet JSON, sans texte autour et sans balises Markdown :
{
  "name": "nom court de l'exercice, en français, 3 à 8 mots",
  "summary": "une ou deux phrases décrivant ce que l'exercice travaille",
  "coachingNotes": "conseils techniques et mise en garde éventuelle (effet latéral, limite de spin, réglage à ajuster)",
  "tags": ["2 à 4 étiquettes courtes en minuscules"],
  "mode": "endless",
  "modeValue": 0,
  "random": true,
  "balls": [
    { "speed": 9, "spin": 2, "height": 50, "dropPoint": -6, "frequency": 70, "reps": 1 }
  ]
}
Chaque balle doit contenir les six champs numériques (speed, spin, height, dropPoint, frequency,
reps). Le champ "pauseAfter" est FACULTATIF : ne l'ajoute que sur les balles suivies d'une pause
demandée. Aucun commentaire dans le JSON.`;
}

/**
 * Phrase décrivant la tête pour le prompt. Volontairement séparée de
 * `describeHead` (src/head.js) pour que le prompt reste autonome et lisible.
 */
function describeHeadForPrompt(angle) {
  const a = Math.abs(angle);
  if (a === 0) return 'tête droite : l’effet est entièrement top-spin ou back-spin.';
  const cote = angle < 0 ? 'gauche' : 'droite';
  if (a >= 75) return `tête quasiment à 90° vers la ${cote} : l’effet est presque purement latéral.`;
  if (a >= 45) return `tête nettement tournée vers la ${cote} : l’effet est mixte, moitié latéral.`;
  return `tête légèrement tournée vers la ${cote} : l’effet reste surtout top/back-spin.`;
}

/** Extrait un objet JSON d'une réponse de modèle, même entourée de texte. */
export function parseModelJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('réponse vide');

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    // Repli : on isole la première accolade ouvrée et la dernière fermante.
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error(`réponse non JSON : ${raw.slice(0, 200)}`);
  }
}

/** Traduit un statut HTTP en message actionnable. */
function httpErrorMessage(status, body) {
  const detail = (() => {
    try {
      const parsed = JSON.parse(body);
      return parsed?.error?.message || parsed?.message || body;
    } catch {
      return body;
    }
  })();
  switch (status) {
    case 401:
      return `DeepSeek a refusé la clé API (401). Vérifie DEEPSEEK_API_KEY dans le fichier .env.\n${detail}`;
    case 402:
      return `Compte DeepSeek sans solde suffisant (402). Recharge le compte ou change de clé.\n${detail}`;
    case 429:
      return `Limite de débit atteinte chez DeepSeek (429). Réessaie dans quelques secondes.\n${detail}`;
    case 400:
      return `Requête refusée par DeepSeek (400) : le modèle demandé est peut-être invalide.\n${detail}`;
    default:
      return `Erreur DeepSeek (${status}) : ${detail}`;
  }
}

/**
 * Envoie une requête à l'API et renvoie la réponse HTTP brute.
 * Isolé pour pouvoir rejouer l'appel avec des paramètres réduits.
 */
async function postCompletion({ baseUrl, apiKey, body, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`DeepSeek n'a pas répondu en ${Math.round(timeoutMs / 1000)} s (délai dépassé).`);
    }
    throw new Error(`Impossible de joindre DeepSeek (${baseUrl}) : ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * L'API refuse `temperature` ou `response_format` pour certains modèles.
 * On ne parie pas sur une liste de noms — qui a déjà changé une fois — on
 * essaie, et on retire le paramètre fautif si le serveur le rejette.
 */
function unsupportedParameter(body, status, rawText) {
  if (status !== 400) return null;
  const text = String(rawText).toLowerCase();
  if (text.includes('response_format') || text.includes('json_object')) return 'response_format';
  if (text.includes('temperature')) return 'temperature';
  return null;
}

/**
 * Appelle l'API DeepSeek.
 *
 * @returns {Promise<{content: string, reasoning: string|null, usage: object|null, model: string, degraded: string[]}>}
 */
export async function chatCompletion({
  apiKey,
  baseUrl,
  model,
  messages,
  timeoutMs = 120000,
  fetchImpl = globalThis.fetch,
  temperature = 0.3,
  jsonMode = true,
}) {
  if (!apiKey) {
    throw new Error(
      'Aucune clé API DeepSeek. Crée un fichier .env à partir de .env.example et renseigne ' +
        'DEEPSEEK_API_KEY, ou utilise --template pour partir d’un gabarit sans IA.',
    );
  }

  // Le mode JSON de DeepSeek exige que le mot « json » apparaisse dans la
  // conversation, sinon l'API répond 400. Le prompt système le contient : on le
  // vérifie pour échouer ici, avec un message clair, plutôt qu'au fond du réseau.
  if (jsonMode) {
    const mentionsJson = messages.some((m) => String(m.content ?? '').toLowerCase().includes('json'));
    if (!mentionsJson) {
      throw new Error(
        'Le mode JSON de DeepSeek exige que le mot « json » apparaisse dans le prompt. ' +
          'Ajoute-le, ou appelle avec jsonMode: false.',
      );
    }
  }

  const fullBody = { model, messages, stream: false };
  fullBody.temperature = temperature;
  if (jsonMode) fullBody.response_format = { type: 'json_object' };

  const degraded = [];
  let body = fullBody;
  let response = await postCompletion({ baseUrl, apiKey, body, timeoutMs, fetchImpl });
  let text = await response.text();

  // Un modèle peut refuser temperature ou response_format : on réessaie sans.
  for (let attempt = 0; attempt < 2; attempt++) {
    const offending = unsupportedParameter(body, response.status, text);
    if (!offending) break;
    degraded.push(offending);
    const reduced = { ...body };
    delete reduced[offending];
    body = reduced;
    response = await postCompletion({ baseUrl, apiKey, body, timeoutMs, fetchImpl });
    text = await response.text();
  }

  if (!response.ok) throw new Error(httpErrorMessage(response.status, text));

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Réponse DeepSeek illisible : ${text.slice(0, 300)}`);
  }

  const message = payload?.choices?.[0]?.message ?? {};
  const content = message.content;
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : null;

  if (typeof content !== 'string' || !content.trim()) {
    // deepseek-flash et deepseek-v4-pro raisonnent avant de répondre : si le
    // budget de sortie est absorbé par le raisonnement, le contenu final est
    // vide. C'est la cause la plus probable, et elle mérite un message qui
    // oriente vers la solution plutôt qu'un « réponse illisible ».
    const reasoningTokens = payload?.usage?.completion_tokens_details?.reasoning_tokens;
    const suffix = reasoning != null
      ? ` Le modèle a raisonné (${reasoningTokens ?? '?'} jetons) mais n’a pas conclu : ` +
        'le budget de sortie est probablement épuisé. Reformule la demande, ou essaie un autre modèle.'
      : ` Réponse brute : ${text.slice(0, 300)}`;
    throw new Error(`Réponse DeepSeek sans contenu exploitable.${suffix}`);
  }

  return {
    content,
    reasoning,
    usage: payload.usage ?? null,
    model: payload.model ?? model,
    degraded,
  };
}

/**
 * Génère un exercice à partir d'une demande en langage naturel, puis le valide.
 * En cas de JSON invalide ou de paramètres hors bornes, le modèle est rappelé
 * avec la liste des erreurs pour qu'il se corrige.
 *
 * @returns {Promise<{name, summary, coachingNotes, tags, drill, meta}>}
 */
export async function generateDrill(description, options = {}) {
  const {
    apiKey,
    baseUrl = 'https://api.deepseek.com',
    model = DEFAULT_MODEL,
    timeoutMs = 120000,
    maxRepairAttempts = 2,
    fetchImpl = globalThis.fetch,
    onAttempt = null,
    headAngle = 0,
    setup = null,
    extraContext = null,
  } = options;

  if (!description || !String(description).trim()) {
    throw new Error('Décris l’exercice que tu veux travailler.');
  }

  const messages = [
    { role: 'system', content: buildSystemPrompt({ headAngle, setup }) },
    {
      role: 'user',
      content: extraContext
        ? `${String(description).trim()}\n\n(Contexte matériel : ${extraContext})`
        : String(description).trim(),
    },
  ];

  const attempts = [];
  let lastError = null;

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    const completion = await chatCompletion({ apiKey, baseUrl, model, messages, timeoutMs, fetchImpl });
    attempts.push({ attempt: attempt + 1, usage: completion.usage, degraded: completion.degraded ?? [] });

    let parsed;
    try {
      parsed = parseModelJson(completion.content);
    } catch (err) {
      lastError = `Le JSON est illisible : ${err.message}`;
      onAttempt?.({ attempt: attempt + 1, ok: false, error: lastError });
      messages.push({ role: 'assistant', content: completion.content });
      messages.push({
        role: 'user',
        content:
          `Ta réponse n'était pas un objet JSON valide (${err.message}). ` +
          'Renvoie UNIQUEMENT l’objet JSON demandé, sans texte ni balises Markdown.',
      });
      continue;
    }

    let built;
    try {
      built = buildDrill({
        balls: parsed.balls,
        mode: parsed.mode ?? 'endless',
        modeValue: parsed.modeValue,
        random: parsed.random,
      });
    } catch (err) {
      lastError = err.message;
      onAttempt?.({ attempt: attempt + 1, ok: false, error: lastError });
      messages.push({ role: 'assistant', content: completion.content });
      messages.push({
        role: 'user',
        content:
          `Cet exercice est refusé par le robot :\n${err.message}\n\n` +
          'Corrige les paramètres et renvoie l’objet JSON complet. Rappel des bornes : ' +
          Object.entries(RANGES)
            .map(([k, r]) => `${k} ∈ [${r.min}, ${r.max}] pas ${r.step}`)
            .join(' ; ') +
          '. Et rappel : pour une vitesse donnée, le spin est plafonné (vitesse 8 → 4, vitesse 9 → 2, vitesse 10 → 0).',
      });
      continue;
    }

    const check = validateDrill(built.drill);
    if (!check.ok) {
      lastError = check.errors.join(' ; ');
      onAttempt?.({ attempt: attempt + 1, ok: false, error: lastError });
      messages.push({ role: 'assistant', content: completion.content });
      messages.push({
        role: 'user',
        content: `L’exercice ne passe pas la validation :\n- ${check.errors.join('\n- ')}\n\nRenvoie l’objet JSON corrigé.`,
      });
      continue;
    }

    onAttempt?.({ attempt: attempt + 1, ok: true });

    return {
      name: (parsed.name || 'Exercice généré').trim(),
      summary: (parsed.summary || '').trim(),
      coachingNotes: (parsed.coachingNotes || '').trim(),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean) : [],
      drill: built.drill,
      adjustments: built.adjustments,
      warnings: check.warnings,
      meta: {
        model: completion.model,
        attempts: attempts.length,
        usage: attempts.reduce(
          (acc, a) => ({
            promptTokens: acc.promptTokens + (a.usage?.prompt_tokens ?? 0),
            completionTokens: acc.completionTokens + (a.usage?.completion_tokens ?? 0),
            reasoningTokens: acc.reasoningTokens + (a.usage?.completion_tokens_details?.reasoning_tokens ?? 0),
            totalTokens: acc.totalTokens + (a.usage?.total_tokens ?? 0),
          }),
          { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, totalTokens: 0 },
        ),
        // Paramètres retirés parce que le modèle les refuse (vide en pratique).
        degraded: [...new Set(attempts.flatMap((a) => a.degraded ?? []))],
        request: { baseUrl, model, temperature: 0.3 },
      },
    };
  }

  throw new Error(
    `DeepSeek n’a pas produit d’exercice valide après ${maxRepairAttempts + 1} tentative(s).\n` +
      `Dernière erreur : ${lastError}\n` +
      'Essaie de reformuler ta demande, ou pars d’un gabarit avec --template.',
  );
}
