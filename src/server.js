/**
 * Serveur local de NovaKontrol.
 *
 * Sert une petite interface web et une API JSON. Aucune dépendance externe :
 * tout passe par `node:http`.
 *
 * Deux raisons d'être :
 *   - l'interface web est plus simple à utiliser que le CLI pour parcourir une
 *     bibliothèque, éditer un exercice et voir le placement sur la table ;
 *   - le serveur garde la connexion Bluetooth ouverte entre les requêtes, ce
 *     qu'un processus lancé à la demande ne peut pas faire.
 *
 * Par défaut le serveur n'écoute que sur 127.0.0.1 : il n'est pas exposé au
 * réseau.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import {
  deleteDrill,
  backupDir,
  findDrill,
  libraryStats,
  listDrills,
  loadLibrary,
  loadSettings,
  saveDrill,
  saveSettings,
  suggestDrills,
} from './library.js';
import { generateDrill } from './deepseek.js';
import { NovaRobot, scanRobots } from './ble.js';
import {
  buildDrill,
  normalizeBall,
  csvLegacyToDrill,
  csvToDrill,
  detectFormat,
  describeBall,
  describeDrill,
  drillToCsv,
  drillToCsvLegacy,
  drillToSharedPayload,
  drillToSmeeText,
  FORMATS,
  MAX_BALLS,
  packDrill,
  RANGES,
  sharedPayloadToDrill,
  smeeTextToDrill,
  validateDrill,
} from './protocol.js';
import {
  getSharedDrill,
  isValidShareCode,
  listSharedDrills,
  publishSharedDrill,
  SHARED_API_URL,
  summarizeSharedItem,
} from './cloud.js';
import {
  describeHead,
  effectiveSpin,
  HEAD_ANGLE_RANGE,
  HEAD_PRESETS,
  lateralPercent,
  normalizeHeadAngle,
  spinColor,
} from './head.js';
import { predictBall, TABLE } from './ballistics.js';
import {
  describeSetup,
  normalizeRobotAngle,
  normalizeSquare,
  placementEffect,
  ROBOT_COLUMNS,
  ROBOT_ROWS,
  ROBOT_SQUARES,
  robotDepthShift,
  robotLateralShift,
  robotLaunchX,
  setupAdvice,
  squareAt,
} from './setup.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC_DIR = resolve(HERE);
const WEB_DIR = resolve(HERE, '..', 'web');

/**
 * Modules de `src/` volontairement servis au navigateur.
 * Ils doivent être PURS : aucun import de module Node (`node:fs`, `node:buffer`…).
 * Cette liste est fermée par construction — on n'y ajoute un fichier qu'après
 * avoir vérifié qu'il ne peut rien divulguer.
 */
