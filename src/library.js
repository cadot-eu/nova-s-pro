/**
 * Bibliothèque d'exercices : persistance locale, sur le disque, en JSON.
 *
 * Un exercice enregistré contient non seulement les paramètres matériels mais
 * aussi la demande d'origine en langage naturel, ce qui permet de le renommer,
 * de le modifier ou de le régénérer plus tard sans perdre l'intention.
 */

import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildDrill, validateDrill, MAX_BALLS } from './protocol.js';

export const LIBRARY_VERSION = 1;

/** Chemin du fichier de bibliothèque. */
export const libraryPath = (dataDir) => join(dataDir, 'drills.json');

const emptyLibrary = () => ({ version: LIBRARY_VERSION, updatedAt: new Date().toISOString(), drills: [] });

/** Lit la bibliothèque ; renvoie une bibliothèque vide si le fichier n'existe pas. */
export function loadLibrary(dataDir) {
  const path = libraryPath(dataDir);
  if (!existsSync(path)) return emptyLibrary();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Bibliothèque illisible (${path}) : ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.drills)) {
    throw new Error(`Bibliothèque corrompue (${path}) : le champ « drills » est absent ou n'est pas un tableau.`);
  }
  return { version: parsed.version ?? LIBRARY_VERSION, updatedAt: parsed.updatedAt ?? null, drills: parsed.drills };
}

/** Nombre de copies de sécurité conservées. */
export const MAX_BACKUPS = 30;

/** Dossier des copies de sécurité. */
export const backupDir = (dataDir) => join(dataDir, 'backups');

/**
 * Copie la bibliothèque ACTUELLE dans `backups/` avant de la remplacer.
 *
 * Écrire de façon atomique protège d'une coupure de courant, mais pas d'une
 * ÉCRITURE VALIDE ET MALHEUREUSE : une suppression de trop, une liste vidée par
 * erreur, et les exercices ont disparu pour de bon. C'est exactement ce qui est
 * arrivé — la librairie s'est retrouvée vide sans qu'aucune trace ne subsiste.
 *
 * On garde les `MAX_BACKUPS` dernières versions, dans `data/backups/`. C'est
 * quelques kilo-octets par exercice : le prix d'un filet de sécurité qui rend
 * toute perte réparable.
 */
function sauvegarderAvant(dataDir) {
  const source = libraryPath(dataDir);
  if (!existsSync(source)) return null;
  const dossier = backupDir(dataDir);
  try {
    mkdirSync(dossier, { recursive: true });
    const horodatage = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(source, join(dossier, `drills-${horodatage}.json`));
    // Ménage : on ne garde que les plus récentes (le nom commence par la date,
    // donc l'ordre alphabétique est l'ordre chronologique).
    const fichiers = readdirSync(dossier)
      .filter((f) => f.startsWith('drills-') && f.endsWith('.json'))
      .sort();
    for (const vieux of fichiers.slice(0, Math.max(0, fichiers.length - MAX_BACKUPS))) {
      unlinkSync(join(dossier, vieux));
    }
    return join(dossier, `drills-${horodatage}.json`);
  } catch {
    // Une sauvegarde ratée ne doit JAMAIS empêcher d'enregistrer.
    return null;
  }
}

/**
 * Écrit la bibliothèque de façon atomique : on écrit un fichier temporaire puis
 * on le renomme. Une coupure en cours d'écriture ne peut donc pas détruire la
 * bibliothèque existante. Une copie de sécurité de la version précédente est
 * déposée dans `backups/` (voir `sauvegarderAvant`).
 */
export function saveLibrary(dataDir, library) {
  mkdirSync(dataDir, { recursive: true });
  sauvegarderAvant(dataDir);
  const payload = { ...library, version: LIBRARY_VERSION, updatedAt: new Date().toISOString() };
  const target = libraryPath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
  return payload;
}

/** Identifiant court et lisible, dérivé du nom. */
export function makeId(name, existing = []) {
  const slug = String(name)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // retire les accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'exercice';
  const taken = new Set(existing.map((d) => d.id));
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    if (!taken.has(`${slug}-${i}`)) return `${slug}-${i}`;
  }
  return `${slug}-${randomUUID().slice(0, 8)}`;
}

/** Retrouve un exercice par identifiant exact, sinon par nom (insensible à la casse). */
export function findDrill(library, ref) {
  if (!ref) return null;
  const needle = String(ref).trim().toLowerCase();
  const byId = library.drills.find((d) => d.id.toLowerCase() === needle);
  if (byId) return byId;
  const exact = library.drills.find((d) => d.name.toLowerCase() === needle);
  if (exact) return exact;
  const partial = library.drills.filter((d) => d.name.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `« ${ref} » correspond à plusieurs exercices : ${partial.map((d) => d.id).join(', ')}. Précise l'identifiant.`,
    );
  }
  return null;
}

/**
 * Cherche les identifiants les plus proches d'une référence inconnue, pour
 * proposer une correction plutôt qu'un simple « introuvable ».
 */
export function suggestDrills(library, ref, limit = 3) {
  const needle = String(ref ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!needle) return [];
  const score = (candidate) => {
    const text = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (text.includes(needle) || needle.includes(text)) return 100 - Math.abs(text.length - needle.length);
    // Plus longue sous-chaîne commune, pour un rapprochement grossier.
    let best = 0;
    for (let i = 0; i < needle.length; i++) {
      for (let j = i + 1; j <= needle.length; j++) {
        if (text.includes(needle.slice(i, j))) best = Math.max(best, j - i);
      }
    }
    return best;
  };
  return library.drills
    .map((d) => ({ drill: d, s: Math.max(score(d.id), score(d.name)) }))
    .filter((x) => x.s >= 4)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.drill);
}

