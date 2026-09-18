/**
 * Serveur MCP de NovaKontrol.
 *
 * Expose à un client MCP (DeepSeek, Claude Desktop, LobeHub…) les outils pour
 * créer un exercice en le décrivant, parcourir la bibliothèque, et piloter le
 * robot.
 *
 * Le serveur vit longtemps : c'est donc lui qui garde la connexion Bluetooth
 * ouverte entre les appels. Un `send_drill` suivi d'un `stop_drill` fonctionne
 * naturellement.
 *
 * ATTENTION : sur le transport stdio, la sortie standard est réservée au
 * protocole. Tout journal doit partir sur la sortie d'erreur.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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
  csvLegacyToDrill,
  csvToDrill,
  describeBall,
  describeDrill,
  detectFormat,
  drillToCsv,
  drillToCsvLegacy,
  drillToSmeeText,
  FORMATS,
  packDrill,
  smeeTextToDrill,
  MAX_BALLS,
  RANGES,
} from './protocol.js';
import { NovaRobot, scanRobots } from './ble.js';

const log = (...args) => console.error('[novakontrol]', ...args);

/** Réponse texte simple. */
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

/** Réponse d'erreur exploitable par le modèle, sans lever d'exception. */
const failure = (err) => ({
  isError: true,
  content: [{ type: 'text', text: `Erreur : ${err?.message ?? String(err)}` }],
});

/** Exécute une action et convertit les exceptions en réponse MCP d'erreur. */
async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    log('erreur outil :', err?.message ?? err);
    return failure(err);
  }
}

/** Retrouve un exercice, ou lève avec des suggestions. */
function requireDrill(config, ref) {
  const lib = loadLibrary(config.dataDir);
  const record = findDrill(lib, ref);
  if (record) return record;
  const suggestions = suggestDrills(lib, ref);
  throw new Error(
    `Aucun exercice ne correspond à « ${ref} ».` +
      (suggestions.length ? ` Plus proches : ${suggestions.map((d) => d.id).join(', ')}.` : '') +
      ' Utilise list_drills pour voir la bibliothèque.',
  );
}

/** Description textuelle d'un exercice enregistré, pour le modèle. */
const renderDrill = (d) =>
  [
    `${d.name} (id: ${d.id})`,
    d.summary ? `  ${d.summary}` : null,
    `  ${describeDrill(d).split('\n')[0]}`,
    ...d.balls.map((b, i) => `  ${describeBall(b, i)}`),
    d.notes ? `  note : ${d.notes}` : null,
    (d.tags ?? []).length ? `  étiquettes : ${d.tags.join(', ')}` : null,
  ].filter(Boolean).join('\n');

/**
 * Construit le serveur MCP, sans le connecter au transport.
 * Séparé pour pouvoir être testé sans lancer de processus.
 */
