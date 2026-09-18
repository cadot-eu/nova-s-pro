#!/usr/bin/env node
/**
 * Interface en ligne de commande de NovaKontrol.
 *
 * Tout passe par ici : créer un exercice en le demandant à DeepSeek, lister la
 * bibliothèque, en choisir un et l'envoyer au robot.
 *
 *   nova create "services rapides à droite, centre et gauche, aléatoirement"
 *   nova list
 *   nova send retour-service-rapide
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

import { loadConfig, PROJECT_ROOT } from './config.js';
import { isMainModule } from './entrypoint.js';
import {
  deleteDrill,
  findDrill,
  libraryPath,
  libraryStats,
  listDrills,
  loadLibrary,
  saveDrill,
  suggestDrills,
} from './library.js';
import { generateDrill } from './deepseek.js';
import { getTemplate, TEMPLATES, TEMPLATE_NAMES } from './templates.js';
import {
  buildDrill,
  csvToDrill,
  describeBall,
  describeDrill,
  csvLegacyToDrill,
  detectFormat,
  drillToCsv,
  drillToCsvLegacy,
  drillToSmeeText,
  packDrill,
  smeeTextToDrill,
  validateDrill,
} from './protocol.js';
import { NovaRobot, scanRobots, withTimeout } from './ble.js';
import { CONTROL_COMMANDS, sendControlCommand, startControlServer } from './control-socket.js';
import {
  bold, cyan, dim, fail, info, ok, parseArgs, printDrill, readStdin, reportError, table, warn,
} from './ui.js';

/* -------------------------------------------------------------------------- */
/* Options acceptées par commande                                             */
/* -------------------------------------------------------------------------- */

