/**
 * Tests de la détection du point d'entrée.
 *
 * La comparaison naïve `import.meta.url === \`file://${process.argv[1]}\`` est
 * fausse dans deux cas bien réels : un chemin contenant des espaces (l'URL est
 * échappée) et un lancement par lien symbolique (`npm link`). Ces tests
 * verrouillent les deux.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { isMainModule } from '../src/entrypoint.js';
import { PROJECT_ROOT } from '../src/config.js';

const tmpRoot = join(PROJECT_ROOT, '.tmp-tests');
let dir;

before(() => {
  mkdirSync(tmpRoot, { recursive: true });
  dir = mkdtempSync(join(tmpRoot, 'entry-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const urlOf = (path) => pathToFileURL(realpathSync(path)).href;

test('isMainModule reconnaît le fichier réellement exécuté', () => {
  const file = join(dir, 'reel.js');
  writeFileSync(file, '// rien\n', 'utf8');
  assert.equal(isMainModule(urlOf(file), file), true);
});

test('isMainModule rejette un autre fichier', () => {
  const a = join(dir, 'a.js');
  const b = join(dir, 'b.js');
  writeFileSync(a, '', 'utf8');
  writeFileSync(b, '', 'utf8');
  assert.equal(isMainModule(urlOf(a), b), false);
});

test('isMainModule fonctionne malgré les espaces dans le chemin', () => {
  const spaced = join(dir, 'mes scripts');
  mkdirSync(spaced, { recursive: true });
  const file = join(spaced, 'mon script.js');
  writeFileSync(file, '', 'utf8');

  assert.equal(isMainModule(urlOf(file), file), true);

  // C'est exactement ce que faisait l'ancienne comparaison, et pourquoi elle
  // échouait : l'URL réelle échappe les espaces en %20.
  assert.notEqual(urlOf(file), `file://${file}`);
  assert.match(urlOf(file), /%20/);
});

test('isMainModule suit les liens symboliques (npm link)', () => {
  const real = join(dir, 'cible.js');
  const link = join(dir, 'lien.js');
  writeFileSync(real, '', 'utf8');
  symlinkSync(real, link);

  // argv[1] vaut le lien, mais import.meta.url est le chemin réel résolu.
  assert.equal(isMainModule(urlOf(real), link), true);
  assert.equal(isMainModule(urlOf(link), link), true, 'les deux formes doivent être acceptées');
});

test('isMainModule ne lève pas sur un chemin absent ou vide', () => {
  assert.equal(isMainModule('file:///peu-importe', join(dir, 'inexistant.js')), false);
  assert.equal(isMainModule('file:///peu-importe', undefined), false);
  assert.equal(isMainModule('file:///peu-importe', ''), false);
});

test('les points d’entrée du projet sont bien détectés', () => {
  // Le vrai cli.js et le vrai mcp.js doivent être reconnus comme points
  // d'entrée ; c'est ce qui déclenche leur exécution.
  assert.equal(isMainModule(urlOf(join(PROJECT_ROOT, 'src', 'cli.js')), join(PROJECT_ROOT, 'src', 'cli.js')), true);
  assert.equal(isMainModule(urlOf(join(PROJECT_ROOT, 'src', 'mcp.js')), join(PROJECT_ROOT, 'src', 'mcp.js')), true);
});