export function buildMcpServer({ config = loadConfig(), logger = log } = {}) {
  const server = new McpServer({
    name: 'novakontrol',
    version: '0.1.0',
  });

  /** Une seule instance de robot, réutilisée entre les appels. */
  const robot = new NovaRobot({ config, logger });

  /* ------------------------------------------------------------------ outils */

  server.registerTool(
    'create_drill',
    {
      title: 'Créer un exercice par description',
      description:
        'Traduit une demande d’entraînement en langage naturel en un exercice pour le robot ' +
        'Pongbot Nova S Pro, puis l’enregistre dans la bibliothèque. ' +
        'Exemple : « services très rapides à droite, au centre et à gauche, aléatoirement, tous de la même longueur ». ' +
        'Le robot n’a que deux roues : il ne produit pas d’effet latéral, celui-ci est obtenu par le placement. ' +
        `Bornes : ${Object.entries(RANGES).map(([k, r]) => `${k} ${r.min}…${r.max}`).join(', ')}. ` +
        `Maximum ${MAX_BALLS} balles par exercice.`,
      inputSchema: {
        description: z.string().min(3).describe('Ce que l’utilisateur veut travailler, en langage naturel.'),
        name: z.string().optional().describe('Nom à donner à l’exercice. Sinon, DeepSeek en propose un.'),
        tags: z.array(z.string()).optional().describe('Étiquettes pour retrouver l’exercice plus tard.'),
        dry_run: z.boolean().optional().describe('Si vrai, génère et affiche sans enregistrer.'),
      },
    },
    async ({ description, name, tags, dry_run }) => guard(async () => {
      if (!config.deepseek.apiKey) {
        throw new Error(
          'Aucune clé DeepSeek configurée : la création libre est indisponible. ' +
            `Renseigne DEEPSEEK_API_KEY dans ${PROJECT_ROOT}/.env, ou utilise create_from_template avec l’un de : ` +
            `${TEMPLATE_NAMES.join(', ')}.`,
        );
      }

      const generated = await generateDrill(description, {
        apiKey: config.deepseek.apiKey,
        baseUrl: config.deepseek.baseUrl,
        model: config.deepseek.model,
        timeoutMs: config.deepseek.timeoutMs,
        maxRepairAttempts: config.deepseek.maxRepairAttempts,
      });

      const payload = {
        name: name ?? generated.name,
        description,
        summary: generated.summary,
        notes: generated.coachingNotes,
        tags: tags ?? generated.tags,
        source: 'deepseek',
        model: generated.meta.model,
        balls: generated.drill.balls,
        mode: generated.drill.mode,
        modeValue: generated.drill.modeValue,
        random: generated.drill.random,
      };

      if (dry_run) {
        return text(
          `Exercice généré (NON enregistré) :\n\n${renderDrill({ ...payload, id: '(non enregistré)' })}\n\n` +
            `Paquet 0x81 : ${packDrill(generated.drill).length} octets.`,
        );
      }

      const { record, adjustments, warnings } = saveDrill(config.dataDir, payload);
      return text(
        `Exercice enregistré sous l’identifiant « ${record.id} ».\n\n${renderDrill(record)}\n\n` +
          (adjustments.length ? `Ajustements appliqués :\n- ${adjustments.join('\n- ')}\n\n` : '') +
          (warnings.length ? `Attention : ${warnings.join(' ')}\n\n` : '') +
          `Il est prêt à être envoyé avec send_drill("${record.id}").`,
      );
    }),
  );

  server.registerTool(
    'create_from_template',
    {
      title: 'Créer un exercice depuis un gabarit',
      description:
        'Enregistre un exercice prêt à l’emploi, sans appeler DeepSeek. ' +
        `Gabarits disponibles : ${TEMPLATE_NAMES.join(', ')}.`,
      inputSchema: {
        template: z.string().describe('Clé du gabarit.'),
        name: z.string().optional().describe('Nom à donner à l’exercice.'),
        id: z.string().optional().describe('Identifiant du nouvel exercice.'),
      },
    },
    async ({ template, name, id }) => guard(async () => {
      const t = getTemplate(template);
      const { record } = saveDrill(config.dataDir, {
        id: id ?? t.key,
        name: name ?? t.name,
        description: `gabarit ${t.key}`,
        summary: t.summary,
        notes: t.notes,
        tags: t.tags,
        source: 'gabarit',
        balls: t.balls,
        mode: t.mode,
        modeValue: t.modeValue,
        random: t.random,
      });
      return text(`Exercice enregistré sous « ${record.id} ».\n\n${renderDrill(record)}`);
    }),
  );

  server.registerTool(
    'list_templates',
    {
      title: 'Lister les gabarits',
      description: 'Liste les exercices prêts à l’emploi, utilisables sans clé API.',
      inputSchema: {},
    },
    async () => text(
      TEMPLATE_NAMES.map((k) => `${k} — ${TEMPLATES[k].name}\n  ${TEMPLATES[k].summary}\n  ${TEMPLATES[k].balls.length} balle(s), étiquettes : ${TEMPLATES[k].tags.join(', ')}`).join('\n\n'),
    ),
  );

  server.registerTool(
    'list_drills',
    {
      title: 'Lister les exercices enregistrés',
      description: 'Renvoie la liste des exercices de la bibliothèque, avec leur identifiant, leur mode et leurs balles.',
      inputSchema: {
        tag: z.string().optional().describe('Ne garder que les exercices portant cette étiquette.'),
      },
    },
    async ({ tag }) => guard(async () => {
      const drills = listDrills(config.dataDir, { tag });
      if (drills.length === 0) {
        return text(
          tag
            ? `Aucun exercice avec l’étiquette « ${tag} ».`
            : 'La bibliothèque est vide. Crée un exercice avec create_drill ou create_from_template.',
        );
      }
      return text(
        `${drills.length} exercice(s) dans ${libraryPath(config.dataDir)} :\n\n` +
          drills.map(renderDrill).join('\n\n'),
      );
    }),
  );

  server.registerTool(
    'get_drill',
    {
      title: 'Afficher un exercice',
      description: 'Renvoie le détail d’un exercice et le paquet binaire qui sera envoyé au robot.',
      inputSchema: {
        ref: z.string().describe('Identifiant ou nom de l’exercice.'),
      },
    },
    async ({ ref }) => guard(async () => {
      const record = requireDrill(config, ref);
      const packet = packDrill(record);
      return text(
        `${renderDrill(record)}\n\nDemande d’origine : ${record.description || '(aucune)'}\n` +
          `Paquet 0x81 : ${packet.length} octets\n${packet.toString('hex')}`,
      );
    }),
  );

  server.registerTool(
    'delete_drill',
    {
      title: 'Supprimer un exercice',
      description: 'Retire un exercice de la bibliothèque.',
      inputSchema: { ref: z.string().describe('Identifiant ou nom de l’exercice.') },
    },
    async ({ ref }) => guard(async () => {
      const record = deleteDrill(config.dataDir, ref);
      return text(`Exercice supprimé : ${record.name} (${record.id}).`);
    }),
  );

  server.registerTool(
    'export_drill',
    {
      title: 'Exporter un exercice',
      description:
        'Exporte un exercice dans un format de fichier. ' +
        '« csv » est le format du client web d’olanga/nova ' +
        '(Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps), importable dans son interface. ' +
        '« smee » est le format texte du client de smee/nova-s-custom-drills ' +
        '(<RPM haut> <RPM bas> <hauteur> <chute> <fréquence> <répétitions>), celui de son fichier novadrill.txt.',
      inputSchema: {
        ref: z.string().describe('Identifiant ou nom de l’exercice.'),
        format: z.enum(['csv', 'csv-legacy', 'smee']).optional().describe('Format de sortie (csv par défaut).'),
        set: z.enum(['A', 'B', 'C']).optional().describe('Catégorie de destination, format csv uniquement.'),
      },
    },
    async ({ ref, format, set }) => guard(async () => {
      const record = requireDrill(config, ref);
      const choix = format ?? 'csv';
      if (choix === 'csv') return text(drillToCsv(record, { name: record.name, set: set ?? 'A' }));
      if (choix === 'csv-legacy') return text(drillToCsvLegacy(record, { name: record.name, set: set ?? 'A' }));
      return text(drillToSmeeText(record));
    }),
  );

  server.registerTool(
    'import_drill',
    {
      title: 'Importer un exercice depuis un fichier',
      description:
        'Lit un exercice et l’enregistre dans la bibliothèque. Le format est détecté ' +
        'automatiquement, ou forcé avec « csv » / « smee ». ' +
        'Attention : le format smee décrit les roues en tours/minute, qui ne tombent pas ' +
        'toujours sur la grille de vitesse/effet — l’écart éventuel est signalé.',
      inputSchema: {
        content: z.string().describe('Contenu du fichier.'),
        format: z.enum(['auto', 'csv', 'csv-legacy', 'smee']).optional().describe('Format (auto par défaut).'),
        name: z.string().optional().describe('Nom à donner à l’exercice.'),
      },
    },
    async ({ content, format, name }) => guard(async () => {
      const choix = detectFormat(content, format ?? 'auto');
      let drill;
      let nom;
      let adjustments = [];
      let extra = '';

      if (choix === 'csv') {
        const parsed = csvToDrill(content, { name });
        drill = parsed.drill;
        nom = parsed.name;
        adjustments = parsed.adjustments;
      } else if (choix === 'csv-legacy') {
        const parsed = csvLegacyToDrill(content, { name });
        drill = parsed.drill;
        nom = parsed.name;
        adjustments = parsed.adjustments;
        if (parsed.maxRpmError > 0) {
          extra += ` Écart maximal de ${parsed.maxRpmError} tr/min sur les roues (RPM bruts du format 1.3).`;
        }
      } else {
        const parsed = smeeTextToDrill(content, { name });
        drill = parsed.drill;
        nom = parsed.name;
        adjustments = parsed.adjustments;
        if (parsed.variants > 0) extra += ` ${parsed.variants} variante(s) « | » : ordre aléatoire activé.`;
        if (parsed.maxRpmError > 0) {
          extra += ` Écart maximal de ${parsed.maxRpmError} tr/min sur les roues : les RPM de smee`;
          extra += ' ne tombent pas toujours sur la grille de vitesse/effet (pas de 0.5).';
        }
      }

      const { record } = saveDrill(config.dataDir, {
        name: name ?? nom ?? `Import ${choix}`,
        description: 'importé depuis un fichier',
        source: choix,
        balls: drill.balls,
        mode: drill.mode,
        modeValue: drill.modeValue,
        random: drill.random,
      });

      return text(
        `Exercice importé sous « ${record.id} » (${record.balls.length} balles, format ${choix}).${extra}` +
          (adjustments.length ? `\nAjustements : ${adjustments.join(' ; ')}` : ''),
      );
    }),
  );

  /* --------------------------------------------------------------- le robot */

  server.registerTool(
    'scan_robots',
    {
      title: 'Chercher le robot',
      description: 'Scanne les appareils Bluetooth à proximité et renvoie les robots Nova S Pro détectés.',
      inputSchema: {
        timeout_ms: z.number().int().min(1000).max(60000).optional().describe('Durée du scan en millisecondes.'),
      },
    },
    async ({ timeout_ms }) => guard(async () => {
      const found = await scanRobots({
        timeoutMs: timeout_ms ?? config.robot.scanTimeoutMs,
        keywords: config.robot.nameKeywords,
      });
      if (found.length === 0) {
        return text(
          'Aucun robot Nova détecté. Vérifie qu’il est allumé, à moins de 10 m, et qu’il n’est pas ' +
            'déjà connecté à l’application officielle sur un téléphone.',
        );
      }
      return text(found.map((f) => `${f.address}  ${f.name || '(sans nom)'}  rssi=${f.rssi ?? '?'}`).join('\n'));
    }),
  );

  server.registerTool(
    'connect_robot',
    {
      title: 'Se connecter au robot',
      description:
        'Se connecte au robot et effectue la poignée de main d’authentification. ' +
        'Sans adresse, un scan est lancé pour le trouver.',
      inputSchema: {
        address: z.string().optional().describe('Adresse Bluetooth, par exemple AA:BB:CC:DD:EE:FF.'),
      },
    },
    async ({ address }) => guard(async () => {
      const result = await robot.connect({ address: address ?? null });
      return text(
        `Connecté à ${result.address}${result.firmware ? ` (firmware ${result.firmware})` : ''}. ` +
          'Le robot est en attente et prêt à recevoir un exercice.',
      );
    }),
  );

  server.registerTool(
    'disconnect_robot',
    { title: 'Se déconnecter', description: 'Ferme la liaison Bluetooth. Le robot arrête l’exercice en cours.', inputSchema: {} },
    async () => guard(async () => {
      await robot.disconnect();
      return text('Déconnecté.');
    }),
  );

  server.registerTool(
    'send_drill',
    {
      title: 'Envoyer un exercice au robot',
      description:
        'Envoie un exercice de la bibliothèque au robot. La connexion est établie automatiquement si besoin, ' +
        'et reste ouverte pour que tu puisses l’arrêter ensuite avec stop_drill.',
      inputSchema: {
        ref: z.string().describe('Identifiant ou nom de l’exercice à envoyer.'),
        modify: z.boolean().optional().describe('Modifier l’exercice en cours au lieu d’en démarrer un nouveau.'),
        address: z.string().optional().describe('Adresse Bluetooth, si la connexion doit être établie.'),
      },
    },
    async ({ ref, modify, address }) => guard(async () => {
      const record = requireDrill(config, ref);
      if (!robot.connected) await robot.connect({ address: address ?? null });
      const result = await robot.sendDrill(record, { modify: Boolean(modify) });
      const mode = record.mode === 'endless'
        ? 'sans fin : il tourne jusqu’à stop_drill'
        : record.mode === 'minutes' ? `${record.modeValue} minute(s)` : `${record.modeValue} série(s)`;
      return text(
        `Exercice « ${record.name} » envoyé (${result.bytes} octets, mode ${mode}, ` +
          `ordre ${record.random ? 'aléatoire' : 'fixe'}).`,
      );
    }),
  );

  server.registerTool(
    'stop_drill',
    { title: 'Arrêter l’exercice', description: 'Arrête l’exercice en cours sur le robot.', inputSchema: {} },
    async () => guard(async () => {
      const result = await robot.stopDrill();
      return text(`Arrêt : ${result.status} — ${result.detail}.`);
    }),
  );

  server.registerTool(
    'pause_drill',
    { title: 'Mettre en pause', description: 'Met l’exercice en cours en pause.', inputSchema: {} },
    async () => guard(async () => text(`Robot ${(await robot.pauseDrill()).status}.`)),
  );

  server.registerTool(
    'resume_drill',
    { title: 'Reprendre', description: 'Reprend un exercice en pause.', inputSchema: {} },
    async () => guard(async () => text(`Robot en ${(await robot.resumeDrill()).status}.`)),
  );

  server.registerTool(
    'get_status',
    {
      title: 'État général',
      description: 'Renvoie l’état de la connexion au robot et le contenu de la bibliothèque.',
      inputSchema: {},
    },
    async () => guard(async () => {
      const stats = libraryStats(config.dataDir);
      return text({
        robot: robot.status(),
        library: { count: stats.count, balls: stats.balls, path: libraryPath(config.dataDir) },
        deepseekConfigured: Boolean(config.deepseek.apiKey),
        model: config.deepseek.model,
      });
    }),
  );

  /* ------------------------------------------------------------ descriptions */

  server.registerTool(
    'describe_parameters',
    {
      title: 'Décrire les paramètres du robot',
      description:
        'Renvoie la signification, les bornes et les contraintes physiques des paramètres d’un exercice. ' +
        'Utile pour raisonner avant de créer un exercice.',
      inputSchema: {},
    },
    async () => text({
      ranges: RANGES,
      maxSpinBySpeed: 'vitesse 0→2, 0.5→3, 1→4, 1.5→5, 2→6, 2.5→7, 3→8, 3.5→9, 4→10, 4.5→10, 5→9, 5.5→8, 6→8, 6.5→7, 7→6, 7.5→5, 8→4, 8.5→3, 9→2, 9.5→1, 10→0',
      dropPointSign: 'négatif = à droite (côté revers), positif = à gauche (côté coup droit), 0 = plein milieu',
      modes: { endless: 'tourne jusqu’à l’arrêt', minutes: 'durée en minutes', combos: 'nombre de séries' },
      fileFormats: {
        csv: 'client actuel d’olanga/nova (Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps)',
        'csv-legacy': 'ancien client d’olanga/nova 1.3 (Set;Ball;Name;Top;Bottom;Height;Drop;Freq;Reps, RPM bruts)',
        smee: 'client de smee (<RPM haut> <RPM bas> <hauteur> <chute> <pourcentage> <répétitions>), fichier novadrill.txt',
      },
      units: {
        frequency: 'balles par minute (bpm). Le paquet encode (bpm − 30)/60 + 0.5.',
        note: 'Dans les formats de fichier smee et CSV 1.3, la cadence est un POURCENTAGE 0–100, pas des bpm : 0 → 30 bpm, 100 → 90 bpm.',
      },
      wheelFormulas: 'roue haute = 970 + 630,5×speed + 342×spin ; roue basse = 970 − 342×spin + 630,5×speed, bornées à [400, 7500] tr/min',
      hardwareLimits: [
        'Deux roues seulement : top-spin ou back-spin, jamais d’effet latéral réel.',
        'L’effet latéral s’obtient par la variation du point de chute.',
        `Maximum ${MAX_BALLS} balles par exercice.`,
        'La liaison est Bluetooth LE, pas infrarouge.',
      ],
    }),
  );

  return { server, robot, config };
}