const GLOBAL = {
  help: { type: 'boolean', alias: 'h' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean', alias: 'v' },
  debug: { type: 'boolean' },
};

const SPECS = {
  create: {
    ...GLOBAL,
    name: { type: 'string', alias: 'n' },
    id: { type: 'string' },
    template: { type: 'string', alias: 't' },
    tag: { type: 'string' },
    model: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'no-save': { type: 'boolean' },
  },
  list: { ...GLOBAL, tag: { type: 'string' }, sort: { type: 'string' } },
  show: { ...GLOBAL, hex: { type: 'boolean' } },
  delete: { ...GLOBAL, yes: { type: 'boolean', alias: 'y' } },
  export: { ...GLOBAL, out: { type: 'string', alias: 'o' }, set: { type: 'string' }, format: { type: 'string', alias: 'f' } },
  import: { ...GLOBAL, name: { type: 'string', alias: 'n' }, file: { type: 'string' }, format: { type: 'string', alias: 'f' } },
  send: {
    ...GLOBAL,
    address: { type: 'string', alias: 'a' },
    modify: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'no-wait': { type: 'boolean' },
    yes: { type: 'boolean', alias: 'y' },
    scan: { type: 'boolean' },
    // Réglages d'ENVOI : ils ne sont pas enregistrés avec l'exercice, donc la
    // ligne de commande doit pouvoir les préciser.
    mode: { type: 'string' },
    value: { type: 'string' },
    random: { type: 'boolean' },
    countdown: { type: 'string' },
  },
  stop: { ...GLOBAL, address: { type: 'string', alias: 'a' } },
  pause: { ...GLOBAL, address: { type: 'string', alias: 'a' } },
  resume: { ...GLOBAL, address: { type: 'string', alias: 'a' } },
  status: { ...GLOBAL, address: { type: 'string', alias: 'a' } },
  scan: { ...GLOBAL },
  doctor: { ...GLOBAL, scan: { type: 'boolean' } },
  web: { ...GLOBAL, port: { type: 'number', alias: 'p' }, host: { type: 'string' }, open: { type: 'boolean' } },
  templates: { ...GLOBAL },
  mcp: { ...GLOBAL },
  help: { ...GLOBAL },
};

/* -------------------------------------------------------------------------- */
/* Journalisation                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Le journal part sur la sortie d'erreur : la sortie standard reste propre,
 * ce qui permet d'utiliser `--json` dans un tube sans la polluer.
 */
function makeLogger({ verbose = false } = {}) {
  const stamp = () => dim(new Date().toISOString().slice(11, 19));
  const write = (prefix, args) => console.error(`${stamp()} ${prefix}`, ...args);
  return {
    debug: verbose ? (...a) => write(dim('debug'), a) : () => {},
    info: (...a) => write(cyan('info '), a),
    warn: (...a) => write('\u001b[33mwarn \u001b[0m', a),
    error: (...a) => write('\u001b[31merror\u001b[0m', a),
  };
}

const out = (obj, { json }) => {
  if (json) console.log(JSON.stringify(obj, null, 2));
  return json;
};

/* -------------------------------------------------------------------------- */
/* Commandes                                                                  */
/* -------------------------------------------------------------------------- */

async function cmdCreate(argv) {
  const { options, positional } = parseArgs(argv, SPECS.create);
  const description = positional.join(' ').trim();
  const config = configOnce();
  const json = Boolean(options.json);

  if (options.verbose) config.verbose = true;

  if (!description && !options.template) {
    throw new Error(
      'Décris l’exercice voulu, par exemple :\n' +
        '  nova create "services très rapides à droite, au centre et à gauche, aléatoirement, même longueur"\n' +
        `ou pars d’un gabarit : nova create --template <nom>\nGabarits disponibles : ${TEMPLATE_NAMES.join(', ')}`,
    );
  }

  let generated;
  let templateKey = null;
  if (options.template) {
    const template = getTemplate(options.template);
    templateKey = template.key;
    generated = {
      name: template.name,
      summary: template.summary,
      coachingNotes: template.notes,
      tags: template.tags,
      drill: null,
      input: {
        balls: template.balls,
        mode: template.mode,
        modeValue: template.modeValue,
        random: template.random,
      },
      meta: { model: 'gabarit', attempts: 0, usage: null },
    };
  } else {
    const logger = makeLogger({ verbose: options.verbose });
    logger.info(`Interrogation de DeepSeek (${options.model ?? config.deepseek.model})…`);
    generated = await generateDrill(description, {
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
      model: options.model ?? config.deepseek.model,
      timeoutMs: config.deepseek.timeoutMs,
      maxRepairAttempts: config.deepseek.maxRepairAttempts,
      onAttempt: ({ attempt, ok: good, error }) => {
        if (attempt > 1) {
          logger.warn(good ? `Tentative ${attempt} acceptée.` : `Tentative ${attempt} refusée : ${error}`);
        }
      },
    });
    generated.input = {
      balls: generated.drill.balls,
      mode: generated.drill.mode,
      modeValue: generated.drill.modeValue,
      random: generated.drill.random,
    };
  }

  const name = options.name ?? generated.name;
  const tags = options.tag
    ? options.tag.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    : generated.tags;

  const payload = {
    // Un gabarit garde sa clé comme identifiant : « nova send
    // retour-service-rapide » est plus agréable qu'un identifiant dérivé du nom.
    id: options.id ?? templateKey ?? undefined,
    name,
    description,
    summary: generated.summary,
    notes: generated.coachingNotes,
    tags,
    source: options.template ? 'gabarit' : 'deepseek',
    model: generated.meta?.model ?? null,
    ...generated.input,
  };

  // On valide AVANT d'écrire quoi que ce soit sur le disque : un --dry-run ne
  // doit rien enregistrer, et un exercice invalide ne doit pas laisser de trace.
  const { drill, adjustments } = buildDrill({
    balls: payload.balls,
    mode: payload.mode,
    modeValue: payload.modeValue,
    random: payload.random,
  });
  const check = validateDrill(drill);
  if (!check.ok) throw new Error(`Exercice invalide :\n  - ${check.errors.join('\n  - ')}`);

  if (options['dry-run'] || options['no-save']) {
    const preview = {
      id: '(non enregistré)',
      ...payload,
      ...drill,
      adjustments,
      warnings: check.warnings,
    };
    if (!out({ saved: false, drill: preview }, options)) {
      info('Exercice généré, NON enregistré.');
      printDrill(preview, { describeDrill, describeBall });
    }
    return 0;
  }

  // On ne remplace un exercice que sur une correspondance EXACTE (identifiant ou
  // nom). Une correspondance partielle écraserait un exercice différent par
  // simple ressemblance de nom, ce qui serait une mauvaise surprise.
  const existing = options.name
    ? loadLibrary(config.dataDir).drills.find(
        (d) => d.id.toLowerCase() === name.toLowerCase() || d.name.toLowerCase() === name.toLowerCase(),
      ) ?? null
    : null;
  const { record, warnings } = saveDrill(config.dataDir, payload, {
    overwriteId: existing?.id ?? null,
  });

  if (out({ saved: true, replaced: Boolean(existing), drill: record, meta: generated.meta }, options)) return 0;

  ok(existing ? `Exercice mis à jour : « ${record.id} ».` : `Exercice enregistré sous « ${record.id} ».`);
  printDrill(record, { describeDrill, describeBall });
  if (generated.meta?.usage?.totalTokens) {
    const { attempts, usage, model } = generated.meta;
    // Les modèles actuels raisonnent avant de répondre : le détail des jetons de
    // raisonnement aide à comprendre la facture et la lenteur.
    const reasoning = usage.reasoningTokens
      ? ` dont ${usage.reasoningTokens} de raisonnement`
      : '';
    console.log(dim(`  ${attempts} appel(s) ${model}, ${usage.totalTokens} jetons${reasoning}.`));
  }
  for (const d of generated.meta?.degraded ?? []) {
    warn(`Le modèle refuse « ${d} » : l’appel a été refait sans ce paramètre.`);
  }
  for (const w of warnings ?? []) warn(w);
  console.log('');
  console.log(`Envoie-le au robot avec :  ${bold(`nova send ${record.id}`)}`);
  return 0;
}

async function cmdList(argv) {
  const { options } = parseArgs(argv, SPECS.list);
  const config = configOnce();
  const drills = listDrills(config.dataDir, { tag: options.tag, sort: options.sort ?? 'updated' });

  if (out({ count: drills.length, drills }, options)) return 0;

  if (drills.length === 0) {
    info('Aucun exercice enregistré.');
    console.log(`Crée-en un avec :  ${bold('nova create "ce que tu veux travailler"')}`);
    return 0;
  }

  console.log(table(
    drills.map((d) => [
      d.id,
      d.name,
      d.balls.length,
      d.mode === 'endless' ? 'sans fin' : `${d.modeValue} ${d.mode === 'minutes' ? 'min' : 'sér.'}`,
      d.random ? 'aléatoire' : 'fixe',
      (d.tags ?? []).join(','),
      (d.updatedAt ?? '').slice(0, 10),
    ]),
    ['id', 'nom', 'balles', 'mode', 'ordre', 'étiquettes', 'modifié'],
  ));
  console.log('');
  console.log(dim(`${drills.length} exercice(s) — envoie-en un avec : nova send <id>`));
  return 0;
}

/**
 * Retrouve un exercice ou explique précisément pourquoi on ne l'a pas trouvé,
 * en proposant les identifiants les plus proches.
 */
function resolveDrillOrThrow(config, ref) {
  const lib = loadLibrary(config.dataDir);
  const record = findDrill(lib, ref);
  if (record) return record;

  const suggestions = suggestDrills(lib, ref);
  const lines = [`Exercice introuvable : ${ref}`];
  if (suggestions.length) {
    lines.push('Peut-être voulais-tu :');
    for (const d of suggestions) lines.push(`  ${d.id} — ${d.name}`);
  }
  if (lib.drills.length === 0) {
    lines.push('La bibliothèque est vide. Crée un exercice avec : nova create "<demande>"');
  } else {
    lines.push(`Liste complète avec : nova list`);
  }
  throw new Error(lines.join('\n'));
}

async function cmdShow(argv) {
  const { options, positional } = parseArgs(argv, SPECS.show);
  const config = configOnce();
  const ref = positional[0];
  if (!ref) throw new Error('Précise l’exercice : nova show <id|nom>');

  const record = resolveDrillOrThrow(config, ref);

  if (out(record, options)) return 0;

  printDrill(record, { describeDrill, describeBall });
  if (options.hex) {
    const packet = packDrill(record);
    console.log('');
    console.log(dim(`Paquet 0x81 (${packet.length} octets) :`));
    console.log(packet.toString('hex').replace(/(.{48})/g, '$1\n').trim());
  }
  return 0;
}

/**
 * Demande confirmation avant de faire bouger le robot.
 *
 * Renvoie `true` sans rien demander si `--yes` est passé ou si l'entrée n'est
 * pas un terminal : un script ou un client MCP ne doit jamais rester bloqué sur
 * une question. Seule une réponse commençant par « n » annule — la touche Entrée
 * vaut donc oui.
 */
export async function confirmDrillSend(record, {
  yes = false,
  interactive = Boolean(process.stdin.isTTY),
  askFn = ask,
} = {}) {
  if (yes || !interactive) return true;
  const answer = await askFn(`Envoyer « ${record.name} » au robot ? [O/n] `);
  return !/^\s*n/i.test(answer);
}

async function cmdDelete(argv) {
  const { options, positional } = parseArgs(argv, SPECS.delete);
  const config = configOnce();
  const ref = positional[0];
  if (!ref) throw new Error('Précise l’exercice : nova delete <id|nom>');

  const record = resolveDrillOrThrow(config, ref);

  if (!options.yes && process.stdin.isTTY) {
    const answer = await ask(`Supprimer « ${record.name} » (${record.id}) ? [o/N] `);
    if (!/^[oOyY]/.test(answer)) {
      info('Annulé.');
      return 0;
    }
  }

  deleteDrill(config.dataDir, record.id);
  if (out({ deleted: record.id }, options)) return 0;
  ok(`Supprimé : ${record.name}`);
  return 0;
}

async function cmdExport(argv) {
  const { options, positional } = parseArgs(argv, SPECS.export);
  const config = configOnce();
  const ref = positional[0];
  if (!ref) throw new Error('Précise l’exercice : nova export <id|nom> [--out fichier.csv]');

  const record = resolveDrillOrThrow(config, ref);

  // Ici il n'y a pas de contenu à analyser : le format doit être explicite.
  const format = detectFormat('Set;Ball', options.format ?? 'csv');

  const contenu = {
    csv: () => drillToCsv(record, { name: record.name, set: options.set ?? 'A' }),
    'csv-legacy': () => drillToCsvLegacy(record, { name: record.name, set: options.set ?? 'A' }),
    smee: () => drillToSmeeText(record),
  }[format]();

  if (options.out) {
    writeFileSync(options.out, contenu, 'utf8');
    if (out({ exported: options.out, id: record.id, format }, options)) return 0;
    ok(`Exporté vers ${options.out} (format ${format}).`);
    console.log(dim({
      csv: 'Importable dans le client web d’olanga/nova (Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps).',
      'csv-legacy': 'Format de l’ancien client d’olanga/nova 1.3 (RPM bruts des deux roues).',
      smee: 'Format texte du client de smee (RPM haut, RPM bas, hauteur, chute, pourcentage, répétitions).',
    }[format]));
  } else {
    process.stdout.write(contenu);
  }
  return 0;
}

async function cmdImport(argv) {
  const { options, positional } = parseArgs(argv, SPECS.import);
  const config = configOnce();
  const file = options.file ?? positional[0];

  const texte = file ? readFileSync(file, 'utf8') : await readStdin();
  if (!texte.trim()) throw new Error('Aucun contenu fourni (ni fichier, ni entrée standard).');

  const format = detectFormat(texte, options.format);
  let drill;
  let name;
  let adjustments = [];
  let maxRpmError = 0;
  let variants = 0;

  if (format === 'smee') {
    const parsed = smeeTextToDrill(texte, { name: options.name });
    drill = parsed.drill;
    name = parsed.name;
    adjustments = parsed.adjustments;
    maxRpmError = parsed.maxRpmError;
    variants = parsed.variants;
  } else if (format === 'csv-legacy') {
    const parsed = csvLegacyToDrill(texte, { name: options.name });
    drill = parsed.drill;
    name = parsed.name;
    adjustments = parsed.adjustments;
    maxRpmError = parsed.maxRpmError;
  } else {
    const parsed = csvToDrill(texte, { name: options.name });
    drill = parsed.drill;
    name = parsed.name;
    adjustments = parsed.adjustments;
  }

  const { record } = saveDrill(config.dataDir, {
    name: options.name ?? name ?? `Import ${format}`,
    description: file ? `importé depuis ${file}` : 'importé depuis l’entrée standard',
    source: format,
    balls: drill.balls,
    mode: drill.mode,
    modeValue: drill.modeValue,
    random: drill.random,
  });

  if (out({ imported: record.id, format, drill: record, maxRpmError, variants, adjustments }, options)) return 0;

  ok(`Importé sous « ${record.id} » (${record.balls.length} balles, format ${format}).`);
  if (variants > 0) info(`${variants} variante(s) « | » détectée(s) : l’ordre aléatoire est activé.`);
  // L'écart de RPM n'est pas un détail : le format de smee décrit les roues
  // directement, ce que notre grille vitesse/effet ne peut pas toujours reproduire.
  if (maxRpmError > 0) {
    warn(
      `Écart maximal de ${maxRpmError} tr/min sur les roues : les formats ${format} donnent des ` +
        'RPM bruts, qui ne tombent pas toujours sur la grille de vitesse/effet (pas de 0.5).',
    );
  }
  for (const a of adjustments) console.log(dim(`  ajusté : ${a}`));
  return 0;
}


function cmdTemplates(argv) {
  const { options } = parseArgs(argv, SPECS.templates);
  if (options.json) {
    console.log(JSON.stringify(
      TEMPLATE_NAMES.map((k) => ({ key: k, name: TEMPLATES[k].name, tags: TEMPLATES[k].tags, balls: TEMPLATES[k].balls.length })),
      null, 2,
    ));
    return 0;
  }
  for (const key of TEMPLATE_NAMES) {
    const t = TEMPLATES[key];
    console.log(`${bold(key)} — ${t.name}`);
    console.log(`  ${t.summary}`);
    console.log(dim(`  ${t.balls.length} balle(s), ${t.tags.join(', ')}`));
  }
  console.log('');
  console.log(`Utilise-les avec : ${bold('nova create --template <nom>')}`);
  return 0;
}

/* ------------------------------- robot ---------------------------------- */

function buildRobot({ config, options, logger }) {
  return new NovaRobot({ config, logger });
}

async function cmdScan(argv) {
  const { options } = parseArgs(argv, SPECS.scan);
  const config = configOnce();
  const logger = makeLogger({ verbose: options.verbose });

  info(`Recherche du robot pendant ${Math.round(config.robot.scanTimeoutMs / 1000)} s…`);
  const found = await scanRobots({
    timeoutMs: config.robot.scanTimeoutMs,
    keywords: config.robot.nameKeywords,
  });

  if (out({ count: found.length, robots: found }, options)) return found.length ? 0 : 1;

  if (found.length === 0) {
    warn('Aucun robot Nova détecté.');
    console.log(dim('  Vérifie qu’il est allumé, à moins de 10 m, et non connecté à l’application officielle.'));
    return 1;
  }
  console.log(table(
    found.map((f) => [f.address, f.name || '(sans nom)', f.rssi ?? '?']),
    ['adresse', 'nom', 'rssi'],
  ));
  console.log('');
  console.log(dim('Retiens l’adresse et mets-la dans .env (NOVA_ADDRESS) pour éviter les scans suivants.'));
  logger.debug('Scan terminé.');
  return 0;
}

/**
 * Envoie un exercice puis, par défaut, RESTE CONNECTÉ pendant qu'il tourne.
 *
 * C'est important : le robot s'arrête quand la liaison Bluetooth tombe. Quitter
 * immédiatement après l'envoi interromprait donc l'exercice.
 */
async function cmdSend(argv) {
  const { options, positional } = parseArgs(argv, SPECS.send);
  const config = configOnce();
  const logger = makeLogger({ verbose: options.verbose });
  const ref = positional[0];
  if (!ref) throw new Error('Précise l’exercice : nova send <id|nom>');

  const enregistre = resolveDrillOrThrow(config, ref);
  // Mode, valeur et ordre aléatoire sont des réglages d'ENVOI : ils ne sont pas
  // dans la librairie, on les prend donc ici, et `buildDrill` les valide — un
  // mode inconnu s'arrête net avec un message clair.
  const { drill: record } = buildDrill({
    balls: enregistre.balls,
    mode: options.mode ? String(options.mode).toLowerCase() : (enregistre.mode ?? 'endless'),
    modeValue: options.value !== undefined ? Number(options.value) : enregistre.modeValue,
    random: options.random === undefined ? Boolean(enregistre.random) : Boolean(options.random),
  });
  // On garde le nom et l'identifiant, que `buildDrill` ne connaît pas.
  record.name = enregistre.name;
  record.id = enregistre.id;
  record.description = enregistre.description;
  record.tags = enregistre.tags;

  if (options['dry-run']) {
    const packet = packDrill(record);
    if (out({ drill: record, bytes: packet.length, hex: packet.toString('hex') }, options)) return 0;
    printDrill(record, { describeDrill, describeBall });
    console.log('');
    info(`Simulation : rien n’a été envoyé. Paquet 0x81 de ${packet.length} octets.`);
    console.log(dim(packet.toString('hex').replace(/(.{48})/g, '$1\n').trim()));
    return 0;
  }

  // On montre TOUJOURS l'exercice avant de connecter quoi que ce soit : le
  // robot ne doit jamais se mettre à lancer des balles sans que tu aies vu ce
  // qui part. Demander confirmation est le comportement par défaut en
  // interactif ; --yes ou une entrée non interactive passent directement.
  printDrill(record, { describeDrill, describeBall });
  console.log('');

  if (!(await confirmDrillSend(record, { yes: options.yes }))) {
    info('Annulé — rien n’a été envoyé.');
    return 0;
  }
  console.log('');

  const robot = buildRobot({ config, options, logger });
  const address = options.address ?? config.robot.address;

  logger.info('Connexion au robot…');
  const { address: connected, firmware } = await robot.connect({ address });
  ok(`Connecté à ${connected}${firmware ? dim(` (firmware ${firmware})`) : ''}`);

  const result = await robot.sendDrill(record, { modify: Boolean(options.modify) });
  ok(`Exercice « ${record.name} » envoyé (${result.bytes} octets).`);

  if (options['no-wait']) {
    warn('Option --no-wait : on se déconnecte tout de suite, le robot risque de s’arrêter.');
    await robot.disconnect();
    return 0;
  }

  const isEndless = (record.mode ?? 'endless') === 'endless';
  console.log('');
  if (isEndless) {
    console.log(`Exercice ${bold('sans fin')} : il tourne jusqu’à ce que tu l’arrêtes.`);
  } else if (record.mode === 'minutes') {
    console.log(`Exercice de ${bold(String(record.modeValue) + ' minute(s)')}.`);
  } else {
    console.log(`Exercice de ${bold(String(record.modeValue) + ' série(s)')}.`);
  }

  // On ouvre le socket de contrôle : depuis un AUTRE terminal, `nova stop`,
  // `nova pause` et `nova resume` pourront piloter cet exercice. Sans lui, le
  // Bluetooth n'acceptant qu'un seul maître, aucune autre commande ne passerait.
  let control = null;
  try {
    control = await startControlServer({
      dataDir: config.dataDir,
      logger,
      onCommand: async (command) => {
        switch (command) {
          case 'stop': {
            const r = await robot.stopDrill();
            return { status: r.status, detail: r.detail };
          }
          case 'pause': {
            const r = await robot.pauseDrill();
            return { status: r.status };
          }
          case 'resume': {
            const r = await robot.resumeDrill();
            return { status: r.status };
          }
          case 'status':
            return robot.status();
          default:
            throw new Error(`Commande inconnue : ${command}. Attendu : ${CONTROL_COMMANDS.join(', ')}.`);
        }
      },
    });
  } catch (err) {
    warn(`Socket de contrôle indisponible (${err.message}) : les commandes depuis un autre terminal ne marcheront pas.`);
  }

  if (control) console.log(dim('Ctrl-C pour arrêter (ou `nova stop` depuis un autre terminal).'));
  else console.log(dim('Ctrl-C pour arrêter.'));

  return await waitForDrill({ robot, control });
}

/**
 * Attend la fin de l'exercice, ou Ctrl-C, en affichant la progression.
 *
 * L'arrêt sur Ctrl-C doit être RAPIDE et prévisible : la déconnexion Bluetooth
 * peut prendre plusieurs secondes, et l'utilisateur ne doit pas avoir
 * l'impression que le programme est bloqué. On affiche donc tout de suite
 * qu'on arrête, on borne la déconnexion, et un second Ctrl-C quitte
 * immédiatement quoi qu'il arrive.
 */
async function waitForDrill({ robot, control = null }) {
  return await new Promise((resolve) => {
    let finished = false;
    let lastLine = '';

    const cleanup = () => {
      process.off('SIGINT', onSigint);
      robot.session?.off('progress', onProgress);
      robot.session?.off('drill-complete', onComplete);
      robot.session?.off('disconnected', onDisconnected);
    };

    const finish = async (code) => {
      if (finished) return;
      finished = true;
      cleanup();
      await closeControlQuietly(control);
      try {
        await withTimeout(robot.disconnect(), 3000, 'déconnexion');
      } catch { /* on a déjà fait ce qu'on pouvait */ }
      resolve(code);
    };

    const onProgress = (p) => {
      const line = `  balle ${p.ballIndex}/${p.totalShots} · séquence ${p.sequence} · cycle ${p.cycle}`;
      if (process.stdout.isTTY) {
        process.stdout.write('\r' + line.padEnd(lastLine.length));
        lastLine = line;
      }
    };

    const onComplete = async () => {
      if (process.stdout.isTTY && lastLine) process.stdout.write('\n');
      ok('Exercice terminé.');
      await finish(0);
    };

    const onDisconnected = async () => {
      if (process.stdout.isTTY && lastLine) process.stdout.write('\n');
      warn('Le robot s’est déconnecté — l’exercice est probablement terminé.');
      await finish(0);
    };

    const onSigint = async () => {
      if (process.stdout.isTTY && lastLine) process.stdout.write('\n');

      // Second Ctrl-C : l'utilisateur est pressé, on ne discute pas.
      if (finished) {
        warn('Sortie immédiate.');
        process.exit(130);
      }
      finished = true;
      cleanup();

      info('Interruption : arrêt de l’exercice…');

      // Filet de sécurité : quoi qu'il arrive, on ne laisse jamais le terminal
      // bloqué plus de quelques secondes.
      const guard = setTimeout(() => {
        warn('La déconnexion Bluetooth traîne — on termine de force.');
        process.exit(130);
      }, 6000);
      guard.unref?.();

      try {
        const stopped = await withTimeout(robot.stopDrill(), 3000, 'l’arrêt de l’exercice');
        info(`Arrêt : ${stopped.status}.`);
      } catch (err) {
        warn(`L’arrêt a échoué (${err.message}) ; la déconnexion arrêtera le robot.`);
      }

      await closeControlQuietly(control);
      try {
        await withTimeout(robot.disconnect(), 3000, 'la déconnexion');
      } catch {
        // Sans conséquence : le processus se termine, le lien tombe avec lui.
      }

      clearTimeout(guard);
      resolve(130);
    };

    robot.session?.on('progress', onProgress);
    robot.session?.on('drill-complete', onComplete);
    robot.session?.on('disconnected', onDisconnected);
    process.on('SIGINT', onSigint);
  });
}

/** Ferme le socket de contrôle sans jamais bloquer plus d'une seconde. */
async function closeControlQuietly(control, timeoutMs = 1000) {
  if (!control) return;
  try {
    await withTimeout(control.close(), timeoutMs, 'la fermeture du socket');
  } catch {
    // Un socket récalcitrant ne doit pas retarder la sortie.
  }
}

/**
 * Les commandes de contrôle s'adressent d'abord au processus qui détient déjà
 * la liaison ; sinon elles se connectent directement.
 */
async function controlCommand(argv, spec, command, action) {
  const { options } = parseArgs(argv, spec);
  const config = configOnce();
  const logger = makeLogger({ verbose: options.verbose });

  // Voie normale : un `nova send` tourne dans un autre terminal et écoute.
  const viaSocket = await sendControlCommand(config.dataDir, command).catch((err) => {
    logger.warn(`Socket de contrôle injoignable : ${err.message}`);
    return null;
  });

  if (viaSocket) {
    if (!viaSocket.ok) throw new Error(viaSocket.error ?? 'le processus de pilotage a refusé la commande');
    const detail = viaSocket.detail ? ` (${viaSocket.detail})` : '';
    const status = viaSocket.status ?? 'fait';
    if (options.json) console.log(JSON.stringify(viaSocket, null, 2));
    else ok(`Via le pilotage en cours — ${status}${detail}.`);
    return 0;
  }

  // Aucun pilote actif : on tente une connexion directe.
  const robot = buildRobot({ config, options, logger });
  const address = options.address ?? config.robot.address;

  try {
    await robot.connect({ address });
    await action(robot);
    return 0;
  } finally {
    await robot.disconnect().catch(() => {});
  }
}

async function cmdStop(argv) {
  return await controlCommand(argv, SPECS.stop, 'stop', async (robot) => {
    const result = await robot.stopDrill();
    ok(`Arrêt : ${result.status} (${result.detail}).`);
  });
}

async function cmdPause(argv) {
  return await controlCommand(argv, SPECS.pause, 'pause', async (robot) => {
    const r = await robot.pauseDrill();
    ok(`Robot ${r.status}.`);
  });
}

async function cmdResume(argv) {
  return await controlCommand(argv, SPECS.resume, 'resume', async (robot) => {
    const r = await robot.resumeDrill();
    ok(`Robot en ${r.status}.`);
  });
}

async function cmdStatus(argv) {
  const { options } = parseArgs(argv, SPECS.status);
  const config = configOnce();
  const logger = makeLogger({ verbose: options.verbose });
  const robot = buildRobot({ config, options, logger });
  const address = options.address ?? config.robot.address;

  const status = { ...robot.status(), dataDir: config.dataDir, library: libraryStats(config.dataDir).count };

  // Un « status » qui se connecte vraiment est plus utile, mais on ne veut pas
  // imposer une connexion pour une simple interrogation.
  if (options.address || config.robot.address) {
    try {
      await robot.connect({ address, scanIfNeeded: false });
      Object.assign(status, robot.status());
    } catch (err) {
      status.connectError = err.message;
    } finally {
      await robot.disconnect().catch(() => {});
    }
  }

  if (out(status, options)) return 0;

  console.log(`Bibliothèque     : ${status.library} exercice(s) dans ${dim(status.dataDir)}`);
  console.log(`Clé DeepSeek     : ${config.deepseek.apiKey ? 'présente' : dim('absente (mode gabarits)')}`);
  console.log(`Adresse du robot : ${config.robot.address ?? dim('non définie (NOVA_ADDRESS)')}`);
  console.log(`Connexion        : ${status.connected ? 'authentifiée' : dim('non connecté')}`);
  if (status.firmware) console.log(`Firmware         : ${status.firmware}`);
  if (status.connectError) warn(status.connectError);
  return 0;
}

async function cmdDoctor(argv) {
  const { options } = parseArgs(argv, SPECS.doctor);
  const config = configOnce();
  const env = config.env;
  const report = { checks: [], ok: true };

  const check = (label, status, detail = '') => {
    report.checks.push({ label, status, detail });
    if (status === 'fail') report.ok = false;
  };

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  check('Version de Node.js', major >= 20 ? 'ok' : 'fail', `v${process.versions.node} (20 minimum)`);

  // Fichier .env
  check('Fichier .env', env.present ? 'ok' : 'warn', env.present ? `${env.path} (${env.loaded.length} variable(s) chargée(s))` : `absent — copie .env.example vers ${PROJECT_ROOT}/.env`);

  // Clé DeepSeek
  check(
    'Clé API DeepSeek',
    config.deepseek.apiKey ? 'ok' : 'warn',
    config.deepseek.apiKey
      ? `${config.deepseek.apiKey.slice(0, 6)}… (modèle ${config.deepseek.model})`
      : 'absente — la création libre sera indisponible, les gabarits restent utilisables',
  );

  // node-ble
  let ble = null;
  try {
    ble = await (await import('./ble.js')).BleLink.create();
    check('Bibliothèque node-ble', 'ok', 'chargée');
  } catch (err) {
    check('Bibliothèque node-ble', 'fail', err.message);
  }

  // Adaptateur Bluetooth
  if (ble) {
    try {
      const adapter = await ble.bluetooth.defaultAdapter();
      const powered = await adapter.isPowered();
      check('Adaptateur Bluetooth', powered ? 'ok' : 'fail', powered ? 'allumé' : 'éteint — lance `bluetoothctl power on`');
    } catch (err) {
      check(
        'Adaptateur Bluetooth',
        'fail',
        `inaccessible (${err.message}). Vérifie que BlueZ tourne et que l’accès D-Bus est autorisé.`,
      );
    } finally {
      await ble.close?.().catch?.(() => {});
    }
  }

  // Bibliothèque
  try {
    const stats = libraryStats(config.dataDir);
    check('Bibliothèque d’exercices', 'ok', `${stats.count} exercice(s) — ${libraryPath(config.dataDir)}`);
  } catch (err) {
    check('Bibliothèque d’exercices', 'fail', err.message);
  }

  // Robot
  if (options.scan) {
    try {
      const found = await scanRobots({ timeoutMs: config.robot.scanTimeoutMs, keywords: config.robot.nameKeywords });
      check('Robot détecté', found.length ? 'ok' : 'warn', found.length ? found.map((f) => `${f.name || '?'} [${f.address}]`).join(', ') : 'aucun robot Nova à portée');
    } catch (err) {
      check('Robot détecté', 'warn', err.message);
    }
  } else {
    check('Robot détecté', 'warn', 'non testé — relance avec --scan');
  }

  if (out(report, options)) return report.ok ? 0 : 1;

  console.log(bold('Diagnostic de NovaKontrol'));
  console.log('');
  for (const { label, status, detail } of report.checks) {
    const icon = status === 'ok' ? '\u001b[32m✓\u001b[0m' : status === 'warn' ? '\u001b[33m!\u001b[0m' : '\u001b[31m✗\u001b[0m';
    console.log(`${icon} ${label.padEnd(24)} ${detail}`);
  }
  console.log('');
  if (!report.ok) {
    fail('Au moins un point bloquant doit être corrigé.');
    return 1;
  }
  ok('Tout est en ordre.');
  return 0;
}


/* -------------------------------------------------------------------------- */
/* Interface web                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Démarre le serveur local et son interface.
 *
 * Le serveur garde la connexion Bluetooth entre les requêtes, ce qui permet
 * d'enchaîner « envoyer », « pause », « arrêt » depuis la page.
 */
async function cmdWeb(argv) {
  const { options } = parseArgs(argv, SPECS.web);
  const config = configOnce();
  const logger = makeLogger({ verbose: options.verbose });
  const { createNovaServer } = await import('./server.js');

  const app = createNovaServer({ config, logger });
  const port = options.port ?? config.web.port;
  const host = options.host ?? config.web.host;

  try {
    const url = await app.listen({ port, host });
    ok(`Interface prête : ${bold(url)}`);
    console.log(dim('  Ctrl-C pour arrêter. La page n’est accessible que depuis cette machine.'));
    if (host !== '127.0.0.1' && host !== 'localhost') {
      warn(`Le serveur écoute sur ${host} : il est joignable depuis le réseau local.`);
    }

    await new Promise((resolve) => {
      const arreter = async () => {
        console.log('');
        info('Arrêt du serveur…');
        await app.close().catch(() => {});
        resolve();
      };
      process.on('SIGINT', arreter);
      process.on('SIGTERM', arreter);
    });
    return 0;
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      throw new Error(
        `Le port ${port} est déjà utilisé. Choisis-en un autre : ./nova web --port 4174`,
      );
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Aides                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Charge le .env une seule fois par exécution.
 * `loadConfig()` renvoie la configuration ET les métadonnées du fichier .env.
 */
let cachedConfig = null;
function configOnce() {
  if (!cachedConfig) cachedConfig = loadConfig();
  return cachedConfig;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

function printHelp() {
  console.log(`${bold('NovaKontrol')} — exercices de tennis de table par DeepSeek, envoyés au Pongbot Nova S Pro en Bluetooth.

${bold('CRÉER')}
  nova create "<demande>"        Demander un exercice à DeepSeek et l'enregistrer
        --name <nom>             Imposer le nom (et remplacer l'exercice existant)
        --id <identifiant>       Imposer l'identifiant utilisé par « nova send »
        --template <nom>         Partir d'un gabarit, sans IA
        --tag a,b                Étiquettes
        --dry-run                Générer et montrer, sans enregistrer
  nova templates                 Lister les gabarits disponibles
  nova import <fichier>          Importer un fichier (format détecté automatiquement)
        --format csv|csv-legacy|smee|auto   Forcer le format

${bold('CONSULTER')}
  nova list [--tag <t>]          Lister les exercices enregistrés
  nova show <id|nom> [--hex]     Afficher un exercice (et son paquet binaire)
  nova export <id|nom> [-o f]    Exporter un exercice
        --format csv             Format du client d'olanga/nova (défaut)
        --format smee            Format texte du client de smee (RPM des roues)
        --format csv-legacy      Ancien format CSV d'olanga/nova 1.3 (RPM des roues)
  nova delete <id|nom>           Supprimer

${bold('ENVOYER')}
  nova scan                      Chercher le robot à proximité
  nova send <id|nom>             Envoyer l'exercice et rester connecté pendant qu'il tourne
        --mode endless|minutes|combos   Mode de jeu (réglage d'envoi, non enregistré)
        --value <n>              Minutes ou nombre de séries selon le mode
        --random                 Ordre aléatoire (réglage d'envoi, non enregistré)
        --yes                    Envoyer sans demander confirmation
        --dry-run                Montrer le paquet sans rien envoyer ni connecter
        --no-wait                Envoyer et se déconnecter aussitôt
        --address <mac>          Forcer l'adresse du robot
        --modify                 Modifier l'exercice en cours au lieu d'en lancer un
  nova stop | pause | resume     Piloter l'exercice en cours
  nova status                    État de la bibliothèque et du robot

${bold('DIVERS')}
  nova doctor [--scan]           Vérifier l'installation
  nova web                       Ouvrir l'interface web (recommandé pour parcourir et éditer)
        --port <n>               Port d'écoute (4173 par défaut)
        --host <adresse>         Adresse d'écoute (127.0.0.1 par défaut)
  nova mcp                       Lancer le serveur MCP (pour DeepSeek / Claude)
  nova help                      Cet écran

${bold('EXEMPLE')}
  nova create "je veux apprendre à retourner les services très rapides avec effets
  latéraux qui m'arrivent presque au milieu de la table. Un service à droite, un au
  centre et un à gauche, aléatoirement, mais tous de la même longueur."
  nova list
  nova send retour-de-services-rapides

Les options communes : --json (sortie machine), --verbose, --debug.`);
}

/* -------------------------------------------------------------------------- */
/* Point d'entrée                                                             */
/* -------------------------------------------------------------------------- */

const COMMANDS = {
  create: cmdCreate,
  list: cmdList,
  ls: cmdList,
  show: cmdShow,
  delete: cmdDelete,
  rm: cmdDelete,
  export: cmdExport,
  import: cmdImport,
  templates: cmdTemplates,
  scan: cmdScan,
  send: cmdSend,
  stop: cmdStop,
  pause: cmdPause,
  resume: cmdResume,
  status: cmdStatus,
  doctor: cmdDoctor,
  web: cmdWeb,
  help: async () => { printHelp(); return 0; },
};

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return 0;
  }

  if (command === 'mcp') {
    const { runMcpServer } = await import('./mcp.js');
    await runMcpServer();
    return 0;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    fail(`Commande inconnue : ${command}`);
    console.log('');
    printHelp();
    return 1;
  }

  if (rest.includes('--help') || rest.includes('-h')) {
    printHelp();
    return 0;
  }

  try {
    return await handler(rest);
  } catch (err) {
    reportError(err, { debug: rest.includes('--debug') });
    return 1;
  }
}

// N'exécute le point d'entrée que si le fichier est lancé directement.
const invokedDirectly = isMainModule(import.meta.url);
if (invokedDirectly) {
  const code = await main();
  process.exit(code);
}
