/**
 * Librairie d'exercices en ligne partagée.
 *
 * C'est celle du client d'olanga/nova : une instance PocketBase publique à
 * l'adresse ci-dessous, où chaque exercice est identifié par un code de partage
 * de six caractères (trois lettres puis trois chiffres, par exemple « JOB857 »).
 *
 *   POST {API}   { share_code, drill_data }   → publier
 *   GET  {API}?filter=(share_code='XXX')      → retrouver par code
 *   GET  {API}?perPage=N                      → parcourir
 *
 * Deux précautions :
 *   - ce serveur n'est pas le nôtre et peut disparaître ; on ne s'en sert que
 *     pour échanger des exercices, jamais comme stockage principal ;
 *   - publier un exercice, c'est le rendre PUBLIC. L'interface doit le dire
 *     clairement avant l'envoi.
 */

export const SHARED_API_URL = 'https://nova.varandal.de/api/collections/shared_drills/records';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';

/** Code de partage : trois lettres puis trois chiffres. */
export function generateShareCode() {
  let out = '';
  for (let i = 0; i < 3; i++) out += LETTERS[Math.floor(Math.random() * LETTERS.length)];
  for (let i = 0; i < 3; i++) out += DIGITS[Math.floor(Math.random() * DIGITS.length)];
  return out;
}

/** Un code valide a exactement trois lettres suivies de trois chiffres. */
export function isValidShareCode(code) {
  return /^[A-Za-z]{3}\d{3}$/.test(String(code ?? '').trim());
}

export function normalizeShareCode(code) {
  return String(code ?? '').trim().toUpperCase();
}

/** Message d'erreur lisible pour un échec réseau ou HTTP. */
function networkError(err, action) {
  if (err?.name === 'AbortError') return new Error(`Délai dépassé en essayant de ${action}.`);
  return new Error(`Impossible de ${action} : ${err?.message ?? err}`);
}

async function request(url, { fetchImpl, timeoutMs, ...init }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parcourt la librairie en ligne.
 *
 * @returns {Promise<{items: object[], total: number, page: number, perPage: number}>}
 */
export async function listSharedDrills({
  page = 1,
  perPage = 30,
  search = '',
  sort = '-created',
  apiUrl = SHARED_API_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  const params = new URLSearchParams({
    page: String(Math.max(1, page)),
    perPage: String(Math.min(100, Math.max(1, perPage))),
    sort,
  });
  if (search && search.trim()) {
    // PocketBase attend la syntaxe de son propre filtre.
    const needle = search.trim().replace(/'/g, '');
    params.set('filter', `(name~'${needle}'||share_code~'${needle.toUpperCase()}')`);
  }

  let response;
  try {
    response = await request(`${apiUrl}?${params}`, { fetchImpl, timeoutMs });
  } catch (err) {
    throw networkError(err, 'joindre la librairie en ligne');
  }
  if (!response.ok) {
    throw new Error(`La librairie en ligne a répondu ${response.status}.`);
  }

  const json = await response.json();
  return {
    items: Array.isArray(json.items) ? json.items : [],
    total: json.totalItems ?? json.items?.length ?? 0,
    page: json.page ?? page,
    perPage: json.perPage ?? perPage,
  };
}

/** Récupère un exercice partagé par son code. Renvoie `null` s'il n'existe pas. */
export async function getSharedDrill(code, {
  apiUrl = SHARED_API_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
} = {}) {
  const clean = normalizeShareCode(code);
  if (!isValidShareCode(clean)) {
    throw new Error(
      `Code de partage invalide : « ${code} ». Attendu : trois lettres puis trois chiffres, par exemple JOB857.`,
    );
  }

  const url = `${apiUrl}?filter=${encodeURIComponent(`(share_code='${clean}')`)}`;
  let response;
  try {
    response = await request(url, { fetchImpl, timeoutMs });
  } catch (err) {
    throw networkError(err, 'joindre la librairie en ligne');
  }
  if (!response.ok) throw new Error(`La librairie en ligne a répondu ${response.status}.`);

  const json = await response.json();
  const item = Array.isArray(json.items) ? json.items[0] : null;
  if (!item) return null;
  return {
    code: item.share_code,
    id: item.id,
    created: item.created,
    updated: item.updated,
    data: item.drill_data,
  };
}

/** Le code est-il déjà pris ? En cas de doute réseau, on répond « oui ». */
async function codeExists(code, { apiUrl, fetchImpl, timeoutMs }) {
  try {
    const url = `${apiUrl}?filter=${encodeURIComponent(`(share_code='${code}')`)}&fields=id`;
    const response = await request(url, { fetchImpl, timeoutMs });
    if (!response.ok) return true;
    const json = await response.json();
    return Array.isArray(json.items) && json.items.length > 0;
  } catch {
    return true;
  }
}

/**
 * Publie un exercice sur la librairie en ligne.
 *
 * ⚠ L'exercice devient PUBLIC. L'appelant doit avoir prévenu l'utilisateur.
 *
 * @returns {Promise<{code: string}>}
 */
export async function publishSharedDrill(payload, {
  apiUrl = SHARED_API_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 20000,
  maxAttempts = 6,
} = {}) {
  let code = null;
  for (let i = 0; i < maxAttempts && !code; i++) {
    const candidat = generateShareCode();
    // eslint-disable-next-line no-await-in-loop
    if (!(await codeExists(candidat, { apiUrl, fetchImpl, timeoutMs }))) code = candidat;
  }
  if (!code) {
    throw new Error(
      `Impossible de trouver un code de partage libre après ${maxAttempts} essais. ` +
        'La librairie en ligne est peut-être indisponible.',
    );
  }

  let response;
  try {
    response = await request(apiUrl, {
      fetchImpl,
      timeoutMs,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ share_code: code, drill_data: payload }),
    });
  } catch (err) {
    throw networkError(err, 'publier sur la librairie en ligne');
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Publication refusée (${response.status}). ${detail.slice(0, 200)}`);
  }
  return { code };
}

/** Résumé affichable d'un enregistrement partagé, sans le convertir entièrement. */
export function summarizeSharedItem(item) {
  const data = item?.drill_data ?? {};
  const params = Array.isArray(data.params) ? data.params : [];
  const balles = params.reduce((n, groupe) => n + (Array.isArray(groupe) ? groupe.length : 0), 0);
  return {
    code: item?.share_code ?? null,
    name: typeof data.name === 'string' ? data.name : '(sans nom)',
    level: data.level ?? 1,
    random: Boolean(data.random),
    balls: balles,
    created: item?.created ?? null,
  };
}
