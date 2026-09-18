/**
 * Tests de la bibliothèque d'exercices : persistance, unicité des identifiants,
 * recherche, mise à jour, suppression.
 *
 * Chaque test travaille dans son propre dossier temporaire, sous le projet, pour
 * ne jamais toucher à la vraie bibliothèque de l'utilisateur.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  deleteDrill,
  findDrill,
  libraryPath,
  libraryStats,
  listDrills,
  loadLibrary,
  makeId,
  saveDrill,
  saveLibrary,
} from '../src/library.js';
import { PROJECT_ROOT } from '../src/config.js';

const tmpRoot = join(PROJECT_ROOT, '.tmp-tests');
mkdirSync(tmpRoot, { recursive: true });

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpRoot, 'lib-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const simpleBalls = [{ speed: 6, spin: 2, height: 50, dropPoint: -6, frequency: 60, reps: 1 }];

test('une bibliothèque absente se lit comme vide', () => {
  withTempDir((dir) => {
    const lib = loadLibrary(dir);
    assert.equal(lib.drills.length, 0);
    assert.equal(lib.version, 1);
  });
});

test('enregistrer puis relire un exercice', () => {
  withTempDir((dir) => {
    const { record } = saveDrill(dir, {
      name: 'Retour de service rapide',
      description: 'services rapides à droite, centre et gauche',
      balls: [
        { speed: 9, spin: 2, height: 50, dropPoint: -6, frequency: 70, reps: 1 },
        { speed: 9, spin: 2, height: 50, dropPoint: 0, frequency: 70, reps: 1 },
        { speed: 9, spin: 2, height: 50, dropPoint: 6, frequency: 70, reps: 1 },
      ],
      random: true,
      mode: 'endless',
      tags: ['service', 'rapidité'],
      source: 'deepseek',
    });

    assert.equal(record.id, 'retour-de-service-rapide');
    assert.equal(record.balls.length, 3);
    assert.equal(record.random, true);
    assert.equal(record.balls[0].dropPoint, -6);
    assert.ok(record.balls[0].topRpm > 0, 'les RPM calculés sont conservés');

    const lib = loadLibrary(dir);
    assert.equal(lib.drills.length, 1);
    assert.equal(lib.drills[0].name, 'Retour de service rapide');
    assert.equal(lib.drills[0].source, 'deepseek');
  });
});

test('les identifiants restent uniques malgré des noms identiques', () => {
  withTempDir((dir) => {
    for (let i = 0; i < 4; i++) saveDrill(dir, { name: 'Même nom', balls: simpleBalls });
    const ids = loadLibrary(dir).drills.map((d) => d.id);
    assert.equal(new Set(ids).size, 4, `identifiants dupliqués : ${ids.join(', ')}`);
    assert.equal(ids[0], 'meme-nom');
    assert.equal(ids[1], 'meme-nom-2');
  });
});

test('makeId translittère les accents et nettoie la ponctuation', () => {
  assert.equal(makeId('Échauffement top-spin !'), 'echauffement-top-spin');
  assert.equal(makeId('   '), 'exercice');
  assert.equal(makeId('a'.repeat(80)).length, 40);
});

test('findDrill trouve par identifiant, par nom exact, puis par nom partiel', () => {
  withTempDir((dir) => {
    saveDrill(dir, { name: 'Bloc contre top-spin', balls: simpleBalls });
    saveDrill(dir, { name: 'Poussette back-spin', balls: simpleBalls });
    const lib = loadLibrary(dir);

    assert.equal(findDrill(lib, 'bloc-contre-top-spin').name, 'Bloc contre top-spin');
    assert.equal(findDrill(lib, 'poussette back-spin').name, 'Poussette back-spin');
    assert.equal(findDrill(lib, 'poussette').name, 'Poussette back-spin');
    assert.equal(findDrill(lib, 'inexistant'), null);
  });
});

test('findDrill signale une référence ambiguë au lieu d’en choisir une', () => {
  withTempDir((dir) => {
    saveDrill(dir, { name: 'Top-spin revers', balls: simpleBalls });
    saveDrill(dir, { name: 'Top-spin coup droit', balls: simpleBalls });
    const lib = loadLibrary(dir);
    assert.throws(() => findDrill(lib, 'top-spin'), /correspond à plusieurs exercices/);
  });
});

test('mettre à jour un exercice conserve son identifiant et sa date de création', () => {
  withTempDir((dir) => {
    const { record: first } = saveDrill(dir, { name: 'Brouillon', balls: simpleBalls });
    const before = loadLibrary(dir).drills[0];

    const { record: updated } = saveDrill(
      dir,
      {
        name: 'Brouillon affiné',
        balls: [{ speed: 7, spin: 3, height: 45, dropPoint: 4, frequency: 65, reps: 2 }],
      },
      { overwriteId: first.id },
    );

    assert.equal(updated.id, first.id);
    assert.equal(updated.createdAt, before.createdAt);
    assert.equal(updated.balls[0].speed, 7);
    assert.equal(updated.balls[0].reps, 2);
    assert.equal(loadLibrary(dir).drills.length, 1, 'la mise à jour ne crée pas de doublon');
  });
});

test('supprimer un exercice le retire de la bibliothèque', () => {
  withTempDir((dir) => {
    saveDrill(dir, { name: 'À jeter', balls: simpleBalls });
    const removed = deleteDrill(dir, 'a-jeter');
    assert.equal(removed.name, 'À jeter');
    assert.equal(loadLibrary(dir).drills.length, 0);
    assert.throws(() => deleteDrill(dir, 'a-jeter'), /introuvable/);
  });
});

test('un exercice invalide est refusé à l’enregistrement', () => {
  withTempDir((dir) => {
    assert.throws(() => saveDrill(dir, { name: 'Vide', balls: [] }), /Aucune balle|au moins une balle/);
    assert.throws(
      () => saveDrill(dir, { name: 'Trop', balls: Array.from({ length: 21 }, () => simpleBalls[0]) }),
      /Trop de balles|trop de balles/,
    );
    assert.equal(loadLibrary(dir).drills.length, 0, 'rien ne doit avoir été écrit');
  });
});

test('le filtrage par étiquette et le tri fonctionnent', () => {
  withTempDir((dir) => {
    saveDrill(dir, { name: 'Alpha', balls: simpleBalls, tags: ['service'] });
    saveDrill(dir, { name: 'Beta', balls: simpleBalls, tags: ['déplacement'] });
    saveDrill(dir, { name: 'Gamma', balls: simpleBalls, tags: ['service', 'rapidité'] });

    assert.deepEqual(listDrills(dir, { tag: 'service' }).map((d) => d.name), ['Alpha', 'Gamma']);
    assert.deepEqual(listDrills(dir, { sort: 'name' }).map((d) => d.name), ['Alpha', 'Beta', 'Gamma']);
    assert.equal(listDrills(dir).length, 3);
  });
});

test('libraryStats résume le contenu', () => {
  withTempDir((dir) => {
    saveDrill(dir, {
      name: 'Deux balles',
      balls: [simpleBalls[0], { ...simpleBalls[0], dropPoint: 5 }],
      tags: ['service'],
    });
    const stats = libraryStats(dir);
    assert.equal(stats.count, 1);
    assert.equal(stats.balls, 2);
    assert.deepEqual(stats.tags, [['service', 1]]);
    assert.equal(stats.maxBalls, 20);
  });
});

test('une bibliothèque corrompue est signalée clairement', () => {
  withTempDir((dir) => {
    saveLibrary(dir, { drills: [] });
    writeFileSync(libraryPath(dir), '{ ceci n est pas du JSON', 'utf8');
    assert.throws(() => loadLibrary(dir), /Bibliothèque illisible/);

    writeFileSync(libraryPath(dir), JSON.stringify({ version: 1 }), 'utf8');
    assert.throws(() => loadLibrary(dir), /Bibliothèque corrompue/);
  });
});

test('l’écriture est atomique : le fichier final est toujours du JSON valide', () => {
  withTempDir((dir) => {
    for (let i = 0; i < 5; i++) {
      saveDrill(dir, { name: `Exercice ${i}`, balls: simpleBalls });
      assert.doesNotThrow(() => loadLibrary(dir));
    }
    assert.equal(loadLibrary(dir).drills.length, 5);
  });
});
