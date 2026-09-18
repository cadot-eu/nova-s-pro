/**
 * Chargement de la configuration.
 *
 * Les variables déjà présentes dans l'environnement gagnent toujours : un
 * fichier .env ne doit jamais écraser ce que le système a explicitement fourni.
 * Le fichier .env vit à la racine du projet et n'est jamais versionné.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..');

/**
 * Analyse un contenu .env. Gère les commentaires, les lignes vides, un
 * éventuel préfixe `export`, et les guillemets simples ou doubles.
 */
export function parseEnvFile(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      // Un commentaire en fin de ligne non quotée est retiré.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Charge le .env du projet sans écraser l'environnement existant.
 *
 * Une variable présente mais VIDE est traitée comme absente : c'est ce qu'on
 * attend d'un .env, et cela évite qu'un `NOVA_DATA_DIR=` vide dans
 * l'environnement masque la valeur renseignée dans le fichier.
 */
export function loadEnv({ envPath = join(PROJECT_ROOT, '.env'), env = process.env } = {}) {
  if (!existsSync(envPath)) return { path: envPath, loaded: [], present: false };
  const parsed = parseEnvFile(readFileSync(envPath, 'utf8'));
  const loaded = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      loaded.push(key);
    }
  }
  return { path: envPath, loaded, present: true };
}
/**
 * Modèles exposés par l'API DeepSeek.
 *
 * Vérifié sur https://api.deepseek.com/models : seuls ces deux identifiants
 * existent. Les anciens noms « deepseek-chat » et « deepseek-reasoner » ne sont
 * plus documentés — « deepseek-chat » est encore accepté comme alias de
 * « deepseek-flash », mais mieux vaut utiliser le vrai nom.
 *
 * Les deux modèles raisonnent avant de répondre et acceptent temperature et
 * response_format.
 */
export const DEEPSEEK_MODELS = Object.freeze({
  flash: 'deepseek-flash',
  pro: 'deepseek-v4-pro',
});

export const DEFAULT_MODEL = DEEPSEEK_MODELS.flash;

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

/** Construit la configuration effective à partir de l'environnement. */
export function getConfig(env = process.env) {
  return {
    deepseek: {
      apiKey: env.DEEPSEEK_API_KEY || null,
      baseUrl: (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
      model: env.DEEPSEEK_MODEL || DEFAULT_MODEL,
      timeoutMs: int(env.DEEPSEEK_TIMEOUT_MS, 120000),
      maxRepairAttempts: int(env.DEEPSEEK_REPAIR_ATTEMPTS, 2),
    },
    robot: {
      address: env.NOVA_ADDRESS || null,
      scanTimeoutMs: int(env.NOVA_SCAN_TIMEOUT_MS, 12000),
      connectTimeoutMs: int(env.NOVA_CONNECT_TIMEOUT_MS, 20000),
      keepaliveMs: int(env.NOVA_KEEPALIVE_MS, 10000),
      nameKeywords: (env.NOVA_NAME_KEYWORDS || 'nova,pongbot').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    },
    web: {
      port: int(env.NOVA_WEB_PORT, 4173),
      host: env.NOVA_WEB_HOST || '127.0.0.1',
    },
    dataDir: env.NOVA_DATA_DIR ? resolve(env.NOVA_DATA_DIR) : join(PROJECT_ROOT, 'data'),
    projectRoot: PROJECT_ROOT,
  };
}

/**
 * Charge le .env puis construit la configuration.
 *
 * C'est LE point d'entrée à utiliser : `loadEnv()` renvoie des métadonnées sur
 * le fichier, pas l'environnement. Passer son résultat à `getConfig()` donne une
 * configuration vide — l'erreur est silencieuse et coûteuse (clé API et
 * répertoire de données ignorés), donc on ne laisse plus la possibilité de se
 * tromper.
 *
 * @returns {ReturnType<typeof getConfig> & { env: {path: string, loaded: string[], present: boolean} }}
 */
export function loadConfig({ envPath, env } = {}) {
  // NOVA_ENV_PATH permet de pointer vers un autre fichier .env (utile pour les
  // tests et pour garder plusieurs profils de configuration).
  const target = envPath ?? process.env.NOVA_ENV_PATH ?? null;
  const info = loadEnv({ ...(target ? { envPath: target } : {}), ...(env ? { env } : {}) });
  return { ...getConfig(env ?? process.env), env: info };
}
