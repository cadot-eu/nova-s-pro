/**
 * Test de bout en bout du serveur MCP.
 *
 * On lance le vrai serveur en sous-processus et on lui parle avec un vrai client
 * MCP. C'est ce qui permet d'attraper les erreurs qu'un test unitaire ne voit
 * pas : point d'entrée manquant, journalisation qui pollue stdout, configuration
 * qui n'atteint pas le serveur.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { PROJECT_ROOT } from '../src/config.js';
import { TOOL_NAMES } from '../src/mcp.js';

const tmpRoot = join(PROJECT_ROOT, '.tmp-tests');
mkdirSync(tmpRoot, { recursive: true });

let client;
let dataDir;
let stderrChunks = [];

/** Appelle un outil et renvoie son texte concaténé. */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, isError: Boolean(res.isError), raw: res };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpRoot, 'mcp-'));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(PROJECT_ROOT, 'src', 'mcp.js')],
    env: {
      ...process.env,
      NOVA_DATA_DIR: dataDir,
      // Isolation : sans ce chemin, le .env réel du projet serait chargé et
      // fournirait une vraie clé API, ce qui rendrait le test dépendant du
      // réseau et ferait échouer la vérification du mode dégradé.
      NOVA_ENV_PATH: join(dataDir, 'aucun.env'),
      DEEPSEEK_API_KEY: '',
      NO_COLOR: '1',
    },
    stderr: 'pipe',
  });

  client = new Client({ name: 'test-novakontrol', version: '1.0.0' });
  await client.connect(transport);
  transport.stderr?.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));
});

