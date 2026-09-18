/**
 * Tests de la configuration.
 *
 * Le test le plus important est celui de `loadConfig` : une version antérieure
 * passait le résultat de `loadEnv()` (des métadonnées) à `getConfig()`, si bien
 * que le fichier .env était silencieusement ignoré — plus de clé DeepSeek, plus
 * de répertoire de données. Ces tests verrouillent le comportement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getConfig, loadConfig, loadEnv, parseEnvFile, PROJECT_ROOT } from '../src/config.js';

const tmpRoot = join(PROJECT_ROOT, '.tmp-tests');
mkdirSync(tmpRoot, { recursive: true });

function withEnvFile(content, fn) {
  const dir = mkdtempSync(join(tmpRoot, 'env-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, content, 'utf8');
  try {
    return fn(envPath, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* Analyse du fichier                                                         */
/* -------------------------------------------------------------------------- */

test('parseEnvFile lit les affectations, les commentaires et les guillemets', () => {
  const parsed = parseEnvFile([
    '# un commentaire',
    '',
    'DEEPSEEK_API_KEY=sk-abc123',
    '  DEEPSEEK_MODEL = deepseek-v4-pro  ',
    'export NOVA_ADDRESS="AA:BB:CC:DD:EE:FF"',
    "NOVA_NAME_KEYWORDS='nova, pongbot'",
    'VALEUR_VIDE=',
    'AVEC_DIESE=sans#commentaire # mais ceci est un commentaire',
    'CLE_INVALIDE-ICI=ignore',
  ].join('\n'));

  assert.equal(parsed.DEEPSEEK_API_KEY, 'sk-abc123');
  assert.equal(parsed.DEEPSEEK_MODEL, 'deepseek-v4-pro');
  assert.equal(parsed.NOVA_ADDRESS, 'AA:BB:CC:DD:EE:FF');
  assert.equal(parsed.NOVA_NAME_KEYWORDS, 'nova, pongbot');
  assert.equal(parsed.VALEUR_VIDE, '');
  assert.equal(parsed.AVEC_DIESE, 'sans#commentaire');
  assert.equal(parsed.CLE_INVALIDE_ICI, undefined);
});

test('loadEnv ne remplace jamais une variable déjà présente', () => {
  withEnvFile('DEEPSEEK_API_KEY=depuis-le-fichier\nNOVA_ADDRESS=AA:AA:AA:AA:AA:AA\n', (envPath) => {
    const env = { DEEPSEEK_API_KEY: 'depuis-le-systeme' };
    const info = loadEnv({ envPath, env });

    assert.equal(env.DEEPSEEK_API_KEY, 'depuis-le-systeme', 'le système gagne');
    assert.equal(env.NOVA_ADDRESS, 'AA:AA:AA:AA:AA:AA', 'les autres sont reprises');
    assert.equal(info.present, true);
    assert.deepEqual(info.loaded, ['NOVA_ADDRESS'], 'seules les nouvelles clés sont listées');
  });
});

test('loadEnv signale un fichier absent sans échouer', () => {
  const info = loadEnv({ envPath: join(tmpRoot, 'inexistant.env'), env: {} });
  assert.equal(info.present, false);
  assert.deepEqual(info.loaded, []);
});

/* -------------------------------------------------------------------------- */
/* Configuration effective                                                    */
/* -------------------------------------------------------------------------- */

test('loadConfig applique réellement le contenu du fichier .env', () => {
  withEnvFile([
    'DEEPSEEK_API_KEY=sk-test-123',
    'DEEPSEEK_MODEL=deepseek-v4-pro',
    'DEEPSEEK_BASE_URL=https://exemple.test/v1/',
    'NOVA_ADDRESS=AA:BB:CC:DD:EE:FF',
    'NOVA_KEEPALIVE_MS=25000',
    'NOVA_NAME_KEYWORDS=nova,robot',
  ].join('\n'), (envPath) => {
    const config = loadConfig({ envPath, env: {} });

    assert.equal(config.deepseek.apiKey, 'sk-test-123');
    assert.equal(config.deepseek.model, 'deepseek-v4-pro');
    assert.equal(config.deepseek.baseUrl, 'https://exemple.test/v1', 'la barre oblique finale est retirée');
    assert.equal(config.robot.address, 'AA:BB:CC:DD:EE:FF');
    assert.equal(config.robot.keepaliveMs, 25000);
    assert.deepEqual(config.robot.nameKeywords, ['nova', 'robot']);
    assert.equal(config.env.present, true);
    assert.ok(config.env.loaded.includes('DEEPSEEK_API_KEY'));
  });
});

test('loadConfig expose le répertoire de données du .env', () => {
  withEnvFile(`NOVA_DATA_DIR=${join(tmpRoot, 'mes-donnees')}\n`, (envPath) => {
    const config = loadConfig({ envPath, env: {} });
    assert.equal(config.dataDir, join(tmpRoot, 'mes-donnees'));
  });
});

test('getConfig a des valeurs par défaut sûres', () => {
  const config = getConfig({});
  assert.equal(config.deepseek.apiKey, null, 'aucune clé par défaut');
  assert.equal(config.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(config.deepseek.model, 'deepseek-flash', 'deepseek-flash est le modèle par défaut');
  assert.equal(config.robot.address, null);
  assert.equal(config.robot.keepaliveMs, 10000);
  assert.deepEqual(config.robot.nameKeywords, ['nova', 'pongbot']);
  assert.equal(config.dataDir, join(PROJECT_ROOT, 'data'));
  assert.ok(config.deepseek.maxRepairAttempts >= 1);
});

test('getConfig retombe sur les valeurs par défaut si le .env est absurde', () => {
  const config = getConfig({
    NOVA_KEEPALIVE_MS: 'pas un nombre',
    DEEPSEEK_TIMEOUT_MS: '',
    NOVA_NAME_KEYWORDS: '',
  });
  assert.equal(config.robot.keepaliveMs, 10000);
  assert.equal(config.deepseek.timeoutMs, 120000);
  // Une valeur vide est traitée comme absente : on retombe sur les mots-clés
  // par défaut plutôt que de chercher un appareil dont le nom est vide.
  assert.deepEqual(config.robot.nameKeywords, ['nova', 'pongbot']);
});

/* -------------------------------------------------------------------------- */
/* Non-régression                                                             */
/* -------------------------------------------------------------------------- */

test('loadEnv ne renvoie PAS l’environnement : c’est loadConfig qu’il faut utiliser', () => {
  withEnvFile('DEEPSEEK_API_KEY=sk-abc\n', (envPath) => {
    const info = loadEnv({ envPath, env: {} });
    // C'est exactement le piège qui avait rendu le .env inopérant : les
    // métadonnées ne contiennent pas la clé.
    assert.equal(info.DEEPSEEK_API_KEY, undefined);

    const config = loadConfig({ envPath, env: {} });
    assert.equal(config.deepseek.apiKey, 'sk-abc', 'loadConfig, lui, la voit');
  });
});
