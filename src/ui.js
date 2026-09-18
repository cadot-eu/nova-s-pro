/** Petites aides d'affichage pour la sortie terminal. */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

const wrap = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const cyan = wrap('36');

export const ok = (msg) => console.log(`${green('✓')} ${msg}`);
export const warn = (msg) => console.log(`${yellow('!')} ${msg}`);
export const fail = (msg) => console.error(`${red('✗')} ${msg}`);
export const info = (msg) => console.log(`${blue('·')} ${msg}`);

/** Affiche une erreur d'exécution sans trace illisible. */
export function reportError(err, { debug = false } = {}) {
  fail(err?.message ?? String(err));
  if (debug && err?.stack) console.error(dim(err.stack));
}

/** Tableau simple, aligné sur la largeur réelle des cellules. */
export function table(rows, headers) {
  if (rows.length === 0) return '';
  const all = headers ? [headers, ...rows] : rows;
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  return all
    .map((row, idx) => {
      const line = row.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ');
      return idx === 0 && headers ? bold(line.replace(/\s+$/, '')) : line.replace(/\s+$/, '');
    })
    .join('\n');
}

/** Affiche un exercice de façon lisible. */
export function printDrill(record, { describeDrill, describeBall }) {
  const tags = (record.tags ?? []).length ? dim(` [${record.tags.join(', ')}]`) : '';
  console.log(`${bold(record.name)} ${dim(`(${record.id})`)}${tags}`);
  if (record.description) console.log(dim(`  demande d’origine : ${record.description}`));
  if (record.summary) console.log(`  ${record.summary}`);
  console.log(`  ${describeDrill({ ...record, balls: record.balls }).split('\n')[0]}`);
  for (const [i, b] of record.balls.entries()) {
    console.log(`    ${describeBall(b, i)}`);
  }
  if (record.notes) console.log(dim(`  note : ${record.notes}`));
  if (record.coachingNotes) console.log(dim(`  conseil : ${record.coachingNotes}`));
  for (const w of record.warnings ?? []) warn(w);
  for (const a of record.adjustments ?? []) console.log(dim(`  ajusté : ${a}`));
}

/**
 * Analyse les arguments de ligne de commande.
 *
 * @param {string[]} argv
 * @param {Record<string, {type: 'boolean'|'string'|'number', alias?: string}>} spec
 */
export function parseArgs(argv, spec = {}) {
  const byAlias = new Map();
  for (const [name, def] of Object.entries(spec)) {
    if (def.alias) byAlias.set(def.alias, name);
  }

  const options = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length === 2 && arg !== '-')) {
      const isLong = arg.startsWith('--');
      let key = isLong ? arg.slice(2) : arg.slice(1);
      let inlineValue = null;
      const eq = key.indexOf('=');
      if (eq !== -1) {
        inlineValue = key.slice(eq + 1);
        key = key.slice(0, eq);
      }
      const name = isLong ? key : (byAlias.get(key) ?? key);
      const def = spec[name];

      if (!def) throw new Error(`Option inconnue : ${arg}`);
      if (def.type === 'boolean') {
        options[name] = inlineValue === null ? true : inlineValue !== 'false';
      } else {
        const value = inlineValue ?? argv[++i];
        if (value === undefined) throw new Error(`L’option ${arg} attend une valeur.`);
        options[name] = def.type === 'number' ? Number(value) : value;
        if (def.type === 'number' && !Number.isFinite(options[name])) {
          throw new Error(`L’option ${arg} attend un nombre, reçu « ${value} ».`);
        }
      }
    } else {
      positional.push(arg);
    }
  }

  return { options, positional };
}

/** Lit le CSV sur l'entrée standard. */
export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