/**
 * Démarre le serveur sur le transport stdio.
 *
 * La promesse ne se résout que lorsque le CLIENT ferme la liaison. C'est
 * essentiel : si l'on rendait la main juste après `connect()`, l'appelant
 * enchaînerait sur `process.exit()` et tuerait le serveur avant qu'il ait
 * traité la moindre requête.
 */
export async function runMcpServer() {
  const config = loadConfig();
  const { server, robot } = buildMcpServer({ config });

  const shutdown = async () => {
    log('arrêt du serveur…');
    await robot.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const transport = new StdioServerTransport();
  const closed = new Promise((resolve) => {
    transport.onclose = () => {
      log('client déconnecté');
      resolve();
    };
  });

  await server.connect(transport);
  log('serveur MCP prêt sur stdio');

  // On attend la fermeture, puis on libère proprement la liaison Bluetooth.
  await closed;
  await robot.disconnect().catch(() => {});
  return server;
}

export const TOOL_NAMES = [
  'create_drill', 'create_from_template', 'list_templates', 'list_drills', 'get_drill', 'delete_drill',
  'export_drill', 'import_drill', 'scan_robots', 'connect_robot', 'disconnect_robot',
  'send_drill', 'stop_drill', 'pause_drill', 'resume_drill', 'get_status', 'describe_parameters',
];

// N'exécute le serveur que si le fichier est lancé directement (`node src/mcp.js`
// ou via le binaire `nova mcp`). Un simple import ne doit rien démarrer.
const invokedDirectly = isMainModule(import.meta.url);
if (invokedDirectly) {
  await runMcpServer();
}
