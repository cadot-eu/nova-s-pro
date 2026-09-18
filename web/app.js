/**
 * Interface web de NovaKontrol.
 *
 * Module navigateur, sans dépendance externe. Le calcul de l'effet selon
 * l'orientation de la tête vient du VRAI module `src/head.js`, servi sous
 * `/lib/head.js` : il n'y a donc qu'une seule implémentation.
 */

import {
  dropPointFromLateral,
  effectiveSpin,
  HEAD_PRESETS,
  lateralPercent,
  normalizeHeadAngle,
  spinColor,
} from '/lib/head.js';
import {
  describeSetup,
  normalizeRobotAngle,
  normalizeSquare,
  robotDepthShift,
  robotLateralShift,
  robotLaunchX,
  setupAdvice,
  squareAt,
} from '/lib/setup.js';
import {
  LAUNCH,
  predictBall,
  projector,
  solveDepthParameter,
  TABLE,
} from '/lib/ballistics.js';
// Les MÊMES limites que celles appliquées à l'envoi : l'interface peut donc
// annoncer le plafond exact, au lieu de laisser l'utilisateur buter dessus.
import { plafonds, maxSpinForSpeed } from '/lib/wheels.js';

const LAUNCH_Y = LAUNCH.y;

/* ------------------------------------------------------------------ état -- */

const state = {
  /** Exercice affiché : soit un enregistrement, soit un brouillon. */
  current: null,
  /** L'exercice a-t-il des modifications non enregistrées ? */
  dirty: false,
  /** Identifiant d'origine, null pour un brouillon. */
  originalId: null,
  /**
   * Nom de l'exercice TEL QU'IL EST ENREGISTRÉ.
   *
   * Comparé au nom affiché : s'ils diffèrent, c'est que l'utilisateur a renommé
   * l'exercice, et « Enregistrer » crée alors un NOUVEL exercice au lieu
   * d'écraser l'ancien. Personne ne perd jamais un exercice par inadvertance.
   */
  nomCharge: '',
  headAngle: 0,
  /** Placement physique du robot : case 0–8 et angle en degrés. */
  setup: { square: 4, angle: 0 },
  /**
   * Réglages d'ENVOI, et non de l'exercice : mode, valeur du mode, ordre
   * aléatoire, compte à rebours.
   *
   * Ils ne sont PAS enregistrés dans la librairie et ne rendent pas l'exercice
   * « modifié » : ce sont des façons de le lancer, pas ce qu'il est. Les régler
   * ne doit donc ni forcer un enregistrement, ni créer un nouvel exercice, ni
   * déclencher l'avertissement de modifications non enregistrées.
   *
   * Ils vivent le temps de la session et s'appliquent au prochain envoi.
   */
  envoi: { mode: 'endless', modeValue: 1, random: false, countdown: true },
  robot: { connected: false },
  cloudPage: 1,
  cloudTotal: 0,
  app: null,
  /** Balle dont on montre la trajectoire en grand dans la vue de côté. */
  selectedBall: 0,
  /**
   * Réglages copiés depuis une balle, en attente de collage.
   *
   * `null` = rien de copié, et le bouton « Coller » reste alors désactivé.
   * On ne copie PAS la pause : elle appartient à l'intervalle entre deux balles,
   * pas à la balle elle-même, et la recopier à la fin créerait une pause
   * surprise là où l'on n'en voulait pas.
   */
  copiedBall: null,
  /** Ce qu'un glissement vertical fait varier : la vitesse ou la hauteur. */
  dragKnob: 'speed',
  /** Glissement en cours : { index, bouge } */
  drag: null,
};

const $ = (sel) => document.querySelector(sel);

/** Message d'état du robot, affiché DANS l'en-tête, à côté du bouton. */
function messageRobot(texte, genre = '') {
  const el = $('#robot-message');
  if (!el) return;
  el.hidden = !texte;
  el.className = `robot-message ${genre ? `is-${genre}` : ''}`;
  el.textContent = texte ?? '';
  // Un message d'erreur double aussi dans le panneau, mais l'en-tête est ce que
  // l'utilisateur regarde : c'est là que le retour doit apparaître.
  if (genre === 'error') notice(`${texte}`, 'error');
}

/**
 * Le placement courant, sous la forme attendue par `predictBall`.
 * Une seule définition : toutes les vues et l'éditeur l'utilisent, donc elles ne
 * peuvent pas diverger.
 */
const placementCourant = () => ({
  depthShift: robotDepthShift(state.setup.square),
  launchX: robotLaunchX(state.setup.square),
  lateralShift: robotLateralShift(state.setup.square),
});

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------- API -- */

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* réponse vide ou non JSON */
  }
  if (!res.ok) throw new Error(data?.error ?? `Erreur ${res.status}`);
  return data;
}

/* ---------------------------------------------------------------- messages */

function notice(message, kind = 'ok') {
  const el = $('#notice');
  el.hidden = !message;
  el.className = `notice ${message ? `is-${kind}` : ''}`;
  el.textContent = message ?? '';
}

function setStatus(sel, message, kind = '') {
  const el = $(sel);
  if (!el) return;
  el.hidden = !message;
  el.className = `status ${kind ? `is-${kind}` : ''}`;
  el.innerHTML = message ?? '';
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ================================================================ LA TABLE = */

/**
 * Dessine le plateau vu du dessus.
 *
 * Orientation : le robot est en haut, le filet au milieu, le joueur en bas. Les
 * balles sont posées sur la moitié du joueur.
 *
 * ATTENTION À LA VÉRITÉ DES DONNÉES : l'axe gauche-droite vient du paramètre de
 * placement `dropPoint`, qui est réel. L'axe de profondeur est une ESTIMATION
 * (le protocole ne transporte aucune profondeur) ; le schéma le signale.
 */
const TOP = {
  x: 4, y: 4, w: 92, h: 178,        // cadre du plateau dans le viewBox
  netY: 93,                          // filet, au milieu
  wx: [4, 96],                       // bords gauche / droit utiles
};

/**
 * Correspondance entre les pourcentages du modèle et le repère du schéma.
 *
 * Définie UNE fois : le tracé et le glisser-déposer doivent utiliser exactement
 * la même, sinon la balle sauterait au moment où on la saisit.
 */
const TOP_GEO = {
  gauche: TOP.wx[0],
  droite: TOP.wx[1],
  hautProfondeur: TOP.netY + 2,
  basProfondeur: TOP.y + TOP.h - 5,
};

/** Pourcentages (placement, profondeur) → coordonnées du viewBox. */
const versSchema = (xPercent, profondeurPercent) => ({
  x: TOP_GEO.gauche + (xPercent / 100) * (TOP_GEO.droite - TOP_GEO.gauche),
  y: TOP_GEO.hautProfondeur
    + (profondeurPercent / 100) * (TOP_GEO.basProfondeur - TOP_GEO.hautProfondeur),
});

/** Coordonnées du viewBox → pourcentages, bornés au cadre. */
const depuisSchema = (sx, sy) => ({
  xPercent: Math.min(100, Math.max(0,
    ((sx - TOP_GEO.gauche) / (TOP_GEO.droite - TOP_GEO.gauche)) * 100)),
  profondeurPercent: Math.min(100, Math.max(0,
    ((sy - TOP_GEO.hautProfondeur) / (TOP_GEO.basProfondeur - TOP_GEO.hautProfondeur)) * 100)),
});

/**
 * Les neuf cases de placement du robot, dans le repère du schéma.
 *
 * Trois lignes — reculé (au-dessus de la table), au bord, sur la table — et
 * trois colonnes. C'est la grille que le manuel appelle « nine-square grid »
 * (§3.5.1), et c'est ICI qu'on choisit la position, directement sur la table.
 */
const ROBOT_GRID = {
  // Les trois bandes de la MOITIÉ DU ROBOT : du fond de table (TOP.y) au filet.
  lignes: (() => {
    const haut = TOP.y;
    const bas = TOP.netY;
    const pas = (bas - haut) / 3;
    return [[haut, haut + pas], [haut + pas, haut + 2 * pas], [haut + 2 * pas, bas]];
  })(),
  colonnes: (() => {
    const gauche = TOP.wx[0];
    const droite = TOP.wx[1];
    const pas = (droite - gauche) / 3;
    return [[gauche, gauche + pas], [gauche + pas, gauche + 2 * pas], [gauche + 2 * pas, droite]];
  })(),
};

/** Dessine la grille de placement et renvoie le centre de la case active. */
function dessinerGrilleRobot(svg, add) {
  const actif = state.setup.square;
  let centre = null;

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const index = r * 3 + c;
      const [x1, x2] = ROBOT_GRID.colonnes[c];
      const [y1, y2] = ROBOT_GRID.lignes[r];
      const estActif = index === actif;
      if (estActif) centre = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };

      const case_ = add('rect', {
        x: x1 + 0.6, y: y1 + 0.6, width: x2 - x1 - 1.2, height: y2 - y1 - 1.2, rx: 1.5,
        fill: estActif ? 'var(--accent)' : 'transparent',
        'fill-opacity': estActif ? 0.22 : 0,
        stroke: estActif ? 'var(--accent)' : 'var(--line)',
        'stroke-width': estActif ? 0.8 : 0.35,
        'stroke-dasharray': estActif ? '' : '1.5 1.5',
        class: 'robot-cell',
      });
      case_.style.cursor = 'pointer';
      const titre = document.createElementNS(SVG_NS, 'title');
      titre.textContent = `${squareAt(index).label} — ${squareAt(index).hint}`;
      case_.append(titre);
      case_.addEventListener('click', (ev) => {
        ev.stopPropagation();
        enregistrerPlacement({ robotSquare: index });
      });
    }
  }
  return centre;
}