/**
 * Enregistre un exercice (création ou mise à jour).
 *
 * @param {string} dataDir
 * @param {object} input nom, description, balls (brutes), mode, modeValue, random, tags, source…
 * @param {object} [options] `{ overwriteId }` pour mettre à jour un exercice existant
 */
export function saveDrill(dataDir, input, { overwriteId = null } = {}) {
  const library = loadLibrary(dataDir);
  const name = (input.name || '').trim() || 'Exercice sans nom';

  const { drill, adjustments } = buildDrill({
    balls: input.balls,
    mode: input.mode ?? 'endless',
    modeValue: input.modeValue,
    random: input.random,
  });

  const { ok, errors, warnings } = validateDrill(drill);
  if (!ok) throw new Error(`Exercice invalide :\n  - ${errors.join('\n  - ')}`);

  const now = new Date().toISOString();
  let record;
  if (overwriteId) {
    const index = library.drills.findIndex((d) => d.id === overwriteId);
    if (index === -1) throw new Error(`Exercice introuvable : ${overwriteId}`);
    record = {
      ...library.drills[index],
      ...drill,
      name,
      updatedAt: now,
      adjustments,
      warnings,
    };
    record.description = input.description ?? record.description ?? '';
    record.tags = input.tags ?? record.tags ?? [];
    record.notes = input.notes ?? record.notes ?? '';
    record.source = input.source ?? record.source ?? 'manuel';
    // Réglage physique : il fait partie de l'exercice.
    record.headAngle = input.headAngle ?? record.headAngle ?? null;
    record.robotSquare = input.robotSquare ?? record.robotSquare ?? null;
    record.robotAngle = input.robotAngle ?? record.robotAngle ?? null;
    record.difficulty = input.difficulty ?? record.difficulty ?? 1;
    library.drills[index] = record;
  } else {
    // Un identifiant explicite est respecté s'il est libre ; sinon on en dérive
    // un du nom. makeId garantit l'unicité dans les deux cas.
    record = {
      id: makeId(input.id || name, library.drills),
      name,
      description: input.description ?? '',
      notes: input.notes ?? '',
      tags: input.tags ?? [],
      source: input.source ?? 'manuel',
      model: input.model ?? null,
      difficulty: input.difficulty ?? 1,
      // Réglage PHYSIQUE avec lequel l'exercice a été conçu : position du robot
      // et rotation de tête. `null` = « suivre le réglage courant ».
      headAngle: input.headAngle ?? null,
      robotSquare: input.robotSquare ?? null,
      robotAngle: input.robotAngle ?? null,
      ...drill,
      adjustments,
      warnings,
      createdAt: now,
      updatedAt: now,
    };
    library.drills.push(record);
  }

  saveLibrary(dataDir, library);
  return { record, adjustments, warnings };
}

/** Supprime un exercice. Renvoie l'enregistrement supprimé. */
export function deleteDrill(dataDir, ref) {
  const library = loadLibrary(dataDir);
  const found = findDrill(library, ref);
  if (!found) throw new Error(`Exercice introuvable : ${ref}`);
  // Une suppression est irréversible côté interface : on en garde une trace
  // lisible, dans la sauvegarde automatique, avec le compte avant/après.
  library.drills = library.drills.filter((d) => d.id !== found.id);
  saveLibrary(dataDir, library);
  return found;
}

/** Liste les exercices, éventuellement filtrés par étiquette. */
export function listDrills(dataDir, { tag = null, sort = 'updated' } = {}) {
  const library = loadLibrary(dataDir);
  let drills = library.drills;
  if (tag) {
    const needle = tag.toLowerCase();
    drills = drills.filter((d) => (d.tags || []).some((t) => t.toLowerCase() === needle));
  }
  const key = sort === 'name' ? 'name' : sort === 'created' ? 'createdAt' : 'updatedAt';
  return [...drills].sort((a, b) => String(a[key]).localeCompare(String(b[key]), 'fr'));
}

/** Statistiques sommaires pour l'affichage et le diagnostic. */
export function libraryStats(dataDir) {
  const library = loadLibrary(dataDir);
  const tags = new Map();
  for (const d of library.drills) {
    for (const t of d.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
  }
  return {
    count: library.drills.length,
    balls: library.drills.reduce((sum, d) => sum + (d.balls?.length ?? 0), 0),
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]),
    updatedAt: library.updatedAt,
    maxBalls: MAX_BALLS,
  };
}

/* -------------------------------------------------------------------------- */
/* Réglages locaux                                                            */
/* -------------------------------------------------------------------------- */

/** Chemin du fichier de réglages. */
export const settingsPath = (dataDir) => join(dataDir, 'settings.json');

/** Réglages par défaut. */
export const DEFAULT_SETTINGS = Object.freeze({
  /**
   * Angle du pivot latéral de la tête, en degrés (0 = tête droite).
   * C'est un réglage MANUEL du robot : le logiciel ne peut pas le lire, il ne
   * peut que le demander à l'utilisateur pour interpréter correctement l'effet.
   */
  headAngle: 0,
  /**
   * Placement physique du robot : index de la case du « nine-square grid »
   * (0 à 8) et angle d'orientation en degrés. Réglages MANUELS, comme la tête.
   */
  robotSquare: 1,
  robotAngle: 0,
  /** Adresse Bluetooth mémorisée, pour éviter un scan à chaque connexion. */
  robotAddress: null,
});

export function loadSettings(dataDir) {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    // Un fichier de réglages illisible ne doit pas empêcher l'application de
    // démarrer : on repart des valeurs par défaut.
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(dataDir, patch) {
  const settings = { ...loadSettings(dataDir), ...patch };
  mkdirSync(dataDir, { recursive: true });
  const target = settingsPath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  renameSync(tmp, target);
  return settings;
}