after(async () => {
  await client?.close().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

test('le serveur MCP expose tous les outils attendus', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...TOOL_NAMES].sort());

  // Chaque outil doit être décrit : c'est ce que le modèle lit pour choisir.
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} doit avoir une description utile`);
  }
});

test('describe_parameters expose les bornes et les limites matérielles', async () => {
  const { text, isError } = await call('describe_parameters');
  assert.equal(isError, false);
  const parsed = JSON.parse(text);
  assert.equal(parsed.ranges.speed.max, 10);
  assert.equal(parsed.ranges.dropPoint.min, -10);
  assert.match(parsed.dropPointSign, /négatif = à droite/);
  assert.ok(parsed.hardwareLimits.some((l) => /effet latéral/.test(l)));
  assert.ok(parsed.hardwareLimits.some((l) => /Bluetooth LE, pas infrarouge/.test(l)));
});

test('la bibliothèque démarre vide puis se remplit via create_from_template', async () => {
  const empty = await call('list_drills');
  assert.equal(empty.isError, false);
  assert.match(empty.text, /vide/);

  const created = await call('create_from_template', { template: 'retour-service-rapide' });
  assert.equal(created.isError, false);
  assert.match(created.text, /retour-service-rapide/);
  assert.match(created.text, /ordre aléatoire/);

  const listed = await call('list_drills');
  assert.match(listed.text, /Retour de services rapides/);
});

test('get_status confirme que le serveur utilise bien le répertoire de données imposé', async () => {
  // Régression : le serveur ignorait auparavant NOVA_DATA_DIR et le .env.
  const { text } = await call('get_status');
  const status = JSON.parse(text);
  assert.equal(status.library.path, join(dataDir, 'drills.json'));
  assert.equal(status.deepseekConfigured, false, 'aucune clé ne doit être détectée ici');
  assert.equal(status.robot.connected, false);
});

test('list_templates décrit les gabarits disponibles', async () => {
  const { text } = await call('list_templates');
  assert.match(text, /retour-service-rapide/);
  assert.match(text, /echauffement-topspin/);
});

test('get_drill renvoie le paquet binaire qui sera envoyé', async () => {
  const { text, isError } = await call('get_drill', { ref: 'retour-service-rapide' });
  assert.equal(isError, false);
  assert.match(text, /Paquet 0x81 : 79 octets/);
  const hex = text.trim().split('\n').at(-1);
  assert.match(hex, /^81[0-9a-f]+$/);
  assert.equal(hex.slice(0, 2), '81');
  // 4 + 3×24 = 76 = 0x4c
  assert.equal(hex.slice(2, 6), '4c00');
});

test('un exercice introuvable produit une erreur exploitable avec des suggestions', async () => {
  const { text, isError } = await call('get_drill', { ref: 'retour-service' });
  assert.equal(isError, true);
  assert.match(text, /Aucun exercice ne correspond/);
  assert.match(text, /retour-service-rapide/, 'l’identifiant proche doit être proposé');
});

test('export_drill produit le format d’olanga/nova', async () => {
  const { text, isError } = await call('export_drill', { ref: 'retour-service-rapide', set: 'B' });
  assert.equal(isError, false);
  const lines = text.trim().split('\n');
  assert.equal(lines[0], 'Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps');
  assert.match(lines[1], /^B;1;/);
  assert.equal(lines.length, 4, 'une ligne d’en-tête plus trois balles');
});

test('export_drill produit aussi le format texte de smee', async () => {
  const { text, isError } = await call('export_drill', { ref: 'retour-service-rapide', format: 'smee' });
  assert.equal(isError, false);
  const lignes = text.trim().split('\n');
  assert.equal(lignes.length, 3);
  // Six nombres par ligne : RPM haut, RPM bas, hauteur, chute, fréquence, reps.
  for (const ligne of lignes) {
    const champs = ligne.trim().split(/\s+/).map(Number);
    assert.equal(champs.length, 6, `ligne inattendue : ${ligne}`);
    assert.ok(champs.every(Number.isFinite));
    assert.ok(champs[0] >= 400 && champs[0] <= 7500);
    assert.ok(champs[1] >= 400 && champs[1] <= 7500);
  }
  assert.notEqual(lignes[0], lignes[1], 'les trois balles ont des chutes différentes');
});

test('import_drill enregistre un CSV (format détecté)', async () => {
  const csv = [
    'Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps',
    'C;1;Test import;6;3;top;45;-4;55;1',
    'C;2;Test import;6;3;top;45;4;55;1',
  ].join('\n');

  const imported = await call('import_drill', { content: csv, name: 'Exercice importé' });
  assert.equal(imported.isError, false);
  assert.match(imported.text, /2 balles, format csv/);

  const shown = await call('get_drill', { ref: 'exercice-importe' });
  assert.match(shown.text, /topspin 3\/10/);
});

test('import_drill enregistre un texte smee et signale l’écart de RPM', async () => {
  const smee = [
    '500   4000  -50   6   0  1',
    '1000, 4000,  20, 10, 30, 1 | 5000,  700,  40, -10, 20, 1 ; soit cd soit revers',
  ].join('\n');

  const imported = await call('import_drill', { content: smee, name: 'Depuis smee' });
  assert.equal(imported.isError, false);
  assert.match(imported.text, /format smee/);
  assert.match(imported.text, /variante/);
  assert.match(imported.text, /Écart maximal de .* tr\/min/);

  const shown = await call('get_drill', { ref: 'depuis-smee' });
  assert.match(shown.text, /3 balle\(s\)/);
  assert.match(shown.text, /aléatoire/, 'les variantes activent l’ordre aléatoire');
});

test('create_drill explique quoi faire quand aucune clé DeepSeek n’est configurée', async () => {
  const { text, isError } = await call('create_drill', { description: 'topspin rapide au milieu' });
  assert.equal(isError, true);
  assert.match(text, /Aucune clé DeepSeek/);
  assert.match(text, /create_from_template/, 'la solution de repli doit être indiquée');
  assert.match(text, /DEEPSEEK_API_KEY/);
});

test('delete_drill retire l’exercice', async () => {
  const deleted = await call('delete_drill', { ref: 'exercice-importe' });
  assert.equal(deleted.isError, false);

  const after = await call('get_drill', { ref: 'exercice-importe' });
  assert.equal(after.isError, true);
});

test('stop_drill hors connexion échoue proprement, sans planter le serveur', async () => {
  const { text, isError } = await call('stop_drill');
  assert.equal(isError, true);
  assert.match(text, /Non connecté/);

  // Le serveur doit toujours répondre après une erreur d'outil.
  const still = await call('list_drills');
  assert.equal(still.isError, false);
});


test('le lancement par « nova mcp » sert aussi le protocole', async () => {
  // Régression : `runMcpServer()` rendait la main juste après `connect()`, et le
  // `process.exit()` du CLI tuait le serveur avant qu'il ne réponde. Le test
  // ci-dessus lançait `src/mcp.js` directement et ne voyait donc rien.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(PROJECT_ROOT, 'src', 'cli.js'), 'mcp'],
    env: {
      ...process.env,
      NOVA_DATA_DIR: dataDir,
      NOVA_ENV_PATH: join(dataDir, 'aucun.env'),
      DEEPSEEK_API_KEY: '',
      NO_COLOR: '1',
    },
    stderr: 'pipe',
  });

  const cliClient = new Client({ name: 'test-cli-mcp', version: '1.0.0' });
  await cliClient.connect(transport);
  try {
    const { tools } = await cliClient.listTools();
    assert.equal(tools.length, TOOL_NAMES.length, 'le serveur lancé par le CLI doit exposer tous les outils');

    const res = await cliClient.callTool({ name: 'describe_parameters', arguments: {} });
    assert.equal(Boolean(res.isError), false);
    assert.match(res.content[0].text, /dropPoint/);
  } finally {
    await cliClient.close().catch(() => {});
  }
});

test('la sortie standard ne contient rien d’autre que le protocole MCP', async () => {
  // Le transport MCP lit stdout : toute ligne parasite casserait le protocole.
  // Si on est arrivé ici sans erreur de désérialisation, c'est déjà bon signe.
  // On vérifie en plus que les journaux partent bien sur stderr.
  await new Promise((r) => setTimeout(r, 100));
  const stderr = stderrChunks.join('');
  assert.match(stderr, /\[novakontrol\]/, 'le serveur doit journaliser sur stderr');
});