function renderTable(drill) {
  const svg = $('#table-view');
  svg.innerHTML = '';

  const add = (tag, attrs, text) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    svg.append(el);
    return el;
  };

  // --- plateau
  add('rect', {
    x: TOP.x, y: TOP.y, width: TOP.w, height: TOP.h, rx: 2.5,
    fill: 'var(--panel-2)', stroke: 'var(--line)', 'stroke-width': 0.8,
  });

  // --- les neuf cases de placement du robot, dessinées SOUS le reste
  const centreRobot = dessinerGrilleRobot(svg, add);

  // --- zones gauche / centre / droite de la moitié du joueur
  const moitieHaut = TOP.netY;
  const moitieBas = TOP.y + TOP.h;
  const tiers = [
    [TOP.wx[0], TOP.wx[0] + TOP.w / 3],
    [TOP.wx[0] + TOP.w / 3, TOP.wx[0] + (2 * TOP.w) / 3],
    [TOP.wx[0] + (2 * TOP.w) / 3, TOP.wx[1]],
  ];
  for (const [x1, x2] of tiers) {
    add('rect', {
      x: x1, y: moitieHaut, width: x2 - x1, height: moitieBas - moitieHaut,
      fill: 'transparent', stroke: 'var(--line)', 'stroke-width': 0.3,
      'stroke-dasharray': '1.5 1.5', opacity: 0.55,
    });
  }
  // La moitié du joueur est légèrement teintée pour lever l'ambiguïté.
  add('rect', {
    x: TOP.wx[0], y: moitieHaut, width: TOP.wx[1] - TOP.wx[0],
    height: moitieBas - moitieHaut, fill: 'var(--accent-2)', opacity: 0.045,
  });

  // --- filet
  add('line', {
    x1: TOP.wx[0], y1: TOP.netY, x2: TOP.wx[1], y2: TOP.netY,
    stroke: 'var(--muted)', 'stroke-width': 0.7,
  });
  add('text', {
    x: TOP.wx[0] + 1.5, y: TOP.netY - 2, 'font-size': 4,
    fill: 'var(--muted)', 'font-family': 'sans-serif',
  }, 'filet');

  // --- robot, posé dans la case active
  if (centreRobot) {
    add('circle', { cx: centreRobot.x, cy: centreRobot.y, r: 3.2, fill: 'var(--accent)' });
    add('circle', {
      cx: centreRobot.x, cy: centreRobot.y, r: 5.6,
      fill: 'none', stroke: 'var(--accent)', 'stroke-width': 0.7, opacity: 0.6,
    });
    add('text', {
      x: centreRobot.x, y: centreRobot.y + 7.5, 'font-size': 3.1, 'text-anchor': 'middle',
      fill: 'var(--accent)', 'font-family': 'sans-serif', 'font-weight': '600',
    }, 'robot');
  }
  add('text', {
    x: 50, y: TOP.y - 1.2, 'font-size': 3.2, 'text-anchor': 'middle',
    fill: 'var(--muted)', 'font-family': 'sans-serif',
  }, 'moitié du robot');
  add('text', {
    x: 50, y: TOP.netY + 8, 'font-size': 3.4, 'text-anchor': 'middle',
    fill: 'var(--muted)', 'font-family': 'sans-serif',
  }, 'ta moitié');

  add('text', {
    x: 50, y: TOP.y + TOP.h - 2, 'font-size': 3.4, 'text-anchor': 'middle',
    fill: 'var(--muted)', 'font-family': 'sans-serif',
  }, 'fond de table');
  add('text', {
    x: TOP.wx[0] + 1, y: TOP.y + TOP.h - 1, 'font-size': 3.2,
    fill: 'var(--muted)', 'font-family': 'sans-serif',
  }, 'G');
  add('text', {
    x: TOP.wx[1] - 1, y: TOP.y + TOP.h - 1, 'font-size': 3.2,
    'text-anchor': 'end', fill: 'var(--muted)', 'font-family': 'sans-serif',
  }, 'D');

  const balls = drill?.balls ?? [];
  if (balls.length === 0) {
    add('text', {
      x: 50, y: TOP.netY + 40, 'font-size': 4, 'text-anchor': 'middle',
      fill: 'var(--muted)', 'font-family': 'sans-serif',
    }, 'aucune balle');
    return;
  }

  const FILL = {
    green: 'var(--green)', yellow: 'var(--yellow)',
    orange: 'var(--orange)', blue: 'var(--blue)', grey: 'var(--grey)',
  };

  // Les balles identiques au même endroit sont légèrement écartées pour rester
  // lisibles : sans cela elles se superposeraient exactement.
  const places = new Map();

  balls.forEach((b, i) => {
    const x = TOP.wx[0] + ((b.x ?? lateralPercent(b.dropPoint)) / 100) * (TOP.wx[1] - TOP.wx[0]);
    const depth = (b.y ?? estimatedDepthPercent(b.speed, b.height)) / 100;
    const y = TOP.netY + 2 + depth * (TOP.y + TOP.h - TOP.netY - 5);

    const cle = `${Math.round(x)}:${Math.round(y)}`;
    const n = places.get(cle) ?? 0;
    places.set(cle, n + 1);
    const dx = n === 0 ? 0 : (n % 2 ? 1 : -1) * 4.2 * Math.ceil(n / 2);

    const color = b.color ?? spinColor(b.spin, state.headAngle);
    const effet = effectiveSpin(b.spin, state.headAngle);
    const cx = x + dx;
    const rayon = 4.4 + Math.min(2.6, (b.speed ?? 0) * 0.26);

    const groupe = document.createElementNS(SVG_NS, 'g');
    groupe.setAttribute('class', 'ball');
    groupe.setAttribute('transform', `translate(${cx} ${y})`);
    groupe.setAttribute('tabindex', '0');
    groupe.setAttribute('role', 'listitem');

    const titre = document.createElementNS(SVG_NS, 'title');
    titre.textContent =
      `Balle ${i + 1} — ${b.description ?? ''}\n`
      + `Effet réel avec la tête à ${state.headAngle}° : ${effet.label}\n`
      + `Placement ${b.dropPoint} · profondeur estimée ${b.y ?? predictBall(b, placementCourant()).depth} %`;
    groupe.append(titre);

    // Premier rebond : sur la moitié du robot, donc AU-DESSUS du filet sur le
    // schéma. On le signale par un anneau discret.
    if (b.bounces === 2 && b.firstBounceX !== null) {
      const relatif = (b.firstBounceX - LAUNCH.x) / (TABLE.length - LAUNCH.x);
      const xBond = 4 + relatif * 92;
      const anneau = document.createElementNS(SVG_NS, 'circle');
      anneau.setAttribute('cx', String(xBond));
      anneau.setAttribute('cy', String(TOP.netY - 26));
      anneau.setAttribute('r', '3');
      anneau.setAttribute('fill', 'none');
      anneau.setAttribute('stroke', 'var(--muted)');
      anneau.setAttribute('stroke-width', '0.6');
      anneau.setAttribute('stroke-dasharray', '1.5 1.5');
      const titre = document.createElementNS(SVG_NS, 'title');
      titre.textContent = `Premier rebond sur la moitié du robot, à ${(b.firstBounceX - LAUNCH.x).toFixed(2)} m`;
      anneau.append(titre);
      svg.insertBefore(anneau, svg.firstChild);
    }

    const halo = document.createElementNS(SVG_NS, 'circle');
    halo.setAttribute('r', rayon + 1.6);
    halo.setAttribute('fill', FILL[color] ?? 'var(--grey)');
    halo.setAttribute('opacity', '0.22');
    groupe.append(halo);

    const cercle = document.createElementNS(SVG_NS, 'circle');
    cercle.setAttribute('r', rayon);
    cercle.setAttribute('fill', FILL[color] ?? 'var(--grey)');
    cercle.setAttribute('stroke', 'var(--panel)');
    cercle.setAttribute('stroke-width', '0.6');

    // Une flèche indique le sens de l'effet latéral quand la tête est tournée.
    if (Math.abs(effet.side) > 0.05) {
      const fleche = document.createElementNS(SVG_NS, 'path');
      const sens = effet.side < 0 ? -1 : 1;
      const a = rayon + 2.4;
      fleche.setAttribute('d', `M ${sens * -a} 0 L ${sens * -a - sens * 3.4} 0`);
      fleche.setAttribute('stroke', FILL[color] ?? 'var(--grey)');
      fleche.setAttribute('stroke-width', '1.5');
      fleche.setAttribute('stroke-linecap', 'round');
      groupe.append(fleche);
    }

    groupe.append(cercle);

    const texte = document.createElementNS(SVG_NS, 'text');
    texte.setAttribute('text-anchor', 'middle');
    texte.setAttribute('dominant-baseline', 'central');
    texte.setAttribute('font-size', String(rayon * 1.05));
    texte.setAttribute('font-weight', '700');
    texte.setAttribute('font-family', 'sans-serif');
    texte.setAttribute('fill', '#10131a');
    texte.textContent = String(i + 1);
    groupe.append(texte);

    rendreDeplacable(groupe, i, svg);

    svg.append(groupe);
  });
}

/* ==================================================== COMPTE À REBOURS ===== */

let decompteEnCours = null;

/**
 * Affiche un décompte plein écran avant de lancer le robot.
 *
 * Le robot démarre dès qu'il reçoit l'exercice : sans ce délai, il part avant
 * qu'on ait reposé la souris et repris sa raquette. Renvoie `true` si l'on doit
 * envoyer, `false` si l'utilisateur a annulé.
 */
function compteARebours(secondes = 5, texte = 'Envoi au robot…') {
  const voile = $('#countdown');
  const nombre = $('#countdown-nombre');
  const libelle = $('#countdown-texte');
  if (!voile) return Promise.resolve(true);

  libelle.textContent = texte;
  voile.hidden = false;

  return new Promise((resolve) => {
    let restant = secondes;
    nombre.textContent = String(restant);

    const terminer = (ok) => {
      clearInterval(minuteur);
      document.removeEventListener('keydown', surTouche);
      voile.hidden = true;
      decompteEnCours = null;
      resolve(ok);
    };

    const surTouche = (ev) => { if (ev.key === 'Escape') terminer(false); };

    const minuteur = setInterval(() => {
      restant -= 1;
      if (restant <= 0) { terminer(true); return; }
      nombre.textContent = String(restant);
    }, 1000);

    $('#countdown-annuler').onclick = () => terminer(false);
    document.addEventListener('keydown', surTouche);
    decompteEnCours = terminer;
  });
}

/* ================================================== TESTER UNE SEULE BALLE = */

/**
 * Envoie UNE balle au robot, pour vérifier ses paramètres sans lancer
 * l'exercice complet.
 *
 * On enregistre d'abord l'exercice : sans cela le test porterait sur des valeurs
 * non validées, et l'on ne saurait pas si l'écart vient du réglage ou du serveur.
 */
async function testerBalle(index) {
  const ball = state.current?.balls?.[index];
  if (!ball) return;

  const bouton = document.querySelector(`.ball-row[data-index="${index}"] button[data-action="test"]`);
  if (bouton) { bouton.disabled = true; bouton.textContent = '…'; }
  messageRobot(`Test de la balle ${index + 1}…`, 'busy');

  try {
    if (state.dirty || !state.originalId) {
      const ok = await enregistrer({ silencieux: true });
      if (!ok) throw new Error('Enregistrement impossible : le test est annulé.');
    }

    // UNE seule balle, jouée UNE seule fois.
    //
    // Deux pièges se cumulaient : `reps` élevé (la balle de la feuille en a 199)
    // faisait répéter la même balle des dizaines de fois, et le mode « sans fin »
    // relançait l'exercice indéfiniment. Le robot n'arrêtait donc jamais.
    // On force `reps` à 1 ET le mode « combos » avec une seule série — c'est
    // exactement ce qu'utilise le client d'olanga pour tester une balle isolée.
    const aTester = { ...state.current.balls[index], reps: 1 };
    const res = await api('/api/robot/send', {
      method: 'POST',
      body: { balls: [aTester], mode: 'combos', modeValue: 1, random: false },
    });

    const roues = `${aTester.topRpm ?? '?'}/${aTester.bottomRpm ?? '?'}`;
    const texte = `Balle ${index + 1} envoyée — vitesse ${aTester.speed}, effet ${aTester.spin}, `
      + `hauteur ${aTester.height}, chute ${aTester.dropPoint}, roues ${roues} — ${res.bytes} octets`;
    messageRobot(texte, 'ok');
    notice(`${texte}. Le robot la répète jusqu’à « Arrêter ».`);
  } catch (err) {
    messageRobot(err.message, 'error');
  } finally {
    if (bouton) { bouton.disabled = false; bouton.textContent = '▶ Tester'; }
  }
}

/* ==================================================== PLACEMENT DU ROBOT = */

/** Construit la grille 3×3 des positions du robot et son état actif. */
function renderSetupGrid(app) {
  const grille = $('#setup-grid');
  if (!grille) return;
  grille.innerHTML = '';

  for (const carre of app.setup.squares) {
    const bouton = document.createElement('button');
    bouton.type = 'button';
    bouton.textContent = carre.label;
    bouton.title = `${carre.label} — ${carre.hint}`;
    bouton.dataset.index = String(carre.index);
    bouton.classList.toggle('is-active', carre.index === state.setup.square);
    bouton.addEventListener('click', () => enregistrerPlacement({ robotSquare: carre.index }));
    grille.append(bouton);
  }

  $('#setup-angle').value = String(state.setup.angle);
  $('#setup-summary').textContent = `— ${app.setup.label}`;
  $('#setup-advice').textContent = app.setup.advice;
}