const BROWSER_MODULES = new Set(['head.js', 'ballistics.js', 'setup.js', 'wheels.js']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

/** Réponse JSON. */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** Lit et analyse un corps JSON, avec une limite de taille. */
async function readJsonBody(req, { limitBytes = 2 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Corps de requête trop volumineux.');
    chunks.push(chunk);
  }
  const texte = Buffer.concat(chunks).toString('utf8').trim();
  if (!texte) return {};
  try {
    return JSON.parse(texte);
  } catch {
    throw new HttpError(400, 'Corps de requête JSON illisible.');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Enrichit un exercice enregistré avec tout ce qu'il faut pour l'afficher :
 * description des balles, positions sur la table, couleur selon l'effet réel.
 *
 * C'est ici que la rotation de tête entre en jeu : la même valeur `spin` ne
 * désigne pas le même effet selon l'orientation du pivot.
 */
export function decorateDrill(record, { headAngle = 0, setup = null } = {}) {
  // Un exercice enregistré PORTE son propre réglage (tête et placement) : c'est
  // celui avec lequel il a été conçu. À défaut — brouillon, exercice en ligne —
  // on retombe sur le réglage courant.
  const angle = normalizeHeadAngle(record.headAngle ?? headAngle);
  const square = normalizeSquare(record.robotSquare ?? setup?.square);
  const robotAngle = normalizeRobotAngle(record.robotAngle ?? setup?.angle);

  const robotPlacement = {
    depthShift: robotDepthShift(square),
    launchX: robotLaunchX(square),
    lateralShift: robotLateralShift(square),
  };

  const balls = record.balls.map((b, i) => {
    const effet = effectiveSpin(b.spin, angle);
    // La profondeur tient compte de la vitesse, de la hauteur, de l'effet ET du
    // placement du robot : reculer la machine raccourcit la balle.
    const vol = predictBall(b, robotPlacement);
    return {
      ...b,
      index: i + 1,
      // Position sur la table, en pourcentage (0 = gauche, 100 = droite).
      // Le placement latéral du robot décale toute la zone couverte.
      x: Math.min(100, Math.max(0, lateralPercent(b.dropPoint) + robotPlacement.lateralShift)),
      // Profondeur ESTIMÉE : le protocole ne transporte aucune profondeur.
      y: vol.depth,
      depthEstimated: true,
      // Ce que la balistique permet d'affirmer, et qui a une valeur pratique.
      flight: {
        landingX: Math.round(vol.landingX * 1000) / 1000,
        netClearance: vol.netClearance === null ? null : Math.round(vol.netClearance * 1000) / 1000,
        clearsNet: vol.clearsNet,
        apex: Math.round(vol.apex * 1000) / 1000,
        flightTimeMs: Math.round(vol.flightTime * 1000),
        launchSpeed: Math.round(vol.speed * 100) / 100,
        launchAngle: Math.round(vol.launchAngle * 10) / 10,
      },
      effect: effet.label,
      effectFamily: effet.family,
      color: spinColor(b.spin, angle),
      topBack: effet.topBack,
      side: effet.side,
      description: describeBall(b, i),
    };
  });

  const placement = validateDrill(record);
  const packet = placement.ok ? packDrill(record) : null;

  return {
    ...record,
    headAngle: angle,
    robotSquare: square,
    robotAngle,
    placement: { ...robotPlacement, label: squareAt(square).label, effect: placementEffect(square) },
    balls,
    // Deux représentations de la même chose : la ligne lisible, et le détail.
    summaryLine: describeDrill(record).split('\n')[0],
    detail: describeDrill(record),
    validateErrors: placement.errors,
    validateWarnings: placement.warnings,
    packetBytes: packet ? packet.length : null,
    packetHex: packet ? packet.toString('hex') : null,
  };
}

/**
 * Construit le serveur sans l'écouter, pour pouvoir le tester.
 */
/**
 * Découpe une suite de balles en segments, d'après les pauses choisies.
 *
 * La pause appartient à une balle (« je m'arrête APRÈS celle-ci »), et donc à
 * l'intervalle qui la sépare de la suivante. Deux balles qui se suivent SANS
 * pause restent dans le même segment : le robot les enchaîne alors exactement
 * comme dans un exercice normal, sans redémarrage inutile.
 *
 *   B1 · B2[pause 5] · B3  →  [{balls:[B1,B2], pause:5}, {balls:[B3], pause:0}]
 *   B1 · B2 · B3           →  [{balls:[B1,B2,B3], pause:0}]   (envoi unique)
 *
 * Une pause sur la dernière balle est ignorée : il n'y a plus rien à attendre.
 * Les balles reçoivent un `numero` (1-based) pour l'affichage de la progression.
 */
export function segmenterParPauses(balls = []) {
  const segments = [];
  let courant = [];
  balls.forEach((balle, i) => {
    courant.push({ ...balle, numero: i + 1 });
    const pause = Math.max(0, Math.min(600, Number(balle.pauseAfter) || 0));
    if (pause > 0 && i < balls.length - 1) {
      segments.push({ balls: courant, pause });
      courant = [];
    }
  });
  if (courant.length) segments.push({ balls: courant, pause: 0 });
  return segments;
}

export function createNovaServer({
  config = loadConfig(),
  logger = console,
  fetchImpl = globalThis.fetch,
  robotFactory = null,
} = {}) {
  const robot = robotFactory
    ? robotFactory()
    : new NovaRobot({ config, logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } });

  /** Progression des opérations longues, lue par /api/state. */
  const progress = { robot: { enCours: false, etape: null, depuis: null } };

  /** Séquence d'envoi en cours, s'il y en a une. */
  let sequence = null;

  const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Envoie un exercice balle par balle, avec une pause entre chaque.
   *
   * Le protocole n'a AUCUN paramètre de silence : une balle, c'est six nombres
   * (roues, hauteur, chute, fréquence, répétitions). Une pause ne peut donc être
   * obtenue qu'en pilotant le robot depuis l'extérieur : on envoie une balle,
   * on attend qu'elle ait fini, on laisse passer la pause, puis on envoie la
   * suivante. Chaque envoi remplace l'exercice en cours (commande 0x81), ce qui
   * est exactement l'effet voulu.
   *
   * La durée d'une balle se déduit de ses répétitions et de sa cadence :
   *   répétitions × 60 / fréquence  secondes.
   */
  async function lancerSequence({ segments, logger }) {
    sequence = { enCours: true };
    progress.robot = { enCours: true, etape: 'Départ…', depuis: Date.now() };

    try {
      for (const [i, segment] of segments.entries()) {
        if (!sequence?.enCours) break;
        const numeros = segment.balls.map((b) => b.numero).join(', ');
        progress.robot.etape = `Segment ${i + 1}/${segments.length} — balle(s) ${numeros}`;

        await robot.sendDrill(
          { balls: segment.balls, mode: 'combos', modeValue: 1, random: false },
          {},
        );

        // Durée du segment : somme des répétitions de ses balles.
        const secondes = segment.balls.reduce((t, b) => t + (b.reps * 60) / b.frequency, 0);
        await attendre(secondes * 1000);

        if (segment.pause > 0 && i < segments.length - 1) {
          progress.robot.etape = `Pause de ${segment.pause} s après la balle ${numeros}`;
          await attendre(segment.pause * 1000);
        }
      }
      logger.info?.('Séquence terminée.');
    } catch (err) {
      logger.error?.('Séquence interrompue :', err);
      throw err;
    } finally {
      sequence = null;
      progress.robot = { enCours: false, etape: null, depuis: null };
    }
  }

  const headAngle = () => normalizeHeadAngle(loadSettings(config.dataDir).headAngle);

  /** Placement du robot, normalisé depuis les réglages. */
  const placement = () => {
    const r = loadSettings(config.dataDir);
    return { square: normalizeSquare(r.robotSquare), angle: normalizeRobotAngle(r.robotAngle) };
  };

  /* ------------------------------------------------------------------ routes */

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  const requireDrill = (ref) => {
    const lib = loadLibrary(config.dataDir);
    const record = findDrill(lib, ref);
    if (record) return record;
    const suggestions = suggestDrills(lib, ref);
    throw new HttpError(
      404,
      `Exercice introuvable : ${ref}.` +
        (suggestions.length ? ` Plus proches : ${suggestions.map((d) => d.id).join(', ')}.` : ''),
    );
  };

  /* ----- état -------------------------------------------------------------- */

  route('GET', /^\/api\/state$/, async () => {
    const settings = loadSettings(config.dataDir);
    const stats = libraryStats(config.dataDir);
    return {
      settings: { ...settings, headAngle: normalizeHeadAngle(settings.headAngle) },
      head: {
        angle: normalizeHeadAngle(settings.headAngle),
        description: describeHead(settings.headAngle),
        range: HEAD_ANGLE_RANGE,
        presets: HEAD_PRESETS,
      },
      setup: (() => {
        const p = placement();
        return {
          ...p,
          label: squareAt(p.square).label,
          description: describeSetup(p.square, p.angle),
          advice: setupAdvice(p.square, p.angle),
          rows: ROBOT_ROWS,
          columns: ROBOT_COLUMNS,
          squares: ROBOT_SQUARES,
        };
      })(),
      robot: robot.status(),
      progress: progress.robot,
      library: { count: stats.count, balls: stats.balls },
      deepseekConfigured: Boolean(config.deepseek.apiKey),
      model: config.deepseek.model,
      cloudApiUrl: SHARED_API_URL,
      constants: { ranges: RANGES, maxBalls: MAX_BALLS, formats: FORMATS, table: TABLE },
    };
  });

  route('PUT', /^\/api\/settings$/, async ({ body }) => {
    const patch = {};
    if (body.headAngle !== undefined) patch.headAngle = normalizeHeadAngle(body.headAngle);
    if (body.robotSquare !== undefined) patch.robotSquare = normalizeSquare(body.robotSquare);
    if (body.robotAngle !== undefined) patch.robotAngle = normalizeRobotAngle(body.robotAngle);
    if (body.robotAddress !== undefined) {
      patch.robotAddress = body.robotAddress ? String(body.robotAddress) : null;
    }
    const settings = saveSettings(config.dataDir, patch);
    return {
      settings,
      head: { angle: settings.headAngle, description: describeHead(settings.headAngle) },
      setup: {
        square: settings.robotSquare,
        angle: settings.robotAngle,
        label: squareAt(settings.robotSquare).label,
        description: describeSetup(settings.robotSquare, settings.robotAngle),
        advice: setupAdvice(settings.robotSquare, settings.robotAngle),
      },
    };
  });

  /* ----- bibliothèque ------------------------------------------------------ */

  route('GET', /^\/api\/drills$/, async ({ query }) => {
    const drills = listDrills(config.dataDir, { tag: query.get('tag'), sort: query.get('sort') ?? 'updated' });
    const contexte = { headAngle: headAngle(), setup: placement() };
    return { count: drills.length, drills: drills.map((d) => decorateDrill(d, contexte)) };
  });

  route('GET', /^\/api\/drills\/([^/]+)$/, async ({ params }) => ({
    drill: decorateDrill(requireDrill(decodeURIComponent(params[0])), {
      headAngle: headAngle(),
      setup: placement(),
    }),
  }));

  /** Prépare la charge utile d'un enregistrement à partir du corps de requête. */
  const payloadFromBody = (body, existing = null) => {
    const balls = Array.isArray(body.balls) ? body.balls : existing?.balls;
    if (!balls) throw new HttpError(400, 'Aucune balle fournie.');

    // On valide AVANT d'écrire, comme le fait le CLI. Une entrée fautive est
    // une erreur du client (400), pas du serveur : on convertit explicitement.
    let drill;
    let adjustments;
    try {
      ({ drill, adjustments } = buildDrill({
        balls,
        mode: body.mode ?? existing?.mode ?? 'endless',
        modeValue: body.modeValue ?? existing?.modeValue,
        random: body.random ?? existing?.random ?? false,
      }));
    } catch (err) {
      throw new HttpError(400, `Exercice invalide : ${err.message}`);
    }
    const check = validateDrill(drill);
    if (!check.ok) {
      throw new HttpError(400, `Exercice invalide : ${check.errors.join(' ; ')}`);
    }

    return {
      payload: {
        name: body.name ?? existing?.name ?? 'Exercice sans nom',
        description: body.description ?? existing?.description ?? '',
        notes: body.notes ?? existing?.notes ?? '',
        tags: body.tags ?? existing?.tags ?? [],
        difficulty: body.difficulty ?? existing?.difficulty ?? 1,
        source: body.source ?? existing?.source ?? 'interface',
        model: body.model ?? existing?.model ?? null,
        // Le réglage physique fait partie de l'exercice : il a été conçu avec.
        headAngle: body.headAngle ?? existing?.headAngle ?? headAngle(),
        robotSquare: body.robotSquare ?? existing?.robotSquare ?? placement().square,
        robotAngle: body.robotAngle ?? existing?.robotAngle ?? placement().angle,
        balls: drill.balls,
        mode: drill.mode,
        modeValue: drill.modeValue,
        random: drill.random,
      },
      adjustments,
      warnings: check.warnings,
    };
  };

  // Recalcule des balles SANS rien enregistrer.
  //
  // L'interface s'en sert à chaque fois qu'un champ est quitté : si la
  // combinaison vitesse/effet dépasse ce que les roues acceptent, l'écran se
  // corrige immédiatement. L'utilisateur voit donc toujours la valeur qui
  // partira réellement au robot, et jamais une valeur théorique impossible.
  route('POST', /^\/api\/normalize$/, async ({ body }) => {
    const balls = Array.isArray(body.balls) ? body.balls : [];
    if (!balls.length) throw new HttpError(400, 'Aucune balle à recalculer.');
    const recalculees = [];
    const adjustments = [];
    balls.forEach((raw, i) => {
      const { ball, adjustments: notes } = normalizeBall(raw);
      if (!ball) throw new HttpError(400, `Balle ${i + 1} invalide.`);
      recalculees.push(ball);
      for (const note of notes) adjustments.push(`balle ${i + 1} — ${note}`);
    });
    return { balls: recalculees, adjustments };
  });

  route('POST', /^\/api\/drills$/, async ({ body }) => {
    const { payload, adjustments, warnings } = payloadFromBody(body);
    const { record } = saveDrill(config.dataDir, payload);
    return { drill: decorateDrill(record, { headAngle: headAngle(), setup: placement() }), adjustments, warnings };
  });

  route('PUT', /^\/api\/drills\/([^/]+)$/, async ({ params, body }) => {
    const existing = requireDrill(decodeURIComponent(params[0]));
    const { payload, adjustments, warnings } = payloadFromBody(body, existing);
    const { record } = saveDrill(config.dataDir, payload, { overwriteId: existing.id });
    return { drill: decorateDrill(record, { headAngle: headAngle(), setup: placement() }), adjustments, warnings };
  });

  route('DELETE', /^\/api\/drills\/([^/]+)$/, async ({ params }) => {
    // Une suppression ne laisse aucune trace dans l'interface : on l'écrit dans
    // le journal, avec le nombre d'exercices avant et après. C'est ce qui permet
    // de comprendre APRÈS COUP ce qui a vidé la librairie.
    const avant = loadLibrary(config.dataDir).drills.length;
    const removed = deleteDrill(config.dataDir, decodeURIComponent(params[0]));
    const apres = loadLibrary(config.dataDir).drills.length;
    logger.info?.(`Exercice supprimé : « ${removed.id} » (${avant} → ${apres} exercice(s)). `
      + `Copie de sécurité dans ${backupDir(config.dataDir)}.`);
    return { deleted: removed.id, name: removed.name, remaining: apres };
  });

  route('POST', /^\/api\/drills\/([^/]+)\/duplicate$/, async ({ params }) => {
    const source = requireDrill(decodeURIComponent(params[0]));
    const { record } = saveDrill(config.dataDir, {
      ...source,
      id: undefined,
      name: `${source.name} (copie)`,
      description: source.description,
      source: 'copie',
    });
    return { drill: decorateDrill(record, { headAngle: headAngle(), setup: placement() }) };
  });

  /* ----- génération par IA ------------------------------------------------- */

  route('POST', /^\/api\/generate$/, async ({ body }) => {
    if (!config.deepseek.apiKey) {
      throw new HttpError(
        400,
        'Aucune clé DeepSeek configurée. Renseigne DEEPSEEK_API_KEY dans le fichier .env, ' +
          'puis redémarre le serveur.',
      );
    }
    const description = String(body.description ?? '').trim();
    if (!description) throw new HttpError(400, 'Décris l’exercice que tu veux travailler.');

    const generated = await generateDrill(description, {
      apiKey: config.deepseek.apiKey,
      baseUrl: config.deepseek.baseUrl,
      model: body.model || config.deepseek.model,
      timeoutMs: config.deepseek.timeoutMs,
      maxRepairAttempts: config.deepseek.maxRepairAttempts,
      // La tête est un réglage manuel : on la transmet au modèle pour qu'il
      // interprète correctement « effet latéral » et calibre le spin.
      onAttempt: null,
      headAngle: headAngle(),
      setup: describeSetup(placement().square, placement().angle),
      extraContext: `${describeHead(headAngle())} ; ${describeSetup(placement().square, placement().angle)}`,
    });

    const draft = {
      name: body.name || generated.name,
      summary: generated.summary,
      coachingNotes: generated.coachingNotes,
      tags: generated.tags,
      difficulty: body.difficulty ?? 1,
      balls: generated.drill.balls,
      mode: generated.drill.mode,
      modeValue: generated.drill.modeValue,
      random: generated.drill.random,
    };

    // On ne sauvegarde pas : l'utilisateur doit d'abord voir l'exercice, le
    // modifier s'il le souhaite, puis l'enregistrer lui-même.
    const preview = decorateDrill(
      { id: '(brouillon)', description, ...draft, createdAt: null, updatedAt: null },
      { headAngle: headAngle(), setup: placement() },
    );

    return {
      saved: false,
      drill: preview,
      summary: generated.summary,
      coachingNotes: generated.coachingNotes,
      adjustments: [...generated.adjustments, ...(generated.warnings ?? [])],
      meta: generated.meta,
      headAngle: headAngle(),
      headDescription: describeHead(headAngle()),
    };
  });

  /* ----- robot ------------------------------------------------------------- */

  route('GET', /^\/api\/robot\/status$/, async () => ({ robot: robot.status() }));

  route('GET', /^\/api\/robot\/scan$/, async ({ query }) => {
    const timeoutMs = Number(query.get('timeoutMs')) || config.robot.scanTimeoutMs;
    const found = await scanRobots({ timeoutMs, keywords: config.robot.nameKeywords });
    return { robots: found };
  });

  route('POST', /^\/api\/robot\/connect$/, async ({ body }) => {
    // On note la progression pour que l'interface puisse l'afficher : sans cela
    // un scan de 12 s laissait l'utilisateur devant un bouton inerte.
    progress.robot = { enCours: true, etape: 'Connexion au robot…', depuis: Date.now() };
    try {
      const address = body.address
        || loadSettings(config.dataDir).robotAddress
        || config.robot.address;

      // Un robot en cache ne se trouve qu'en scannant : si aucune adresse n'est
      // connue, on cherche explicitement, et on le dit.
      if (!address) progress.robot.etape = 'Recherche du robot sur le Bluetooth…';
      robot.once?.('attempt', (info) => {
        progress.robot.etape = `Tentative ${info.tentative}/${info.maxRetries}…`;
      });

      const result = await robot.connect({ address });
      if (result.address) saveSettings(config.dataDir, { robotAddress: result.address });
      return { robot: robot.status(), ...result };
    } finally {
      progress.robot = { enCours: false, etape: null, depuis: null };
    }
  });

  route('POST', /^\/api\/robot\/disconnect$/, async () => {
    await robot.disconnect();
    return { robot: robot.status() };
  });

  route('POST', /^\/api\/robot\/send$/, async ({ body }) => {
    const record = body.id ? requireDrill(body.id) : null;

    // Ce que le client envoie PRIME sur ce qui est sur le disque.
    //
    // L'interface expédie l'exercice tel qu'il est affiché : envoyer l'exercice
    // enregistré ferait jouer au robot une version périmée dès que l'utilisateur
    // a modifié quelque chose sans le dire au serveur. On ne retombe sur la
    // librairie que si le client n'a fourni aucune balle.
    let drill = record;
    if (Array.isArray(body.balls) && body.balls.length) {
      try {
        ({ drill } = buildDrill({
          balls: body.balls,
          mode: body.mode ?? record?.mode,
          modeValue: body.modeValue ?? record?.modeValue,
          random: body.random ?? record?.random,
        }));
      } catch (err) {
        throw new HttpError(400, `Exercice invalide : ${err.message}`);
      }
    } else if (!drill) {
      throw new HttpError(400, 'Aucune balle fournie.');
    }
    if (!robot.connected) await robot.connect({ address: body.address ?? null });

    const segments = segmenterParPauses(drill.balls);

    if (segments.length > 1) {
      if (sequence?.enCours) throw new HttpError(409, 'Une séquence est déjà en cours.');
      lancerSequence({ segments, logger })
        .catch((err) => logger.error?.('Séquence :', err));
      return {
        sent: true,
        sequence: true,
        name: body.name ?? record?.name ?? 'Brouillon',
        segments: segments.length,
        pauses: segments.filter((sg) => sg.pause > 0).map((sg) => sg.pause),
        robot: robot.status(),
      };
    }

    const result = await robot.sendDrill(drill, { modify: Boolean(body.modify) });
    return {
      sent: true,
      name: body.name ?? record?.name ?? 'Brouillon',
      ...result,
      robot: robot.status(),
    };
  });

  route('POST', /^\/api\/robot\/stop$/, async () => {
    if (sequence?.enCours) sequence.enCours = false;
    const result = await robot.stopDrill();
    return { ...result, robot: robot.status() };
  });

  route('POST', /^\/api\/robot\/pause$/, async () => {
    const result = await robot.pauseDrill();
    return { ...result, robot: robot.status() };
  });

  route('POST', /^\/api\/robot\/resume$/, async () => {
    const result = await robot.resumeDrill();
    return { ...result, robot: robot.status() };
  });

  /* ----- librairie en ligne ------------------------------------------------ */

  route('GET', /^\/api\/cloud$/, async ({ query }) => {
    const liste = await listSharedDrills({
      page: Number(query.get('page')) || 1,
      perPage: Number(query.get('perPage')) || 30,
      search: query.get('search') ?? '',
      fetchImpl,
    });
    return {
      total: liste.total,
      page: liste.page,
      perPage: liste.perPage,
      // Un enregistrement illisible ne doit pas faire échouer toute la liste.
      items: liste.items.map((it) => {
        const resume = summarizeSharedItem(it);
        try {
          const converti = sharedPayloadToDrill(it.drill_data);
          return {
            ...resume,
            readable: true,
            drill: decorateDrill(
              {
                id: `cloud-${it.share_code}`,
                name: converti.name,
                description: `partagé sous le code ${it.share_code}`,
                difficulty: converti.difficulty,
                balls: converti.drill.balls,
                mode: 'endless',
                modeValue: 0,
                random: converti.drill.random,
                tags: ['en ligne'],
              },
              headAngle(),
            ),
            maxRpmError: converti.maxRpmError,
            adjustments: converti.adjustments.slice(0, 4),
          };
        } catch (err) {
          return { ...resume, readable: false, error: err.message };
        }
      }),
    };
  });

  route('GET', /^\/api\/cloud\/([^/]+)$/, async ({ params }) => {
    const code = decodeURIComponent(params[0]);
    const item = await getSharedDrill(code, { fetchImpl });
    if (!item) throw new HttpError(404, `Aucun exercice partagé avec le code ${code}.`);
    const converti = sharedPayloadToDrill(item.data);
    return {
      code: item.code,
      created: item.created,
      drill: decorateDrill(
        {
          id: `cloud-${item.code}`,
          name: converti.name,
          description: `partagé sous le code ${item.code}`,
          difficulty: converti.difficulty,
          balls: converti.drill.balls,
          mode: 'endless',
          modeValue: 0,
          random: converti.drill.random,
          tags: ['en ligne'],
        },
        headAngle(),
      ),
      maxRpmError: converti.maxRpmError,
      adjustments: converti.adjustments,
    };
  });

  route('POST', /^\/api\/cloud$/, async ({ body }) => {
    let record;
    if (body.balls) {
      try {
        ({ drill: record } = buildDrill({
          balls: body.balls,
          mode: body.mode,
          modeValue: body.modeValue,
          random: body.random,
        }));
      } catch (err) {
        throw new HttpError(400, `Exercice invalide : ${err.message}`);
      }
    } else {
      record = requireDrill(body.id);
    }
    const payload = drillToSharedPayload({ ...record, name: body.name ?? record.name, difficulty: body.difficulty });
    const { code } = await publishSharedDrill(payload, { fetchImpl });
    return { code, published: true, payload };
  });

  /* ----- import / export --------------------------------------------------- */

  route('GET', /^\/api\/export\/([^/]+)$/, async ({ params, query }) => {
    const record = requireDrill(decodeURIComponent(params[0]));
    const format = detectFormat('Set;Ball', query.get('format') ?? 'csv');
    const text = {
      csv: () => drillToCsv(record, { name: record.name, set: query.get('set') ?? 'A' }),
      'csv-legacy': () => drillToCsvLegacy(record, { name: record.name, set: query.get('set') ?? 'A' }),
      smee: () => drillToSmeeText(record),
    }[format]();
    return { format, filename: `${record.id}.${format === 'smee' ? 'txt' : 'csv'}`, text };
  });

  route('POST', /^\/api\/import$/, async ({ body }) => {
    const texte = String(body.content ?? '');
    if (!texte.trim()) throw new HttpError(400, 'Aucun contenu à importer.');

    const format = detectFormat(texte, body.format ?? 'auto');
    let drill;
    let name;
    let adjustments = [];
    let maxRpmError = 0;
    let variantes = 0;

    if (format === 'smee') {
      const parsed = smeeTextToDrill(texte, { name: body.name });
      ({ drill, name } = parsed);
      adjustments = parsed.adjustments;
      maxRpmError = parsed.maxRpmError;
      variantes = parsed.variants;
    } else if (format === 'csv-legacy') {
      const parsed = csvLegacyToDrill(texte, { name: body.name });
      ({ drill, name } = parsed);
      adjustments = parsed.adjustments;
      maxRpmError = parsed.maxRpmError;
    } else {
      const parsed = csvToDrill(texte, { name: body.name });
      ({ drill, name } = parsed);
      adjustments = parsed.adjustments;
    }

    const draft = {
      id: '(import)',
      name: body.name ?? name ?? `Import ${format}`,
      headAngle: headAngle(),
      robotSquare: placement().square,
      robotAngle: placement().angle,
      description: `importé (${format})`,
      source: format,
      tags: ['importé'],
      balls: drill.balls,
      mode: drill.mode,
      modeValue: drill.modeValue,
      random: drill.random,
    };

    // Comme pour l'IA : on montre d'abord, on n'enregistre que sur confirmation.
    if (body.save !== true) {
      return {
        saved: false, format, drill: decorateDrill(draft, headAngle()),
        maxRpmError, variantes, adjustments,
      };
    }
    const { record } = saveDrill(config.dataDir, draft);
    return {
      saved: true, format, drill: decorateDrill(record, headAngle()),
      maxRpmError, variantes, adjustments,
    };
  });

  /* ---------------------------------------------------------------- fichiers */

  async function serveStatic(req, res, pathname) {
    // `/lib/head.js` sert le VRAI module src/head.js au navigateur : il est pur
    // (aucun import Node), donc le client et le serveur partagent exactement le
    // même calcul d'effet. Sans cela il faudrait le réimplémenter en JavaScript
    // navigateur, avec le risque que les deux versions divergent.
    if (pathname.startsWith('/lib/')) {
      const nom = pathname.slice('/lib/'.length);
      // LISTE BLANCHE EXPLICITE. Un simple motif du genre /^[a-z-]+\.js$/ laissait
      // passer n'importe quel module de src/ — donc du code serveur — au
      // navigateur. Seuls les modules purs, sans dépendance Node, sont exposés.
      if (!BROWSER_MODULES.has(nom)) {
        // On répond en JavaScript, PAS en JSON. Un module chargé par le
        // navigateur qui reçoit du JSON est refusé avec « type MIME interdit
        // (application/json) » : un message qui n'aide personne. Ici, le
        // navigateur exécute ce fichier et affiche une phrase compréhensible.
        //
        // Le cas typique n'est pas une erreur de code mais un SERVEUR PÉRIMÉ :
        // on ajoute un module, le navigateur recharge l'interface, mais le
        // processus en mémoire ne connaît pas encore la nouvelle liste.
        const message = [
          `Le serveur ne sert pas le module « ${nom} ».`,
          `Modules disponibles : ${[...BROWSER_MODULES].join(', ')}.`,
          'Le serveur tourne probablement une version plus ancienne que le code',
          'sur le disque : redémarre-le (./nova web), puis recharge cette page.',
        ].join(' ');
        const corps = `throw new Error(${JSON.stringify(message)});\n`;
        res.writeHead(403, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Length': Buffer.byteLength(corps),
          'Cache-Control': 'no-cache, must-revalidate',
        });
        res.end(corps);
        return;
      }
      try {
        const contenu = await readFile(join(SRC_DIR, nom));
        res.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Length': contenu.length,
          'Cache-Control': 'no-cache, must-revalidate',
        });
        res.end(contenu);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Module introuvable');
      }
      return;
    }

    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    // On interdit toute remontée de répertoire.
    const cible = resolve(WEB_DIR, normalize(rel));
    if (!cible.startsWith(WEB_DIR)) {
      sendJson(res, 403, { error: 'Chemin interdit.' });
      return;
    }
    try {
      const info = await stat(cible);
      if (!info.isFile()) throw new Error('pas un fichier');
      const contenu = await readFile(cible);
      res.writeHead(200, {
        'Content-Type': MIME[extname(cible).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': contenu.length,
        // Sans cela, le navigateur garde l'ancienne interface après une mise à
        // jour du code, et l'on croit à un bug qui n'existe plus.
        'Cache-Control': 'no-cache, must-revalidate',
      });
      res.end(contenu);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Introuvable');
    }
  }

  /* --------------------------------------------------------------- dispatch */

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/')) {
      await serveStatic(req, res, pathname);
      return;
    }

    const match = routes
      .map((r) => ({ r, m: r.method === req.method ? pathname.match(r.pattern) : null }))
      .find((x) => x.m);

    if (!match) {
      const methodeExiste = routes.some((r) => pathname.match(r.pattern));
      sendJson(res, methodeExiste ? 405 : 404, {
        error: methodeExiste
          ? `Méthode ${req.method} non autorisée sur ${pathname}.`
          : `Route inconnue : ${pathname}`,
      });
      return;
    }

    try {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
      const result = await match.r.handler({
        params: match.m.slice(1),
        query: url.searchParams,
        body,
        req,
      });
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      // Les routes « robot » ne peuvent échouer que pour des raisons de matériel
      // ou de Bluetooth : ce n'est pas une panne du serveur, donc 503 et non 500.
      // Le message est transmis tel quel pour que l'interface l'affiche.
      const routeRobot = pathname.startsWith('/api/robot/');
      const status = err instanceof HttpError ? err.status : (routeRobot ? 503 : 500);
      if (status >= 500) logger.error?.(`${req.method} ${pathname} :`, err);
      sendJson(res, status, { error: err?.message ?? String(err) });
    }
  });

  return {
    server,
    robot,
    config,
    /** Adresse réellement écoutée, une fois `listen` appelé. */
    url: null,
    async listen({ port = config.webPort ?? 4173, host = '127.0.0.1' } = {}) {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolveListen();
        });
      });
      const { port: p } = server.address();
      this.url = `http://${host}:${p}`;
      return this.url;
    },
    async close() {
      await robot.disconnect().catch(() => {});
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}
