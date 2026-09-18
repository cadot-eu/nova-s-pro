/**
 * Détection du fichier exécuté directement.
 *
 * On ne peut pas se contenter de comparer `process.argv[1]` à `import.meta.url` :
 *  - un chemin contenant des espaces donne une URL échappée, donc différente ;
 *  - passé par un lien symbolique (ce que fait `npm link`), `argv[1]` est le
 *    chemin du lien et non le vrai fichier.
 *
 * D'où la résolution en chemin réel puis en URL de fichier.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Ce module est-il le point d'entrée du processus ?
 *
 * @param {string} metaUrl `import.meta.url` du module appelant
 * @param {string|undefined} [argv1] `process.argv[1]`, injectable pour les tests
 */
export function isMainModule(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return metaUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    // Chemin inexistant ou illisible : ce n'est pas nous.
    return false;
  }
}