/** Enregistre un changement de placement et rafraîchit l'affichage. */
async function enregistrerPlacement(patch) {
  try {
    const res = await api('/api/settings', { method: 'PUT', body: patch });
    state.setup = { square: res.setup.square, angle: res.setup.angle };
    $('#setup-angle').value = String(state.setup.angle);
    $('#setup-summary').textContent = `— ${res.setup.label}`;
    $('#setup-advice').textContent = res.setup.advice;
    document.querySelectorAll('#setup-grid button').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.index) === state.setup.square);
    });
    // L'IA doit connaître le placement : on le rappelle à côté du champ.
    $('#ai-head-hint').textContent =
      `L’IA tiendra compte de la tête à ${state.headAngle}° `
      + `et du robot « ${res.setup.label} » (${state.setup.angle}°).`;

    // TOUT recalculer : la profondeur, le point de chute, les arcs et les temps
    // de parcours dépendent du placement. Sans cela les balles ne bougeaient
    // pas quand on déplaçait le robot.
    if (state.current) {
      renderBallRows();
      renderTable(state.current);
      renderSideView(state.current);
      marquerModifie();
    }
    notice('Placement du robot enregistré : '
      + describeSetup(state.setup.square, state.setup.angle)
      + '. Pense à poser réellement le robot à cet endroit.');
  } catch (err) {
    notice(err.message, 'error');
  }
}

/* ======================================================= GLISSER-DÉPOSER = */

const FILL_DEFAUT = {
  green: 'var(--green)', yellow: 'var(--yellow)',
  orange: 'var(--orange)', blue: 'var(--blue)', grey: 'var(--grey)',
};

/**
 * Met à jour une ligne de l'éditeur sans la reconstruire.
 *
 * Pendant un glissement on ne peut pas appeler `renderBallRows()` : cela
 * détruirait l'élément SVG qui capture le pointeur, et le glissement
 * s'interromprait au premier mouvement.
 */
function majLigne(index, ball) {
  const ligne = document.querySelector(`.ball-row[data-index="${index}"]`);
  if (!ligne) return;
  for (const cle of ['speed', 'spin', 'height', 'dropPoint', 'frequency', 'reps']) {
    const input = ligne.querySelector(`input[data-field="${cle}"]`);
    if (input && document.activeElement !== input) input.value = ball[cle];
  }
  const couleur = FILL_DEFAUT[ball.color] ?? 'var(--grey)';
  ligne.style.borderLeftColor = couleur;
  ligne.querySelector('.num').style.background = couleur;
  ligne.querySelector('.effect').textContent = ball.effect ?? '';
  majPlafonds(ligne, ball);
}

/**
 * Affiche, sous les champs « vitesse » et « effet », le plafond réellement
 * utilisable — celui imposé par les roues, pas une table approximative.
 *
 * Sans cela l'utilisateur découvre la limite en la heurtant : il tape 9, le
 * champ retombe à 2,5, et il croit que le champ est cassé. Avec le plafond
 * écrit noir sur blanc, la limite est une information au lieu d'un mur.
 *
 * Le plafond atteint est mis en évidence : c'est le signal « tu es au bout ».
 */
function majPlafonds(ligne, ball) {
  if (!ligne || !ball) return;
  const p = plafonds(ball.speed, ball.spin);

  const effet = ligne.querySelector('input[data-field="spin"]');
  if (effet) {
    effet.min = String(-p.maxSpin);
    effet.max = String(p.maxSpin);
    effet.title = `Effet maximal utilisable à vitesse ${ball.speed} : ±${p.maxSpin}. `
      + 'Au-delà, les roues ne suivent pas.';
  }
  const vitesse = ligne.querySelector('input[data-field="speed"]');
  if (vitesse) {
    vitesse.max = String(p.maxSpeed);
    vitesse.title = `Vitesse maximale utilisable avec un effet de ${Math.abs(ball.spin)} : `
      + `${p.maxSpeed}. Au-delà, les roues ne suivent pas.`;
  }

  // Trois états, et non deux : « au plafond » et « au-delà du plafond » ne
  // disent pas la même chose. Afficher « max 8 — atteint » à côté d'une vitesse
  // de 8,5 se contredisait — c'est le cas des exercices enregistrés avant que
  // le plafond des roues soit calculé correctement.
  const etatPlafond = (valeur, maximum) => {
    if (Math.abs(valeur) > maximum) return 'is-over';
    if (Math.abs(valeur) >= maximum) return 'is-max';
    return '';
  };
  const textePlafond = (valeur, maximum, prefixe) => {
    const etat = etatPlafond(valeur, maximum);
    if (etat === 'is-over') return `${prefixe}${maximum} — dépassé, sera corrigé`;
    if (etat === 'is-max') return `${prefixe}${maximum} — atteint`;
    return `${prefixe}${maximum}`;
  };

  const hEffet = ligne.querySelector('.plafond-spin');
  if (hEffet) {
    hEffet.textContent = textePlafond(ball.spin, p.maxSpin, 'max ±');
    hEffet.className = `plafond plafond-spin ${etatPlafond(ball.spin, p.maxSpin)}`.trim();
  }
  const hVitesse = ligne.querySelector('.plafond-speed');
  if (hVitesse) {
    hVitesse.textContent = textePlafond(ball.speed, p.maxSpeed, 'max ');
    hVitesse.className = `plafond plafond-speed ${etatPlafond(ball.speed, p.maxSpeed)}`.trim();
  }
}

/** Affiche en direct ce que le glissement est en train de changer. */
function majLectureGlissement(ball, res) {
  const cible = $('#drag-readout');
  if (!cible) return;
  const borne = res?.saturated ? ' — au plus loin possible' : '';
  cible.textContent =
    `placement ${ball.dropPoint} · vitesse ${ball.speed} · hauteur ${ball.height} `
    + `· profondeur ${ball.y} %${borne}`;
}

/**
 * Rend une balle déplaçable à la souris.
 *
 *   - horizontal → `dropPoint` (le placement latéral du robot) ;
 *   - vertical   → la profondeur, obtenue en faisant varier la vitesse
 *                  (ou la hauteur, selon le sélecteur) ;
 *   - l'effet n'est pas touché : c'est un réglage distinct, qui lui aussi
 *     détermine la profondeur.
 *
 * La balle suit le curseur pendant le geste, puis se recale sur les valeurs
 * arrondies au relâchement — l'utilisateur voit donc exactement ce qui sera
 * envoyé au robot.
 */
function rendreDeplacable(groupe, index, svg) {
  groupe.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !state.current) return;
    ev.preventDefault();

    const rect = svg.getBoundingClientRect();
    const situer = (e) => ({
      sx: ((e.clientX - rect.left) / rect.width) * 100,
      sy: ((e.clientY - rect.top) / rect.height) * 186,
    });

    state.drag = { index, bouge: false };
    groupe.classList.add('is-dragging');
    svg.classList.add('is-dragging');
    try { svg.setPointerCapture(ev.pointerId); } catch { /* non bloquant */ }

    const deplacer = (e) => {
      const ball = state.current?.balls?.[index];
      if (!ball) return;
      const { sx, sy } = situer(e);
      const cible = depuisSchema(sx, sy);
      state.drag.bouge = true;

      // La position dessinée vaut lateralPercent + décalage : on retire le
      // décalage avant d'inverser, sinon la balle sauterait à la saisie.
      ball.dropPoint = dropPointFromLateral(cible.xPercent - placementCourant().lateralShift);

      // Glissement vertical : on agit d'abord sur LE paramètre choisi par le
      // sélecteur — la vitesse par défaut, ou la hauteur.
      //
      // Avant, le geste réglait la HAUTEUR en premier et ne touchait la vitesse
      // qu'ensuite : le sélecteur ne servait donc à rien, et un glissement
      // « vitesse » ne changeait que la hauteur. C'était l'inverse de ce qui
      // était annoncé.
      const res = solveDepthParameter({
        depthPercent: cible.profondeurPercent,
        knob: state.dragKnob,
        speed: ball.speed,
        height: ball.height,
        spin: ball.spin,
      });
      const autre = state.dragKnob === 'height' ? 'speed' : 'height';
      if (state.dragKnob === 'height') ball.height = res.value;
      else ball.speed = res.value;

      // Si le paramètre choisi ne suffit pas à atteindre la profondeur visée, on
      // complète avec l'autre : sinon la balle se bloquerait au milieu de la
      // table et le geste paraîtrait cassé. Le réglage principal reste le bon.
      let complement = null;
      if (res.saturated) {
        complement = solveDepthParameter({
          depthPercent: cible.profondeurPercent,
          knob: autre,
          speed: ball.speed,
          height: ball.height,
          spin: ball.spin,
        });
        if (autre === 'height') ball.height = complement.value;
        else ball.speed = complement.value;
      }

      recomputeDerived(ball);

      // On ne déplace QUE la balle saisie.
      const ou = versSchema(ball.x, ball.y);
      groupe.setAttribute('transform', `translate(${ou.x} ${ou.y})`);
      majLigne(index, ball);
      majLectureGlissement(ball, {
        saturated: complement ? complement.saturated : res.saturated,
      });
      renderSideView(state.current);
      marquerModifie();
    };

    const terminer = () => {
      svg.removeEventListener('pointermove', deplacer);
      svg.removeEventListener('pointerup', terminer);
      svg.removeEventListener('pointercancel', terminer);
      try { svg.releasePointerCapture(ev.pointerId); } catch { /* déjà relâché */ }
      groupe.classList.remove('is-dragging');
      svg.classList.remove('is-dragging');

      const bouge = state.drag?.bouge;
      state.drag = null;
      const lecture = $('#drag-readout');
      if (lecture) lecture.textContent = '';

      if (bouge) {
        // Re-tracé complet : tout se recale sur les valeurs arrondies.
        renderBallRows();
        renderTable(state.current);
        // Puis on recale sur ce que les roues acceptent réellement.
        recalerBalles({ index });
      } else {
        // Un simple clic sélectionne la balle.
        selectionnerBalle(index, { focus: true });
      }
    };

    svg.addEventListener('pointermove', deplacer);
    svg.addEventListener('pointerup', terminer);
    svg.addEventListener('pointercancel', terminer);
  });

  // Accessibilité au clavier : Entrée sélectionne, les flèches déplacent.
  groupe.addEventListener('keydown', (ev) => {
    const ball = state.current?.balls?.[index];
    if (!ball) return;
    const pas = ev.shiftKey ? 2 : 0.5;
    const borne = (v, min, max, p) => Math.min(max, Math.max(min, Math.round(v / p) * p));

    if (ev.key === 'Enter' || ev.key === ' ') {
      selectionnerBalle(index, { focus: true });
    } else if (ev.key === 'ArrowLeft') {
      ball.dropPoint = borne(ball.dropPoint + pas, -10, 10, 0.5);
    } else if (ev.key === 'ArrowRight') {
      ball.dropPoint = borne(ball.dropPoint - pas, -10, 10, 0.5);
    } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      const delta = ev.key === 'ArrowDown' ? 4 : -4;
      const res = solveDepthParameter({
        depthPercent: (ball.y ?? 50) + delta,
        knob: state.dragKnob,
        speed: ball.speed,
        height: ball.height,
        spin: ball.spin,
      });
      if (state.dragKnob === 'height') ball.height = res.value;
      else ball.speed = res.value;
    } else {
      return;
    }

    ev.preventDefault();
    recomputeDerived(ball);
    marquerModifie();
    renderBallRows();
    renderTable(state.current);
    renderSideView(state.current);
    document.querySelector(`.ball-row[data-index="${index}"]`)?.classList.add('is-selected');
    recalerBalles({ index });
  });
}

/* ============================================================= VUE DE CÔTÉ = */

/**
 * Vue de côté : profil du plateau, filet, robot, et trajectoire des balles.
 *
 * Les trajectoires viennent de `src/ballistics.js`, le MÊME module que celui qui
 * donne la profondeur de la vue du dessus : les deux vues ne peuvent donc pas se
 * contredire. La balle sélectionnée est mise en avant, les autres restent en
 * filigrane pour garder le contexte de l'exercice.
 */
const SIDE = { w: 1000, h: 300, heightMeters: 0.9 };

