/**
 * Tests du CLI.
 *
 * On lance le vrai binaire en sous-processus dans un répertoire de données
 * isolé. C'est le seul moyen de vérifier ce que l'utilisateur voit vraiment :
 * le code de sortie, la sortie standard, et surtout ce qui atterrit sur le
 * disque (le bug du --dry-run qui enregistrait est passé inaperçu aux tests
 * unitaires).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PROJECT_ROOT } from '../src/config.js';
import { confirmDrillSend } from '../src/cli.js';

const run = promisify(execFile);
const CLI = join(PROJECT_ROOT, 'src', 'cli.js');
const WRAPPER = join(PROJECT_ROOT, 'nova');
const tmpRoot = join(PROJECT_ROOT, '.tmp-tests');
mkdirSync(tmpRoot, { recursive: true });

let dataDir;

/**
 * Environnement isolé pour les tests.
 *
 * NOVA_ENV_PATH pointe vers un fichier inexistant : sans cela, le .env réel du
 * projet (avec la vraie clé API) serait chargé et les tests ne seraient plus
 * hermétiques.
 */
function testEnv(overrides = {}) {
  return {
    ...process.env,
    NOVA_DATA_DIR: dataDir,
    NOVA_ENV_PATH: join(dataDir, 'aucun.env'),
    DEEPSEEK_API_KEY: '',
    NO_COLOR: '1',
    ...overrides,
  };
}

/** Exécute le CLI et renvoie { stdout, stderr, code }. */
async function nova(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: testEnv(),
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

/** Lit la bibliothèque directement sur le disque. */
const readLibrary = () => JSON.parse(readFileSync(join(dataDir, 'drills.json'), 'utf8'));

before(() => {
  dataDir = mkdtempSync(join(tmpRoot, 'cli-'));
});

after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

test('nova help liste les commandes et sort en 0', async () => {
  const { stdout, code } = await nova(['help']);
  assert.equal(code, 0);
  assert.match(stdout, /nova create/);
  assert.match(stdout, /nova send/);
  assert.match(stdout, /nova mcp/);
});

test('une commande inconnue échoue avec un code non nul', async () => {
  const { stderr, stdout, code } = await nova(['bidule']);
  assert.equal(code, 1);
  assert.match(stderr + stdout, /Commande inconnue/);
});

test('--dry-run génère mais N’ENREGISTRE RIEN', async () => {
  // Régression : une version antérieure passait par saveDrill pour « valider »,
  // ce qui écrivait l'exercice sur le disque malgré --dry-run.
  const dry = await nova(['create', '--template', 'echauffement-topspin', '--dry-run']);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /NON enregistré/);

  const listed = await nova(['list', '--json']);
  assert.equal(JSON.parse(listed.stdout).count, 0, 'la bibliothèque doit rester vide');
});

test('nova create --template enregistre l’exercice sous la clé du gabarit', async () => {
  const { stdout, code } = await nova(['create', '--template', 'retour-service-rapide']);
  assert.equal(code, 0);
  assert.match(stdout, /retour-service-rapide/);

  const lib = readLibrary();
  assert.equal(lib.drills.length, 1);
  assert.equal(lib.drills[0].id, 'retour-service-rapide');
  assert.equal(lib.drills[0].balls.length, 3);
  assert.equal(lib.drills[0].random, true);
  assert.equal(lib.drills[0].source, 'gabarit');
});

test('nova list expose un JSON exploitable', async () => {
  const { stdout, code } = await nova(['list', '--json']);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.drills[0].id, 'retour-service-rapide');
});

test('nova show --hex affiche le paquet binaire correct', async () => {
  const { stdout, code } = await nova(['show', 'retour-service-rapide', '--hex']);
  assert.equal(code, 0);
  assert.match(stdout, /3 balle\(s\)/);

  // Le paquet est affiché par tranches de 48 caractères : on recolle tout ce
  // qui suit la ligne d'en-tête.
  const lines = stdout.trim().split('\n');
  const header = lines.findIndex((l) => l.includes('Paquet 0x81'));
  assert.ok(header !== -1, 'la ligne d’en-tête du paquet doit être présente');
  const hex = lines.slice(header + 1).join('');
  assert.equal(hex.slice(0, 2), '81', 'commande NEW_DRILL');
  assert.equal(hex.slice(2, 6), '4c00', 'longueur 4 + 3×24 = 76');
  assert.equal(hex.slice(6, 8), '03', 'mode sans fin');
  assert.equal(hex.slice(8, 12), '0000', 'valeur de mode nulle pour « sans fin »');
  assert.equal(hex.slice(12, 14), '01', 'ordre aléatoire');
  assert.equal(hex.length, 79 * 2, '79 octets');
});

test('--name avec un nom DIFFÉRENT crée un second exercice', async () => {
  const { code } = await nova(['create', '--template', 'poussette-backspin', '--name', 'Un autre nom']);
  assert.equal(code, 0);
  assert.equal(readLibrary().drills.length, 2, 'aucun écrasement accidentel');
});