function renderSideView(drill) {
  const svg = $('#side-view');
  svg.innerHTML = '';
  if (!svg) return;

  const projeter = projector({ heightMeters: SIDE.heightMeters });
  const px = (x, y) => {
    const q = projeter(x, y);
    return { x: q.x, y: (q.y / 1000) * SIDE.h };
  };

  const add = (tag, attrs, text) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text !== undefined) el.textContent = text;
    svg.append(el);
    return el;
  };

  // --- sol
  const sol = px(0, 0).y;
  add('line', {
    x1: 0, y1: sol, x2: SIDE.w, y2: sol,
    stroke: 'var(--line)', 'stroke-width': 2,
  });

  // --- table : la surface de jeu de 0 à 2,74 m
  const bordGauche = px(0, 0).x;
  const bordDroit = px(TABLE.length, 0).x;
  add('rect', {
    x: bordGauche, y: sol, width: bordDroit - bordGauche, height: 7,
    fill: 'var(--accent-2)', opacity: 0.35,
  });
  add('text', {
    x: (bordGauche + bordDroit) / 2, y: sol + 24, 'font-size': 15,
    'text-anchor': 'middle', fill: 'var(--muted)', 'font-family': 'sans-serif',
  }, 'table (2,74 m)');

  // --- filet
  const netX = px(TABLE.netX, 0).x;
  const netTop = px(TABLE.netX, TABLE.netHeight).y;
  add('line', {
    x1: netX, y1: sol, x2: netX, y2: netTop,
    stroke: 'var(--muted)', 'stroke-width': 3,
  });
  add('text', {
    x: netX + 6, y: netTop - 6, 'font-size': 14,
    fill: 'var(--muted)', 'font-family': 'sans-serif',
  }, `filet ${(TABLE.netHeight * 100).toFixed(1)} cm`);

  // --- robot, à la distance réelle de la case choisie
  const LAUNCH_X = placementCourant().launchX ?? LAUNCH.x;
  const robot = px(LAUNCH_X, LAUNCH_Y);
  add('rect', {
    x: robot.x - 16, y: robot.y, width: 32, height: sol - robot.y,
    rx: 4, fill: 'var(--accent)', opacity: 0.35,
  });
  add('circle', { cx: robot.x, cy: robot.y, r: 6, fill: 'var(--accent)' });
  add('text', {
    x: robot.x, y: robot.y - 12, 'font-size': 14, 'text-anchor': 'middle',
    fill: 'var(--muted)', 'font-family': 'sans-serif',
  }, 'robot');

  const balls = drill?.balls ?? [];
  if (balls.length === 0) {
    add('text', {
      x: SIDE.w / 2, y: SIDE.h / 2, 'font-size': 16, 'text-anchor': 'middle',
      fill: 'var(--muted)', 'font-family': 'sans-serif',
    }, 'aucune balle');
    const cap = $('#side-caption');
    if (cap) cap.textContent = '';
    return;
  }

  const FILL = {
    green: 'var(--green)', yellow: 'var(--yellow)',
    orange: 'var(--orange)', blue: 'var(--blue)', grey: 'var(--grey)',
  };

  const selection = Math.min(Math.max(0, state.selectedBall), balls.length - 1);

  /** Chemin SVG d'une trajectoire, projeté directement à l'échelle de la vue. */
  const cheminDe = (pred) => pred.points
    .map((pt, i) => {
      const q = px(pt.x, pt.y);
      return `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)},${q.y.toFixed(1)}`;
    })
    .join(' ');

  // Les balles non sélectionnées d'abord, en filigrane.
  balls.forEach((b, i) => {
    if (i === selection) return;
    const p = predictBall(b, placementCourant());
    add('path', {
      d: cheminDe(p),
      fill: 'none',
      stroke: FILL[b.color] ?? 'var(--grey)',
      'stroke-width': 1.6,
      opacity: 0.28,
    });
  });

  // --- balle sélectionnée : trajectoire, points remarquables, mesures
  const ball = balls[selection];
  const pred = predictBall(ball, placementCourant());
  const couleur = FILL[ball.color] ?? 'var(--grey)';

  add('path', {
    d: cheminDe(pred), fill: 'none', stroke: couleur, 'stroke-width': 3.5,
    'stroke-linecap': 'round',
  });

  // Départ
  const depart = px(pred.points[0].x, pred.points[0].y);
  add('circle', { cx: depart.x, cy: depart.y, r: 5, fill: couleur });

  // Sommet de la trajectoire
  const indexSommet = pred.points.reduce(
    (best, p, i) => (p.y > pred.points[best].y ? i : best), 0,
  );
  const sommet = px(pred.points[indexSommet].x, pred.points[indexSommet].y);
  add('circle', {
    cx: sommet.x, cy: sommet.y, r: 4, fill: 'none',
    stroke: couleur, 'stroke-width': 2, opacity: 0.8,
  });

  // Point de chute, avec son numéro
  const chute = px(pred.landingX, 0);
  add('circle', {
    cx: chute.x, cy: chute.y - 9, r: 10, fill: couleur,
    stroke: 'var(--panel)', 'stroke-width': 1.5,
  });
  add('text', {
    x: chute.x, y: chute.y - 9, 'font-size': 12, 'font-weight': 700,
    'text-anchor': 'middle', 'dominant-baseline': 'central',
    fill: '#10131a', 'font-family': 'sans-serif',
  }, String(selection + 1));

  // Hauteur au-dessus du filet : c'est l'information la plus utile.
  if (pred.netClearance !== null) {
    const auFilet = px(TABLE.netX, pred.netClearance);
    add('line', {
      x1: auFilet.x, y1: sol, x2: auFilet.x, y2: auFilet.y,
      stroke: pred.clearsNet ? 'var(--green)' : '#e07a7a',
      'stroke-width': 1.4, 'stroke-dasharray': '4 3',
    });
    add('text', {
      x: auFilet.x + 7, y: auFilet.y - 5, 'font-size': 13,
      fill: pred.clearsNet ? 'var(--green)' : '#e07a7a', 'font-family': 'sans-serif',
    }, `${(pred.netClearance * 100).toFixed(0)} cm ${pred.clearsNet ? 'au-dessus du filet' : '— NE PASSE PAS'}`);
  }

  // Premier rebond (hauteur négative) : c'est le repère qui distingue un service
  // direct d'un service qui rebondit d'abord sur la moitié du robot (manuel §3.5.4).
  if (pred.firstBounceX !== null) {
    const bond = px(pred.firstBounceX, 0);
    add('circle', {
      cx: bond.x, cy: bond.y - 5, r: 5, fill: 'none',
      stroke: couleur, 'stroke-width': 2, 'stroke-dasharray': '3 2',
    });
    add('text', {
      x: bond.x, y: bond.y - 14, 'font-size': 12, 'text-anchor': 'middle',
      fill: 'var(--muted)', 'font-family': 'sans-serif',
    }, '1er rebond');
  }

  const cap = $('#side-caption');
  if (cap) {
    const n = pred.bounces;
    const rebonds = `${n} rebond${n > 1 ? 's' : ''}`
      + (pred.firstBounceX !== null
        ? ` (dont 1 sur la moitié du robot, à ${Math.abs(pred.firstBounceX - placementCourant().launchX).toFixed(2)} m)`
        : '');
    cap.textContent =
      `— balle ${selection + 1} : ${ball.effect ?? ''}, ${rebonds}, `
      + `${(pred.flightTime * 1000).toFixed(0)} ms de parcours, `
      + `sommet ${(pred.apex * 100).toFixed(0)} cm, `
      + `profondeur ${pred.depth} %`;
  }
}

/** Sélectionne une balle : met sa trajectoire en avant dans la vue de côté. */
function selectionnerBalle(index, { focus = false } = {}) {
  state.selectedBall = index;
  document.querySelectorAll('.ball-row').forEach((r, i) => {
    r.classList.toggle('is-selected', i === index);
  });
  if (state.current) renderSideView(state.current);
  if (focus) {
    const ligne = document.querySelector(`.ball-row[data-index="${index}"]`);
    ligne?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    ligne?.querySelector('input')?.focus();
  }
}

/* ======================================================== ÉDITEUR DE BALLES */

/** Recalcule les champs dérivés (position, couleur) après une modification. */
function recomputeDerived(ball) {
  // Le placement latéral du robot décale toute la zone couverte : la position
  // dessinée en tient compte, sinon bouger le robot sur le côté ne changerait
  // rien à l'écran.
  const placement = placementCourant();
  ball.x = Math.min(100, Math.max(0, lateralPercent(ball.dropPoint) + placement.lateralShift));
  // La profondeur dépend de la vitesse, de la hauteur ET de l'effet ; le nombre
  // de rebonds vient de la hauteur.
  const vol = predictBall(ball, placementCourant());
  ball.y = vol.depth;
  ball.bounces = vol.bounces;
  ball.firstBounceX = vol.firstBounceX;
  const effet = effectiveSpin(ball.spin, state.headAngle);
  ball.effect = effet.label;
  ball.effectFamily = effet.family;
  ball.color = spinColor(ball.spin, state.headAngle);
  ball.topBack = effet.topBack;
  ball.side = effet.side;
}

/** Numéro de la dernière demande de recalage (voir `recalerBalles`). */
let recalageCompteur = 0;

/**
 * Recalcule les balles auprès du serveur et affiche ce qu'il retient.
 *
 * C'est le même code que celui qui prépare le paquet envoyé au robot : l'écran
 * ne peut donc pas montrer une valeur que le robot refusera. Quand une
 * combinaison vitesse/effet dépasse ce que les roues savent faire, elle est
 * corrigée ici, sous les yeux de l'utilisateur, et non silencieusement à
 * l'enregistrement.
 *
 * On ne touche à RIEN s'il n'y a aucune correction : inutile de reconstruire la
 * liste (et de faire perdre le focus) pour rien.
 */
async function recalerBalles({ index = null, champ = null } = {}) {
  if (!state.current) return;
  // Deux recalculs peuvent se chevaucher (on quitte un champ pendant qu'un
  // autre est encore en vol). On numérote les demandes et l'on ignore toute
  // réponse qui n'est plus la dernière partie : sinon une réponse en retard
  // réécrirait des valeurs plus anciennes par-dessus les nouvelles.
  const demande = ++recalageCompteur;
  let res;
  try {
    res = await api('/api/normalize', {
      method: 'POST',
      body: { balls: state.current.balls },
    });
  } catch (err) {
    if (demande === recalageCompteur) notice(err.message, 'error');
    return;
  }
  if (demande !== recalageCompteur) return;

  const corrections = (res.adjustments ?? []).filter(Boolean);
  if (!corrections.length) return;

  // On modifie les objets balle EXISTANTS au lieu de les remplacer. Les lignes
  // de l'éditeur gardent une référence à leur balle : les remplacer ferait
  // écrire les saisies suivantes dans des objets devenus orphelins, et la
  // correction silencieuse suivante repartirait des anciennes valeurs.
  res.balls.forEach((balle, i) => {
    const cible = state.current.balls[i];
    if (cible) Object.assign(cible, balle);
    else state.current.balls[i] = { ...balle };
  });

  // Mise à jour SUR PLACE, sans reconstruire la liste : reconstruire la liste
  // détruirait le champ vers lequel l'utilisateur est justement en train de
  // passer, et son clic serait perdu.
  state.current.balls.forEach((balle, i) => {
    recomputeDerived(balle);
    majLigne(i, balle);
  });
  if (index !== null && champ) {
    const vise = document.querySelector(`.ball-row[data-index="${index}"] input[data-field="${champ}"]`);
    // `majLigne` épargne le champ qui a le focus ; s'il est encore sur celui-ci,
    // c'est nous qui le corrigeons, pour que la valeur affichée soit la bonne.
    if (vise) vise.value = state.current.balls[index][champ];
  }
  renderTable(state.current);
  renderSideView(state.current);
  marquerModifie();
  notice(`Valeurs corrigées pour rester jouables :\n`
    + corrections.map((c) => `  • ${c}`).join('\n'));
}

/** Durée lisible, pour les infobulles et les messages. */
function formatPause(secondes) {
  const s = Number(secondes) || 0;
  if (s <= 0) return 'aucune pause';
  const arrondi = Math.round(s * 100) / 100;
  return `${String(arrondi).replace('.', ',')} s`;
}

/* ------------------------------------------- copier, coller, réordonner --- */

/**
 * Nombre maximal de balles dans un exercice.
 *
 * Miroir de `MAX_BALLS` dans `src/protocol.js`. Le serveur reste le garde-fou
 * (il refuse au-delà) ; cette copie ne sert qu'à désactiver les boutons avant
 * que l'utilisateur ne tente un ajout voué à l'échec.
 */
const MAX_BALLES = 20;

/** Les six réglages qui définissent une balle, et eux seuls. */
const REGLAGES_BALLE = ['speed', 'spin', 'height', 'dropPoint', 'frequency', 'reps'];

/**
 * Intervertit deux balles de l'exercice.
 *
 * La pause voyage AVEC sa balle : elle est affichée « pause après la balle N »,
 * donc elle doit rester après elle quand elle change de position, et non rester
 * collée à une place.
 */
function echangerBalles(de, vers) {
  const balls = state.current?.balls;
  if (!balls) return;
  if (vers < 0 || vers >= balls.length) return;
  [balls[de], balls[vers]] = [balls[vers], balls[de]];
  state.selectedBall = vers;
  marquerModifie();
  renderBallRows();
  renderTable(state.current);
  renderSideView(state.current);
  notice(`Balle ${de + 1} déplacée en position ${vers + 1}.`);
}

/** Copie les réglages d'une balle, pour les coller ensuite. */
function copierBalle(index) {
  const balle = state.current?.balls?.[index];
  if (!balle) return;
  // On ne garde que les six réglages : ni les valeurs calculées (position,
  // couleur, tr/min), qui seront recalculées, ni la pause, qui appartient à
  // l'intervalle entre deux balles et non à la balle.
  state.copiedBall = Object.fromEntries(REGLAGES_BALLE.map((c) => [c, balle[c]]));
  majBoutonColler();
  // Le presse-papiers appartient à l'APPLICATION, pas à l'exercice : il survit
  // donc à un changement d'exercice, et sert à transporter une balle d'un
  // exercice à un autre.
  notice(`Réglages de la balle ${index + 1} copiés. « Coller » les ajoutera à la fin — `
    + 'y compris dans un autre exercice.');
}

/** Ajoute à la fin une balle portant les réglages copiés. */
function collerBalle() {
  if (!state.current || !state.copiedBall) return;
  if (state.current.balls.length >= MAX_BALLES) {
    notice(`Impossible : ${MAX_BALLES} balles au maximum par exercice.`, 'error');
    return;
  }
  state.current.balls.push({ ...state.copiedBall, pauseAfter: 0 });
  state.selectedBall = state.current.balls.length - 1;
  marquerModifie();
  renderBallRows();
  renderTable(state.current);
  renderSideView(state.current);
  notice(`Balle collée en position ${state.current.balls.length}.`);
}

/** Active « Coller » et « + Balle » selon le presse-papiers et la limite. */
function majBoutonColler() {
  const nombre = state.current?.balls?.length ?? 0;
  const plein = nombre >= MAX_BALLES;
  const coller = $('#btn-paste-ball');
  if (coller) {
    coller.disabled = !state.copiedBall || plein;
    coller.title = !state.copiedBall
      ? 'Copie d’abord une balle avec le bouton « Copier »'
      : (plein ? `${MAX_BALLES} balles au maximum` : 'Coller à la fin les réglages de la balle copiée');
  }
  const ajouter = $('#btn-add-ball');
  if (ajouter) {
    ajouter.disabled = plein;
    ajouter.title = plein ? `${MAX_BALLES} balles au maximum` : 'Ajouter une balle à la fin';
  }
  const compte = $('#ball-count');
  if (compte) compte.classList.toggle('is-full', plein);
}

/**
 * Construit le séparateur placé après la balle `index`.
 *
 * Il existe APRÈS CHAQUE balle, y compris la dernière : quand l'exercice boucle
 * (séries ou sans fin), l'intervalle entre la dernière balle d'un tour et la
 * première du suivant est un temps de récupération, et il mérite d'être réglé
 * comme les autres.
 */
function construireSeparateur(index, secondes, { derniere = false } = {}) {
  const valeur = Number(secondes) || 0;
  const bloc = document.createElement('div');
  bloc.className = 'between' + (valeur > 0 ? ' has-pause' : '');
  bloc.innerHTML = `
    <span class="between-line"></span>
    <label class="between-label" title="${infobullePause(index, valeur, derniere)}">
      <span class="between-icon">⏸</span>
      <span class="between-text">pause après la balle ${index + 1}${
        derniere ? ' <em>(entre deux tours)</em>' : ''}</span>
      <input type="number" min="0" max="600" step="1" value="${valeur}">
      <span class="between-unit">s</span>
    </label>
    <span class="between-line"></span>`;

  const champ = bloc.querySelector('input');
  champ.addEventListener('input', () => {
    if (!state.current) return;
    // Une valeur vide vaut 0 ; le reste est borné à 600 s.
    const saisie = Math.max(0, Math.min(600, Math.round(Number(champ.value) || 0)));
    state.current.balls[index].pauseAfter = saisie;
    bloc.classList.toggle('has-pause', saisie > 0);
    majInfobulle(bloc, index, derniere);
    marquerModifie();
  });
  // Quitter le champ nettoie « 007 » ou « 5,4 » en une valeur propre.
  champ.addEventListener('blur', () => {
    const apres = state.current?.balls?.[index]?.pauseAfter ?? 0;
    champ.value = String(apres);
    bloc.classList.toggle('has-pause', apres > 0);
    majInfobulle(bloc, index, derniere);
  });

  return bloc;
}

/** Texte d'aide du séparateur. */
function infobullePause(index, secondes, derniere) {
  const suite = derniere
    ? 'La balle suivante est la première du tour d’après : c’est un temps de récupération.'
    : `Elle s’intercale avant la balle ${index + 2}.`;
  return `Temps d'arrêt APRÈS la balle ${index + 1}. ${suite} `
    + `0 = enchaîner directement.${secondes > 0 ? ` Ici ${formatPause(secondes)}.` : ''}`;
}

/** Met à jour l'infobulle du séparateur. */
function majInfobulle(bloc, index, derniere = false) {
  const secondes = state.current?.balls?.[index]?.pauseAfter ?? 0;
  const label = bloc.querySelector('.between-label');
  if (label) label.title = infobullePause(index, secondes, derniere);
}

/** Le séparateur d'après la balle `index` concerne-t-il la dernière balle ? */
const estDerniere = (index) => index === (state.current?.balls?.length ?? 0) - 1;

function renderBallRows() {
  const conteneur = $('#ball-rows');
  conteneur.innerHTML = '';
  const balls = state.current?.balls ?? [];
  $('#ball-count').textContent = String(balls.length);

  const FILL = {
    green: 'var(--green)', yellow: 'var(--yellow)',
    orange: 'var(--orange)', blue: 'var(--blue)', grey: 'var(--grey)',
  };

  balls.forEach((b, i) => {
    recomputeDerived(b);

    const ligne = document.createElement('div');
    ligne.className = 'ball-row';
    ligne.dataset.index = String(i);
    ligne.style.borderLeftColor = FILL[b.color] ?? 'var(--grey)';

    const champs = [
      ['speed', 'vitesse', 0, 10, 0.5],
      ['spin', 'effet', -10, 10, 0.5],
      ['height', 'hauteur', -50, 100, 1],
      ['dropPoint', 'placement', -10, 10, 0.5],
      ['frequency', 'bpm', 30, 90, 1],
      ['reps', 'rép.', 1, 200, 1],
    ];

    ligne.innerHTML = `
      <div class="ball-row-head">
        <span class="num" style="background:${FILL[b.color] ?? 'var(--grey)'}">${i + 1}</span>
        <span class="effect">${escapeHtml(b.effect ?? '')}</span>
        <button class="btn btn-ghost tiny" data-action="up" ${i === 0 ? 'disabled' : ''}
                title="Monter : la balle ${i + 1} passe en position ${i}">↑</button>
        <button class="btn btn-ghost tiny" data-action="down" ${i === balls.length - 1 ? 'disabled' : ''}
                title="Descendre : la balle ${i + 1} passe en position ${i + 2}">↓</button>
        <button class="btn btn-ghost tiny" data-action="copy"
                title="📋 Copier les réglages de cette balle, pour les coller ensuite">Copier</button>
        <button class="btn btn-ghost tiny" data-action="test"
                title="▶ Envoyer seulement cette balle au robot, pour vérifier ses paramètres">Tester</button>
        <button class="btn btn-ghost tiny" data-action="remove" title="Supprimer">✕</button>
      </div>
      <div class="fields">
        ${champs.map(([cle, label, min, max, step]) => `
          <label>${label}
            <input type="number" data-field="${cle}" value="${b[cle]}"
                   min="${min}" max="${max}" step="${step}">
            ${cle === 'speed' || cle === 'spin'
              ? `<small class="plafond plafond-${cle}"></small>`
              : ''}
          </label>`).join('')}
      </div>`;

    majPlafonds(ligne, b);

    // Travailler dans une ligne met sa trajectoire en avant dans la vue de côté.
    ligne.addEventListener('focusin', () => {
      if (state.selectedBall !== i) selectionnerBalle(i);
    });

    ligne.addEventListener('input', (ev) => {
      const input = ev.target.closest('input[data-field]');
      if (!input) return;
      const valeur = Number(input.value);
      if (!Number.isFinite(valeur)) return;
      b[input.dataset.field] = valeur;
      marquerModifie();
      recomputeDerived(b);
      ligne.style.borderLeftColor = FILL[b.color] ?? 'var(--grey)';
      ligne.querySelector('.num').style.background = FILL[b.color] ?? 'var(--grey)';
      ligne.querySelector('.effect').textContent = b.effect ?? '';
      renderTable(state.current);
      renderSideView(state.current);
    });

    // Fin de saisie : on demande au serveur ce qu'il retiendrait réellement.
    // `input` met à jour en direct pendant la frappe, `change` recale ensuite.
    ligne.addEventListener('change', (ev) => {
      const input = ev.target.closest('input[data-field]');
      if (input) recalerBalles({ index: i, champ: input.dataset.field });
    });

    ligne.addEventListener('click', (ev) => {
      const action = ev.target.closest('button')?.dataset.action;
      if (action === 'test') {
        testerBalle(i);
      } else if (action === 'remove') {
        balls.splice(i, 1);
        marquerModifie();
        if (state.selectedBall >= balls.length) state.selectedBall = Math.max(0, balls.length - 1);
        renderBallRows();
        renderTable(state.current);
        renderSideView(state.current);
      } else if (action === 'up') {
        echangerBalles(i, i - 1);
      } else if (action === 'down') {
        echangerBalles(i, i + 1);
      } else if (action === 'copy') {
        copierBalle(i);
      }
    });

    conteneur.append(ligne);

    // Séparateur après CETTE balle : c'est là qu'on décide d'une pause, et de
    // combien de secondes. 0 = enchaînement direct. Il existe aussi après la
    // dernière balle, pour régler la récupération entre deux tours.
    conteneur.append(construireSeparateur(i, b.pauseAfter ?? 0, {
      derniere: i === balls.length - 1,
    }));
  });

  if (balls.length === 0) {
    conteneur.innerHTML = '<p class="hint">Aucune balle. Ajoute-en une, ou génère un exercice par IA.</p>';
  }

  majBoutonColler();
}

/**
 * Met à jour l'état « il y a des changements à enregistrer ».
 *
 * Le bouton Enregistrer est TOUJOURS visible quand un exercice est ouvert, et
 * simplement désactivé tant qu'il n'y a rien à enregistrer : un bouton qui
 * apparaît et disparaît est plus difficile à trouver qu'un bouton grisé.
 */
function marquerModifie() {
  state.dirty = true;
  majBoutonEnregistrer();
  $('#btn-revert').hidden = false;
}