test('--name avec un nom EXACT existant remplace l’exercice', async () => {
  const before = readLibrary().drills.length;
  const { stdout, code } = await nova([
    'create', '--template', 'bloc-contre-topspin', '--name', 'Un autre nom',
  ]);
  assert.equal(code, 0);
  assert.match(stdout, /mis à jour/);
  assert.equal(readLibrary().drills.length, before, 'remplacement, pas ajout');

  const replaced = readLibrary().drills.find((d) => d.name === 'Un autre nom');
  assert.equal(replaced.balls.length, 2, 'le contenu vient bien du nouveau gabarit');
});

test('nova export produit le format CSV documenté', async () => {
  const { stdout, code } = await nova(['export', 'retour-service-rapide']);
  assert.equal(code, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines[0], 'Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps');
  assert.equal(lines.length, 4);
  // 9 / 2 demanderait 7329 tr/min : l'effet jouable est 1,5, et c'est ce qui
  // figure dans l'export — l'écran et le robot ne peuvent plus diverger.
  assert.match(lines[1], /^A;1;.*;9;1\.5;top;50;-6;70;1$/);
});

test('un export puis un import conservent les paramètres des balles', async () => {
  const csvPath = join(dataDir, 'export.csv');
  const exported = await nova(['export', 'retour-service-rapide', '-o', csvPath]);
  assert.equal(exported.code, 0);
  assert.ok(readFileSync(csvPath, 'utf8').includes('Set;Ball;Name'));

  const imported = await nova(['import', csvPath, '--name', 'Import test']);
  assert.equal(imported.code, 0);
  assert.match(imported.stdout, /3 balles/);

  const record = readLibrary().drills.find((d) => d.name === 'Import test');
  assert.deepEqual(record.balls.map((b) => b.speed), [9, 9, 9]);
  assert.deepEqual(record.balls.map((b) => b.dropPoint), [-6, 0, 6]);
  assert.equal(record.source, 'csv');
});

test('nova send --dry-run n’envoie rien et affiche le paquet', async () => {
  const { stdout, code } = await nova(['send', 'retour-service-rapide', '--dry-run']);
  assert.equal(code, 0);
  assert.match(stdout, /rien n’a été envoyé/i);
  assert.match(stdout, /79 octets/);
  // Aucune tentative Bluetooth ne doit avoir eu lieu.
  assert.doesNotMatch(stdout, /Connexion au robot/);
});

test('un exercice introuvable propose les identifiants proches', async () => {
  const { stderr, stdout, code } = await nova(['show', 'retour-service']);
  assert.equal(code, 1);
  const output = stderr + stdout;
  assert.match(output, /introuvable/);
  assert.match(output, /retour-service-rapide/, 'l’identifiant proche doit être suggéré');
});

test('nova delete supprime avec --yes', async () => {
  const before = readLibrary().drills.length;
  const { code } = await nova(['delete', 'retour-service-rapide', '--yes']);
  assert.equal(code, 0);
  assert.equal(readLibrary().drills.length, before - 1);
});

test('nova templates liste les gabarits en JSON', async () => {
  const { stdout, code } = await nova(['templates', '--json']);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(parsed.length >= 5);
  assert.ok(parsed.some((t) => t.key === 'retour-service-rapide'));
});

test('nova create sans description explique quoi faire', async () => {
  const { stderr, stdout, code } = await nova(['create']);
  assert.equal(code, 1);
  assert.match(stderr + stdout, /Décris l’exercice/);
});

test('nova create avec gabarit inconnu liste les gabarits valides', async () => {
  const { stderr, stdout, code } = await nova(['create', '--template', 'inexistant']);
  assert.equal(code, 1);
  assert.match(stderr + stdout, /Gabarit inconnu/);
  assert.match(stderr + stdout, /echauffement-topspin/);
});

test('une option inconnue est refusée', async () => {
  const { stderr, stdout, code } = await nova(['list', '--bidule']);
  assert.equal(code, 1);
  assert.match(stderr + stdout, /Option inconnue/);
});

test('l’entrée standard permet d’importer un CSV sans fichier', async () => {
  const csv = [
    'Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps',
    'C;1;Depuis stdin;5;0;top;50;0;50;1',
  ].join('\n');

  const child = run(process.execPath, [CLI, 'import', '--name', 'Depuis stdin'], { env: testEnv() });
  child.child.stdin.end(csv);
  const { stdout } = await child;

  assert.match(stdout, /depuis-stdin/, 'l’identifiant dérivé du nom est affiché');
  const record = readLibrary().drills.find((d) => d.id === 'depuis-stdin');
  assert.ok(record, 'l’exercice doit être enregistré');
  assert.equal(record.name, 'Depuis stdin');
  assert.equal(record.balls.length, 1);
});