/**
 * Reflète les réglages d'envoi dans les champs.
 *
 * Ils appartiennent à la session, pas à l'exercice : les modifier ne marque donc
 * PAS l'exercice comme modifié, et n'appelle jamais `marquerModifie`.
 */
function majReglagesEnvoi() {
  const e = state.envoi;
  const random = $('#drill-random');
  if (random) random.value = String(Boolean(e.random));
  const mode = $('#drill-mode');
  if (mode) mode.value = e.mode ?? 'endless';
  const valeur = $('#drill-mode-value');
  if (valeur) valeur.value = e.modeValue ?? 1;
  const compte = $('#chk-countdown');
  if (compte) compte.checked = e.countdown !== false;
  // La valeur du mode ne sert qu'aux modes « minutes » et « séries ».
  const ligne = $('#drill-mode-value');
  if (ligne) ligne.disabled = (e.mode ?? 'endless') === 'endless';

  // On le dit à l'écran : ces réglages ne seront pas enregistrés.
  const note = $('#envoi-note');
  if (note) {
    note.textContent = e.mode === 'endless'
      ? 'Sans fin · non enregistré'
      : `${e.mode === 'minutes' ? `${e.modeValue} min` : `${e.modeValue} série(s)`} · non enregistré`;
  }
}

/** Active le bouton Enregistrer selon ce qu'il y a à enregistrer. */
function majBoutonEnregistrer() {
  const bouton = $('#btn-save');
  if (!bouton) return;
  const ouvert = Boolean(state.current);
  bouton.disabled = !ouvert || (!state.dirty && Boolean(state.originalId));

  // Un nom modifié veut dire « nouvel exercice » : autant l'écrire sur le
  // bouton, pour que personne ne découvre après coup ce qui s'est passé.
  const nomAChange = Boolean(state.originalId)
    && (state.current?.name ?? '').trim() !== (state.nomCharge ?? '').trim()
    && (state.current?.name ?? '').trim() !== '';
  bouton.textContent = !ouvert
    ? 'Enregistrer dans ma librairie'
    : (nomAChange
      ? `Enregistrer comme nouvel exercice « ${state.current.name} »`
      : 'Enregistrer dans ma librairie');
  bouton.title = !ouvert
    ? 'Ouvre ou crée d’abord un exercice.'
    : (nomAChange
      ? `« ${state.nomCharge} » sera conservé : le nouveau nom crée un exercice séparé.`
      : 'Met à jour cet exercice dans ta librairie.');
  const renommer = $('#btn-rename');
  if (renommer) {
    renommer.disabled = !state.originalId;
    renommer.title = nomAChange
      ? `Renommer « ${state.nomCharge} » sur place, au lieu de créer un nouvel exercice`
      : 'Changer le nom de CET exercice, sans en créer un nouveau';
  }
  bouton.title = !ouvert
    ? 'Ouvre ou crée d’abord un exercice'
    : state.dirty
      ? 'Enregistrer les changements dans ta librairie'
      : 'Aucun changement à enregistrer';
}

/* ========================================================= AFFICHAGE D'UN EXO */

async function afficherExercice(drill, { originalId = null, isDraft = false } = {}) {
  state.current = {
    ...drill,
    balls: (drill.balls ?? []).map((b) => ({ ...b })),
  };
  state.originalId = originalId;
  state.nomCharge = state.current.name ?? '';
  state.dirty = false;

  // L'exercice porte son propre réglage physique : on l'applique à l'interface
  // pour que les vues soient calculées avec LUI, pas avec le réglage courant.
  if (drill.headAngle !== undefined && drill.headAngle !== state.headAngle) {
    state.headAngle = normalizeHeadAngle(drill.headAngle);
    const sel = $('#head-angle');
    if (sel && ![...sel.options].some((o) => Number(o.value) === state.headAngle)) {
      sel.append(new Option(`${state.headAngle}°`, String(state.headAngle)));
    }
    if (sel) sel.value = String(state.headAngle);
  }
  if (drill.robotSquare !== undefined && drill.robotSquare !== state.setup.square) {
    state.setup = { ...state.setup, square: normalizeSquare(drill.robotSquare) };
    document.querySelectorAll('#setup-grid button').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.index) === state.setup.square);
    });
    const resume = $('#setup-summary');
    if (resume) resume.textContent = `— ${squareAt(state.setup.square).label}`;
  }

  const brouillon = isDraft || !originalId;
  const champNom = $('#drill-name');
  champNom.disabled = false;
  champNom.value = state.current.name || 'Brouillon';
  $('#drill-id').textContent = brouillon ? '(pas encore enregistré)' : `(${originalId})`;
  majBoutonEnregistrer();
  $('#btn-revert').hidden = true;
  $('#btn-send').disabled = false;
  $('#btn-export').disabled = false;
  $('#btn-share').disabled = false;
  $('#btn-delete').disabled = brouillon;

  // Un BROUILLON (généré par l'IA, importé) porte une intention de mode : on
  // l'adopte. Un exercice de la librairie, non — le mode n'en fait plus partie.
  if (isDraft) {
    if (drill.mode) state.envoi.mode = drill.mode;
    if (drill.modeValue !== undefined) state.envoi.modeValue = drill.modeValue;
    if (drill.random !== undefined) state.envoi.random = Boolean(drill.random);
  }
  majReglagesEnvoi();

  state.selectedBall = 0;
  renderBallRows();
  renderTable(state.current);
  renderSideView(state.current);
  notice('');

  document.querySelectorAll('#library-list li').forEach((li) => {
    li.classList.toggle('is-active', li.dataset.id === originalId);
  });

  // Un exercice enregistré AVANT que le plafond des roues soit calculé
  // correctement peut contenir une combinaison que le robot ne sait pas jouer
  // (typiquement 8,5 / effet 3, qui demande 7355 tr/min). On le recale tout de
  // suite : l'écran annonce donc la valeur réellement jouée, et l'exercice est
  // marqué modifié pour qu'un enregistrement la conserve. On ne l'écrit pas en
  // douce : c'est l'utilisateur qui décide, en enregistrant.
  recalerBalles();
}

/* =============================================================== LIBRAIRIE */

async function chargerLibrairie() {
  const { count, drills } = await api('/api/drills');
  $('#library-count').textContent = String(count);
  const liste = $('#library-list');
  liste.innerHTML = '';

  if (count === 0) {
    liste.innerHTML = '<li class="empty">Aucun exercice. Crée-en un par IA, ou importe un fichier.</li>';
    return;
  }

  const filtre = $('#library-search').value.trim().toLowerCase();
  const visibles = filtre
    ? drills.filter((d) => d.name.toLowerCase().includes(filtre)
      || d.id.includes(filtre)
      || (d.tags ?? []).some((t) => t.includes(filtre)))
    : drills;

  for (const d of visibles) {
    const li = document.createElement('li');
    li.dataset.id = d.id;
    if (d.id === state.originalId) li.classList.add('is-active');

    li.innerHTML = `
      <span class="name">${escapeHtml(d.name)}</span>
      <span class="meta">${d.balls.length} balle(s)</span>
      <span class="mini-balls">${d.balls.map((b) => `
        <i class="mini-ball" style="background:${
          { green: 'var(--green)', yellow: 'var(--yellow)', orange: 'var(--orange)', blue: 'var(--blue)', grey: 'var(--grey)' }[b.color] ?? 'var(--grey)'
        }" title="Balle ${b.index} — ${escapeHtml(b.effect)}">${b.index}</i>`).join('')}</span>`;

    li.addEventListener('click', async () => {
      // Avant même de demander l'exercice au serveur : inutile de le charger si
      // l'on doit rester ici.
      if (!await peutQuitter({ action: `ouvrir « ${d.name} »` })) return;
      const { drill } = await api(`/api/drills/${encodeURIComponent(d.id)}`);
      await afficherExercice(drill, { originalId: d.id });
    });

    liste.append(li);
  }

  if (visibles.length === 0) {
    liste.innerHTML = '<li class="empty">Aucun exercice ne correspond au filtre.</li>';
  }
}

/* ===================================================================== IA == */

async function generer() {
  const description = $('#ai-prompt').value.trim();
  if (!description) {
    setStatus('#ai-status', 'Décris d’abord ce que tu veux travailler.', 'is-error');
    return;
  }

  // Le garde-fou passe AVANT l'appel à DeepSeek : inutile de payer des jetons
  // pour un exercice que l'on refuserait ensuite d'ouvrir.
  if (!await peutQuitter({ action: 'ouvrir l’exercice généré' })) {
    $('#btn-generate').disabled = false;
    return;
  }

  $('#btn-generate').disabled = true;
  setStatus(
    '#ai-status',
    `<span class="spinner"></span>DeepSeek réfléchit… `
    + `(tête à ${state.headAngle}°, cela prend une vingtaine de secondes)`,
    'is-busy',
  );

  try {
    const res = await api('/api/generate', {
      method: 'POST',
      body: { description, name: $('#ai-name').value.trim() || undefined },
    });

await afficherExercice(res.drill, { originalId: null, isDraft: true });

    const details = [];
    if (res.summary) details.push(escapeHtml(res.summary));
    if (res.coachingNotes) details.push(`<em>${escapeHtml(res.coachingNotes)}</em>`);
    if (res.adjustments?.length) {
      details.push(`<span class="small">Ajusté : ${res.adjustments.map(escapeHtml).join(' ; ')}</span>`);
    }
    details.push('<strong>Vérifie puis enregistre.</strong>');
    setStatus('#ai-status', details.join('<br>'), 'is-ok');
    notice('Exercice généré. Il n’est pas encore enregistré : vérifie-le, puis clique « Enregistrer ».');
  } catch (err) {
    setStatus('#ai-status', escapeHtml(err.message), 'is-error');
  } finally {
    $('#btn-generate').disabled = false;
  }
}

/* ==================================================== LIBRAIRIE EN LIGNE == */

async function chargerCloud(page = 1) {
  state.cloudPage = page;
  $('#cloud-list').innerHTML = '<li class="empty">Chargement…</li>';
  try {
    const params = new URLSearchParams({ page: String(page), perPage: '20' });
    const recherche = $('#cloud-search').value.trim();
    if (recherche) params.set('search', recherche);

    const res = await api(`/api/cloud?${params}`);
    state.cloudTotal = res.total;
    $('#cloud-status').textContent = `${res.total} exercice(s) partagé(s) — page ${res.page}`;
    $('#cloud-page').textContent = `${res.page} / ${Math.max(1, Math.ceil(res.total / res.perPage))}`;

    const liste = $('#cloud-list');
    liste.innerHTML = '';
    for (const item of res.items) {
      const li = document.createElement('li');
      if (!item.readable) {
        li.className = 'error';
        li.innerHTML = `<span class="name">${escapeHtml(item.name)}</span>
          <span class="meta">${escapeHtml(item.code)} — illisible : ${escapeHtml(item.error)}</span>`;
        liste.append(li);
        continue;
      }
      li.innerHTML = `
        <span class="name">${escapeHtml(item.name)} <code>${escapeHtml(item.code)}</code></span>
        <span class="meta">niveau ${item.level} · ${item.balls} balle(s) ·
          ${item.random ? 'aléatoire' : 'fixe'} · ${(item.created ?? '').slice(0, 10)}</span>
        <span class="mini-balls">${item.drill.balls.map((b) => `
          <i class="mini-ball" style="background:${
            { green: 'var(--green)', yellow: 'var(--yellow)', orange: 'var(--orange)', blue: 'var(--blue)', grey: 'var(--grey)' }[b.color] ?? 'var(--grey)'
          }" title="Balle ${b.index}">${b.index}</i>`).join('')}</span>`;

      li.addEventListener('click', async () => {
        if (!await peutQuitter({ action: `importer « ${item.name} »` })) return;
        try {
          const d = await api(`/api/cloud/${encodeURIComponent(item.code)}`);
await afficherExercice(d.drill, { originalId: null, isDraft: true });
          const notes = [];
          if (d.maxRpmError > 0) {
            notes.push(`Écart maximal de ${d.maxRpmError} tr/min sur les roues `
              + '(l’exercice d’origine ne tombe pas exactement sur la grille de vitesse/effet).');
          }
          notice(`Exercice « ${d.drill.name} » importé depuis le code ${d.code}. `
            + `${notes.join(' ')} Il n’est pas enregistré : clique « Enregistrer » pour l’ajouter à ta librairie.`);
        } catch (err) {
          notice(err.message, 'error');
        }
      });

      liste.append(li);
    }
    if (res.items.length === 0) liste.innerHTML = '<li class="empty">Aucun résultat.</li>';
  } catch (err) {
    $('#cloud-list').innerHTML = `<li class="error">${escapeHtml(err.message)}</li>`;
    $('#cloud-status').textContent = '';
  }
}

async function importerParCode() {
  const code = $('#cloud-code').value.trim().toUpperCase();
  if (!code) return;
  $('#cloud-code').value = code;
  if (!await peutQuitter({ action: `importer le code ${code}` })) return;
  try {
    const d = await api(`/api/cloud/${encodeURIComponent(code)}`);
await afficherExercice(d.drill, { originalId: null, isDraft: true });
    notice(`Exercice « ${d.drill.name} » importé depuis le code ${code}. Clique « Enregistrer » pour le garder.`);
  } catch (err) {
    notice(err.message, 'error');
  }
}

/* =================================================================== ROBOT = */

function majRobot(robot) {
  state.robot = robot ?? { connected: false };
  const connecte = Boolean(state.robot.connected);
  $('#robot-dot').className = `dot ${connecte ? 'dot-on' : 'dot-off'}`;
  $('#robot-label').textContent = connecte
    ? `Connecté${state.robot.firmware ? ` (${state.robot.firmware})` : ''}`
    : 'Robot déconnecté';
  $('#btn-connect').textContent = connecte ? 'Déconnecter' : 'Connecter';
  $('#btn-stop').disabled = !connecte;
}

async function basculerConnexion() {
  const bouton = $('#btn-connect');

  if (state.robot.connected) {
    bouton.disabled = true;
    messageRobot('Déconnexion…', 'busy');
    try {
      const res = await api('/api/robot/disconnect', { method: 'POST' });
      majRobot(res.robot);
      messageRobot('Robot déconnecté.');
    } catch (err) {
      messageRobot(err.message, 'error');
    } finally {
      bouton.disabled = false;
    }
    return;
  }

  // La connexion peut prendre une douzaine de secondes (scan Bluetooth) : on
  // occupe le bouton et on annonce l'étape, sinon l'utilisateur croit que rien
  // ne se passe.
  bouton.disabled = true;
  bouton.textContent = 'Connexion…';
  messageRobot('Connexion au robot…', 'busy');

  const minuteur = setInterval(async () => {
    try {
      const etat = await api('/api/state');
      const p = etat.progress;
      if (p?.enCours && p.etape) messageRobot(p.etape, 'busy');
    } catch { /* on n'interrompt pas la connexion pour ça */ }
  }, 900);

  try {
    const res = await api('/api/robot/connect', { method: 'POST', body: {} });
    majRobot(res.robot);
    messageRobot(
      `Connecté à ${res.address ?? '?'}`
      + (res.firmware ? ` — firmware ${res.firmware}` : '')
      + ` — état ${res.robot?.state ?? '?'}`,
      'ok',
    );
  } catch (err) {
    messageRobot(err.message, 'error');
    majRobot(state.robot);
  } finally {
    clearInterval(minuteur);
    bouton.disabled = false;
  }
}

/**
 * Suit la progression d'une séquence et l'affiche dans l'en-tête.
 *
 * Le serveur découpe l'exercice en segments et les envoie l'un après l'autre,
 * avec les pauses. Pendant ce temps l'interface ne disait plus rien : impossible
 * de savoir où en était la série, ni même si quelque chose était encore en
 * cours. On interroge donc l'état une fois par seconde, tant que ça tourne.
 */
let suiviSequence = null;

function suivreSequence() {
  clearInterval(suiviSequence);
  suiviSequence = setInterval(async () => {
    try {
      const etat = await api('/api/state');
      const p = etat?.progress;
      if (p?.enCours && p.etape) {
        messageRobot(p.etape, 'busy');
      } else {
        clearInterval(suiviSequence);
        suiviSequence = null;
        messageRobot('Séquence terminée.');
      }
    } catch {
      // Une lecture ratée n'interrompt pas la séquence.
    }
  }, 1000);
}

async function envoyerAuRobot() {
  if (!state.current) return;

  // On enregistre TOUJOURS avant d'envoyer, même si rien ne semble modifié.
  //
  // C'est la seule façon d'être sûr que la librairie et l'écran racontent la
  // même chose. Auparavant, un exercice modifié puis envoyé pouvait partir dans
  // sa version enregistrée — donc l'ancienne — et l'on croyait que le robot
  // jouait autre chose que ce qu'on venait de régler.
  const ok = await enregistrer({ silencieux: true });
  if (!ok) return;
  $('#btn-send').disabled = true;

  // Décompte optionnel : coché par défaut. Il laisse le temps de reposer la
  // souris et de reprendre sa raquette avant que les balles ne partent.
  if (state.envoi.countdown !== false) {
    const continuer = await compteARebours(5, `Envoi de « ${state.current.name} » au robot…`);
    if (!continuer) {
      notice('Envoi annulé.');
      $('#btn-send').disabled = false;
      return;
    }
  }

  notice('Envoi au robot…');
  try {
    const res = await api('/api/robot/send', {
      method: 'POST',
      body: {
        id: state.originalId,
        // On envoie AUSSI les balles elles-mêmes : le serveur préfère ce
        // qu'on lui donne à ce qu'il a sur le disque. Impossible dès lors
        // d'envoyer une version périmée de l'exercice.
        name: state.current.name,
        balls: state.current.balls,
        mode: state.envoi.mode,
        modeValue: state.envoi.modeValue,
        random: state.envoi.random,
      },
    });
    majRobot(res.robot);
    if (res.sequence) {
      const pauses = res.pauses.map((s) => formatPause(s)).join(', ');
      notice(`Exercice « ${res.name} » envoyé en ${res.segments} segments `
        + `(pauses : ${pauses}). Les balles sans pause s’enchaînent normalement ; `
        + '« Arrêter » interrompt la séquence.');
      // On suit la séquence en direct dans l'en-tête : c'est la seule façon de
      // voir ce que le logiciel fait PENDANT que le robot joue — quel segment
      // part, combien de séries ont été faites.
      suivreSequence();
    } else {
      notice(`Exercice « ${res.name} » envoyé (${res.bytes} octets). `
        + 'Le robot tourne jusqu’à ce que tu cliques « Arrêter ».');
    }
  } catch (err) {
    notice(err.message, 'error');
  } finally {
    $('#btn-send').disabled = false;
  }
}

/* ============================================================ ENREGISTRER == */

async function enregistrer({ silencieux = false, renomme = false } = {}) {
  if (!state.current) return false;

  // Le nom a-t-il changé depuis le chargement ? Si oui, on crée un nouvel
  // exercice : renommer puis enregistrer ne doit jamais effacer l'original.
  // `renomme` force au contraire un renommage SUR PLACE (bouton « Renommer »).
  const nomAChange = Boolean(state.originalId)
    && !renomme
    && (state.current.name ?? '').trim() !== (state.nomCharge ?? '').trim()
    && (state.current.name ?? '').trim() !== '';

  const corps = {
    name: state.current.name,
    description: state.current.description,
    notes: state.current.notes,
    tags: state.current.tags,
    difficulty: state.current.difficulty,
    balls: state.current.balls,
    // NI mode, NI modeValue, NI random : ce sont des réglages d'envoi, ils ne
    // font pas partie de l'exercice et ne sont donc pas enregistrés.
    // Le réglage PHYSIQUE, lui, en fait partie : il a été conçu avec cette
    // position de robot et cette rotation de tête. On l'enregistre donc.
    headAngle: state.headAngle,
    robotSquare: state.setup.square,
    robotAngle: state.setup.angle,
  };

  const ancienId = state.originalId;
  const ancienNom = state.nomCharge;

  try {
    const res = (state.originalId && !nomAChange)
      ? await api(`/api/drills/${encodeURIComponent(state.originalId)}`, { method: 'PUT', body: corps })
      : await api('/api/drills', { method: 'POST', body: corps });

    // Le serveur borne et arrondit (spin maximal selon la vitesse, pas de 0,5,
    // plage des roues…). On réaffiche donc CE QU'IL A RETENU, sinon l'interface
    // montre des valeurs que le robot ne recevra jamais — et l'on croit qu'il
    // joue autre chose que ce qu'on a réglé.
    state.current.balls = res.drill.balls.map((b) => ({ ...b }));

    state.originalId = res.drill.id;
    state.current.name = res.drill.name;
    state.nomCharge = res.drill.name;
    state.dirty = false;
    $('#btn-revert').hidden = true;
    $('#drill-name').value = res.drill.name;
    $('#drill-id').textContent = `(${res.drill.id})`;
    majBoutonEnregistrer();
    renderBallRows();
    renderTable(state.current);
    renderSideView(state.current);

    if (!silencieux) {
      const quoi = nomAChange
        ? `Nouvel exercice « ${res.drill.name} » créé ; l'ancien « ${ancienNom} » (${ancienId}) est conservé.`
        : `Exercice enregistré : « ${res.drill.name} » (${res.drill.id}).`;
      const ajuste = (res.adjustments ?? []).filter(Boolean);
      notice(quoi
        + (ajuste.length
          ? `\nAjustements appliqués par le serveur :\n${ajuste.map((a) => `  • ${a}`).join('\n')}`
          : ''));
    }
    await chargerLibrairie();
    return true;
  } catch (err) {
    notice(err.message, 'error');
    return false;
  }
}

/* ================================================================== ACTIONS */

/**
 * Vérifie que l'on peut quitter l'exercice affiché sans rien perdre.
 *
 * Renvoie `true` s'il faut continuer, `false` s'il faut rester.
 *
 * Sans ce garde-fou, SEPT chemins remplaçaient l'exercice courant sans rien
 * demander — cliquer sur un exercice de la librairie, en générer un par IA, en
 * importer un depuis un fichier, depuis la librairie en ligne, par code, en
 * créer un nouveau. Les modifications en cours disparaissaient alors sans
 * trace : le bouton « Enregistrer » n'était qu'un avertissement, pas une
 * protection.
 *
 * On propose d'enregistrer d'abord, et « Annuler » laisse l'utilisateur SUR
 * place : un refus ne doit jamais être le chemin qui perd le travail. Pour
 * abandonner volontairement, il y a « Annuler les changements ».
 */
async function peutQuitter({ action = 'en ouvrir un autre' } = {}) {
  if (!state.current || !state.dirty) return true;

  const enregistrerDabord = confirm(
    `« ${state.current.name} » a des modifications non enregistrées.\n\n`
    + `OK : les enregistrer avant d’${action}.\n`
    + 'Annuler : rester sur cet exercice — tes modifications sont conservées. '
    + 'Pour les abandonner, utilise « Annuler les changements ».',
  );
  if (!enregistrerDabord) {
    notice('Changement interrompu : tes modifications sont toujours là.');
    return false;
  }
  return Boolean(await enregistrer({ silencieux: true }));
}

async function nouvelExercice() {
  if (!await peutQuitter({ action: 'en créer un nouveau' })) return;
  await afficherExercice({
    name: 'Nouvel exercice',
    description: '',
    tags: [],
    difficulty: 1,
    mode: 'endless',
    modeValue: 0,
    random: false,
    balls: [{
      speed: 5, spin: 2, height: 50, dropPoint: 0, frequency: 60, reps: 1,
    }],
  }, { originalId: null, isDraft: true });
  state.dirty = true;
  majBoutonEnregistrer();
  $('#drill-name').focus();
  $('#drill-name').select();
  notice('Nouvel exercice : donne-lui un nom, modifie les balles, puis « Enregistrer dans ma librairie ».');
}