/* -------------------------------------------------------------------------- */
/* Le lanceur « nova »                                                        */
/* -------------------------------------------------------------------------- */

test('le lanceur fonctionne avec « ./nova » ET avec « node nova »', async () => {
  // Régression : « nova » était un script shell. `node nova doctor` échouait
  // alors sur une SyntaxError incompréhensible (le commentaire français était
  // lu comme du JavaScript). Le lanceur est désormais du JavaScript, et
  // l'import dynamique le rend valide en CommonJS comme en ESM.
  for (const [label, args] of [['exécution directe', [WRAPPER, 'help']], ['via node', [WRAPPER, 'help']]]) {
    const { stdout, code } = await run(process.execPath, args, { env: testEnv(), maxBuffer: 8 * 1024 * 1024 })
      .then((r) => ({ ...r, code: 0 }))
      .catch((e) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }));
    assert.equal(code, 0, `${label} doit réussir`);
    assert.match(stdout, /nova create/, `${label} doit afficher l’aide`);
  }
});

test('le lanceur atteint bien la bibliothèque depuis un autre répertoire', async () => {
  // Les chemins relatifs du lanceur doivent se résoudre par rapport à SA
  // position, pas au répertoire courant.
  const { stdout, code } = await run(process.execPath, [WRAPPER, 'list', '--json'], {
    cwd: PROJECT_ROOT === '/' ? '/' : join(PROJECT_ROOT, 'src'),
    env: testEnv(),
    maxBuffer: 8 * 1024 * 1024,
  }).then((r) => ({ ...r, code: 0 })).catch((e) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }));

  assert.equal(code, 0);
  const parsed = JSON.parse(stdout);
  assert.ok(Array.isArray(parsed.drills));
});


/* -------------------------------------------------------------------------- */
/* Confirmation avant envoi                                                   */
/* -------------------------------------------------------------------------- */

test('la confirmation est demandée en interactif et « n » annule', async () => {
  const record = { name: 'Mon exercice' };
  const asked = [];
  const askFn = async (question) => { asked.push(question); return 'n'; };

  assert.equal(await confirmDrillSend(record, { interactive: true, askFn }), false);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Mon exercice/);
});

test('Entrée seule, « oui » ou « O » valident l’envoi', async () => {
  for (const answer of ['', 'o', 'O', 'oui', 'y', 'yes', '  ']) {
    const ok = await confirmDrillSend({ name: 'X' }, { interactive: true, askFn: async () => answer });
    assert.equal(ok, true, `« ${answer} » doit valider`);
  }
});

test('--yes n’affiche aucune question', async () => {
  let called = false;
  const ok = await confirmDrillSend({ name: 'X' }, {
    yes: true,
    interactive: true,
    askFn: async () => { called = true; return 'n'; },
  });
  assert.equal(ok, true);
  assert.equal(called, false, 'aucune question ne doit être posée');
});

test('sans terminal (script, client MCP) on n’attend jamais de réponse', async () => {
  // Régression : une question posée hors terminal bloquerait indéfiniment.
  let called = false;
  const ok = await confirmDrillSend({ name: 'X' }, {
    interactive: false,
    askFn: async () => { called = true; return 'n'; },
  });
  assert.equal(ok, true);
  assert.equal(called, false, 'aucune question ne doit être posée hors terminal');
});

test('la bibliothèque reste lisible après toutes ces écritures', async () => {
  const lib = readLibrary();
  assert.ok(Array.isArray(lib.drills));
  assert.equal(lib.version, 1);
  for (const d of lib.drills) {
    assert.ok(d.id && d.name && Array.isArray(d.balls) && d.balls.length > 0);
  }
});

/* -------------------------------------------------------------------------- */
/* Persistance du fichier .env                                                */
/* -------------------------------------------------------------------------- */

test('un .env est réellement pris en compte par le CLI', async () => {
  // Régression : le CLI passait les métadonnées de loadEnv() à getConfig(),
  // si bien que la clé et le répertoire de données étaient ignorés.
  const dir = mkdtempSync(join(tmpRoot, 'cli-env-'));
  const envPath = join(dir, '.env');
  writeFileSync(envPath, `NOVA_DATA_DIR=${join(dir, 'donnees')}\nDEEPSEEK_MODEL=deepseek-v4-pro\n`, 'utf8');

  try {
    // On démarre SANS NOVA_DATA_DIR : seul le .env peut le fournir.
    const { stdout } = await run(process.execPath, [CLI, 'doctor', '--json'], {
      env: { ...process.env, NOVA_DATA_DIR: '', DEEPSEEK_API_KEY: '', NO_COLOR: '1', NOVA_ENV_PATH: envPath },
      maxBuffer: 8 * 1024 * 1024,
    });
    const report = JSON.parse(stdout);
    const library = report.checks.find((c) => c.label === 'Bibliothèque d’exercices');
    assert.match(library.detail, new RegExp(join(dir, 'donnees').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