async function supprimer() {
  if (!state.originalId) return;
  if (!confirm(`Supprimer « ${state.current.name} » ? Cette action est définitive.`)) return;
  try {
    await api(`/api/drills/${encodeURIComponent(state.originalId)}`, { method: 'DELETE' });
    state.current = null;
    state.originalId = null;
    $('#drill-name').value = '';
    $('#drill-name').disabled = true;
    $('#drill-name').placeholder = 'Aucun exercice sélectionné';
    $('#drill-id').textContent = '';
    majBoutonEnregistrer();
    $('#ball-rows').innerHTML = '';
    $('#table-view').innerHTML = '';
    $('#btn-send').disabled = true;
    $('#btn-export').disabled = true;
    $('#btn-share').disabled = true;
    $('#btn-delete').disabled = true;
    notice('Exercice supprimé.');
    await chargerLibrairie();
  } catch (err) {
    notice(err.message, 'error');
  }
}

async function exporter() {
  if (!state.originalId) return;
  const format = prompt('Format d’export : csv (olanga), csv-legacy (olanga 1.3) ou smee', 'csv');
  if (!format) return;
  try {
    const res = await api(`/api/export/${encodeURIComponent(state.originalId)}?format=${encodeURIComponent(format)}`);
    const blob = new Blob([res.text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = res.filename;
    a.click();
    URL.revokeObjectURL(a.href);
    notice(`Exercice exporté en ${res.format}.`);
  } catch (err) {
    notice(err.message, 'error');
  }
}

async function publier() {
  if (!state.current) return;
  const ok = confirm(
    'Publier cet exercice sur la librairie en ligne publique ?\n\n'
    + 'Il deviendra visible par tout le monde et identifiable par un code de 6 caractères.\n'
    + 'Ne publie rien de personnel.',
  );
  if (!ok) return;
  try {
    if (state.dirty || !state.originalId) {
      const enregistre = await enregistrer({ silencieux: true });
      if (!enregistre) return;
    }
    const res = await api('/api/cloud', { method: 'POST', body: { id: state.originalId } });
    await navigator.clipboard?.writeText(res.code).catch(() => {});
    notice(`Publié ! Code de partage : ${res.code} (copié dans le presse-papiers).`);
  } catch (err) {
    notice(err.message, 'error');
  }
}

async function importerFichier(file) {
  if (!await peutQuitter({ action: `importer « ${file.name} »` })) return;
  const contenu = await file.text();
  try {
    const res = await api('/api/import', { method: 'POST', body: { content: contenu, format: 'auto' } });
await afficherExercice(res.drill, { originalId: null, isDraft: true });
    const notes = [`Fichier « ${file.name} » importé (format ${res.format}).`];
    if (res.maxRpmError > 0) notes.push(`Écart maximal de ${res.maxRpmError} tr/min sur les roues.`);
    if (res.variantes > 0) notes.push(`${res.variantes} variante(s) : ordre aléatoire activé.`);
    notes.push('Clique « Enregistrer » pour l’ajouter à ta librairie.');
    notice(notes.join(' '));
  } catch (err) {
    notice(err.message, 'error');
  }
}

/* ================================================================ DÉMARRAGE */

function remplirSelecteurTete(app) {
  const select = $('#head-angle');
  select.innerHTML = '';
  const presetAngles = new Set();
  for (const p of HEAD_PRESETS) {
    presetAngles.add(p.angle);
    const option = document.createElement('option');
    option.value = String(p.angle);
    option.textContent = `${p.label} (${p.angle}°)`;
    select.append(option);
  }
  if (!presetAngles.has(state.headAngle)) {
    const option = document.createElement('option');
    option.value = String(state.headAngle);
    option.textContent = `${state.headAngle}°`;
    select.append(option);
  }
  select.value = String(state.headAngle);
  $('#head-description').textContent = app.head.description;
  $('#ai-head-hint').textContent =
    `L’IA tiendra compte de la tête à ${state.headAngle}° `
    + `et du robot « ${app.setup.label} » (${state.setup.angle}°).`;
}

async function demarrer() {
  const app = await api('/api/state');
  state.app = app;
  state.headAngle = app.head.angle;

  state.setup = { square: app.setup.square, angle: app.setup.angle };
  remplirSelecteurTete(app);
  renderSetupGrid(app);
  majRobot(app.robot);
  $('#ai-model').textContent = app.deepseekConfigured
    ? `Modèle : ${app.model}`
    : 'Aucune clé DeepSeek configurée : la génération par IA est indisponible.';
  if (!app.deepseekConfigured) $('#btn-generate').disabled = true;
  document.querySelector('#ai-head-hint').textContent =
    `L’IA tiendra compte de la tête à ${state.headAngle}° : ${app.head.description}`;

  await chargerLibrairie();
  majBoutonEnregistrer();
  chargerCloud(1);

  /* --- réglage de la tête */
  $('#head-angle').addEventListener('change', async (ev) => {
    const angle = Number(ev.target.value);
    const res = await api('/api/settings', { method: 'PUT', body: { headAngle: angle } });
    state.headAngle = res.head.angle;
    $('#head-description').textContent = res.head.description;
    $('#ai-head-hint').textContent =
      `L’IA tiendra compte de la tête à ${state.headAngle}° `
      + `et du robot « ${state.app?.setup?.label ?? ''} » (${state.setup.angle}°).`;
    if (state.current) {
      renderBallRows();
      renderTable(state.current);
      renderSideView(state.current);
      marquerModifie();
    }
    notice(`Tête réglée à ${state.headAngle}°. C’est un réglage manuel du robot : `
      + 'pense à tourner réellement le pivot pour qu’il corresponde.');
  });

  /* --- placement du robot */
  $('#setup-angle').addEventListener('change', (ev) => {
    enregistrerPlacement({ robotAngle: normalizeRobotAngle(ev.target.value) });
  });
  $('#setup-reset').addEventListener('click', () => enregistrerPlacement({ robotAngle: 0 }));

  /* --- glisser-déposer */
  $('#drag-knob').addEventListener('change', (ev) => {
    state.dragKnob = ev.target.value;
    const quoi = state.dragKnob === 'height' ? 'la hauteur' : 'la vitesse';
    notice(`Un glissement vertical fera maintenant varier ${quoi}. `
      + 'L’effet n’est jamais modifié par un glissement : c’est un réglage à part.');
  });

  /* --- librairie */
  $('#library-search').addEventListener('input', chargerLibrairie);
  $('#btn-new').addEventListener('click', () => nouvelExercice());
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    if (file) importerFichier(file);
    ev.target.value = '';
  });

  /* --- exercice courant */
  // Le nom fait partie de l'exercice : le modifier marque l'exercice comme
  // modifié, et le bouton Enregistrer s'active.
  const champNom = $('#drill-name');
  champNom.addEventListener('input', (ev) => {
    if (!state.current) return;
    state.current.name = ev.target.value;
    if (!state.dirty) marquerModifie();
    else majBoutonEnregistrer();
  });
  // Entrée enregistre directement : c'est ce qu'on attend d'un champ de nom.
  champNom.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      champNom.blur();
      if (!$('#btn-save').disabled) enregistrer();
    }
  });

  // Réglages d'ENVOI : ils ne touchent pas à l'exercice, donc jamais
  // `marquerModifie()` — pas d'avertissement de modifications, pas de nouvel
  // exercice créé à cause d'un changement de mode.
  $('#drill-random').addEventListener('change', (ev) => {
    state.envoi.random = ev.target.value === 'true';
    majReglagesEnvoi();
  });
  $('#drill-mode').addEventListener('change', (ev) => {
    state.envoi.mode = ev.target.value;
    if (state.envoi.mode === 'endless') state.envoi.modeValue = 0;
    else if (!state.envoi.modeValue) state.envoi.modeValue = 1;
    majReglagesEnvoi();
  });
  $('#drill-mode-value').addEventListener('input', (ev) => {
    state.envoi.modeValue = Math.max(1, Number(ev.target.value) || 1);
    majReglagesEnvoi();
  });
  $('#chk-countdown').addEventListener('change', (ev) => {
    state.envoi.countdown = ev.target.checked;
  });
  $('#btn-add-ball').addEventListener('click', () => {
    if (!state.current) return;
    if (state.current.balls.length >= MAX_BALLES) {
      notice(`Impossible : ${MAX_BALLES} balles au maximum par exercice.`, 'error');
      return;
    }
    const derniere = state.current.balls.at(-1);
    state.current.balls.push(derniere
      ? { ...derniere, dropPoint: -derniere.dropPoint }
      : { speed: 5, spin: 2, height: 50, dropPoint: 0, frequency: 60, reps: 1 });
    state.selectedBall = state.current.balls.length - 1;
    marquerModifie();
    renderBallRows();
    renderTable(state.current);
    renderSideView(state.current);
  });
  $('#btn-paste-ball').addEventListener('click', collerBalle);
  $('#btn-save').addEventListener('click', () => enregistrer());
  // Renommer SUR PLACE : on demande d'abord le nouveau nom, puis on enregistre
  // en mode « renommage » pour ne PAS créer un second exercice.
  $('#btn-rename').addEventListener('click', async () => {
    if (!state.current) return;
    const proposé = state.current.name ?? '';
    const nouveau = prompt(
      'Nouveau nom de CET exercice (il sera renommé, pas dupliqué) :',
      proposé,
    );
    if (nouveau === null || !nouveau.trim()) return;
    state.current.name = nouveau.trim();
    $('#drill-name').value = state.current.name;
    const ok = await enregistrer({ renomme: true });
    if (ok) notice(`Exercice renommé en « ${state.current.name} » (même identifiant).`);
  });
  $('#btn-revert').addEventListener('click', async () => {
    if (state.dirty && !confirm(
      `Abandonner les modifications de « ${state.current?.name ?? ''} » ?\n\n`
      + 'Elles seront remplacées par la dernière version enregistrée.',
    )) return;
    if (state.originalId) {
      const { drill } = await api(`/api/drills/${encodeURIComponent(state.originalId)}`);
      afficherExercice(drill, { originalId: state.originalId });
    } else {
      nouvelExercice();
    }
  });
  $('#btn-send').addEventListener('click', envoyerAuRobot);
  $('#btn-delete').addEventListener('click', supprimer);
  $('#btn-export').addEventListener('click', exporter);
  $('#btn-share').addEventListener('click', publier);

  /* --- robot */
  $('#btn-connect').addEventListener('click', basculerConnexion);
  $('#btn-stop').addEventListener('click', async () => {
    // On coupe le suivi : sans cela, l'en-tête continuerait d'annoncer une étape
    // alors que plus rien ne tourne.
    clearInterval(suiviSequence);
    suiviSequence = null;
    try {
      const res = await api('/api/robot/stop', { method: 'POST' });
      majRobot(res.robot);
      notice(`Arrêt : ${res.status} — ${res.detail}.`);
    } catch (err) {
      notice(err.message, 'error');
    }
  });

  /* --- IA */
  $('#btn-generate').addEventListener('click', generer);

  /* --- nuage */
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('is-active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('is-active'));
      tab.classList.add('is-active');
      $(`#tab-${tab.dataset.tab}`).classList.add('is-active');
    });
  });
  $('#btn-cloud-search').addEventListener('click', () => chargerCloud(1));
  $('#cloud-search').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') chargerCloud(1); });
  $('#btn-cloud-code').addEventListener('click', importerParCode);
  $('#cloud-code').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') importerParCode(); });
  $('#btn-cloud-prev').addEventListener('click', () => chargerCloud(Math.max(1, state.cloudPage - 1)));
  $('#btn-cloud-next').addEventListener('click', () => {
    const max = Math.max(1, Math.ceil(state.cloudTotal / 20));
    chargerCloud(Math.min(max, state.cloudPage + 1));
  });
}

demarrer().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="notice is-error" style="margin:14px">Démarrage impossible : ${escapeHtml(err.message)}</div>`);
});
