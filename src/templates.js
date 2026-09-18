/**
 * Gabarits d'exercices utilisables sans clé API.
 *
 * `nova create "<demande>" --template <nom>` part d'un de ces exercices. Ils
 * servent aussi de repère : ce sont des exercices réalistes, avec des
 * paramètres choisis pour être pédagogiquement sensés.
 */

const b = (speed, spin, height, dropPoint, frequency, reps = 1) => ({
  speed, spin, height, dropPoint, frequency, reps,
});

export const TEMPLATES = {
  'retour-service-rapide': {
    name: 'Retour de services rapides (droite / centre / gauche)',
    summary:
      'Trois services rapides de même longueur, répartis à droite, au centre et à gauche, ' +
      'servis dans un ordre aléatoire pour t’obliger à lire la trajectoire au dernier moment.',
    tags: ['service', 'rapidité', 'placement', 'aléatoire'],
    mode: 'endless',
    random: true,
    balls: [
      b(9, 2, 50, -6, 70),   // à droite (côté revers d'un droitier)
      b(9, 2, 50, 0, 70),    // au centre
      b(9, 2, 50, 6, 70),    // à gauche (côté coup droit)
    ],
    notes:
      'Le Nova S Pro n’a que deux roues : il produit du top-spin ou du back-spin, jamais un vrai ' +
      'effet latéral. L’effet latéral ressenti vient ici de la variation de placement (droite / ' +
      'centre / gauche) à longueur constante. Les trois balles partagent vitesse, effet, hauteur ' +
      'et fréquence : seule la chute change, donc la longueur est identique.',
  },

  'echauffement-topspin': {
    name: 'Échauffement top-spin',
    summary: 'Top-spin modéré au milieu de la table, à cadence confortable, pour se mettre en jambes.',
    tags: ['échauffement', 'topspin'],
    mode: 'minutes',
    modeValue: 5,
    random: false,
    balls: [
      b(5, 4, 50, 0, 45, 1),
    ],
    notes: 'Une seule balle répétée pendant 5 minutes : idéal pour trouver le bon timing.',
  },

  'revers-coup-droit-alterne': {
    name: 'Alternance revers / coup droit',
    summary: 'Une balle sur deux dans le revers, une sur deux dans le coup droit, pour travailler le déplacement latéral.',
    tags: ['déplacement', 'jeu de jambes'],
    mode: 'endless',
    random: false,
    balls: [
      b(5, 2, 50, -8, 50),
      b(5, 2, 50, 8, 50),
    ],
    notes: 'Ordre fixe : le déplacement devient un réflexe avant d’être soumis au hasard. ' +
      'Passe `random: true` pour rendre la lecture plus difficile.',
  },

  'poussette-backspin': {
    name: 'Poussettes en back-spin',
    summary: 'Ballées lentes et coupées pour travailler la poussette et le contrôle.',
    tags: ['backspin', 'contrôle', 'petit jeu'],
    mode: 'minutes',
    modeValue: 5,
    random: false,
    balls: [
      b(2, -5, 30, -4, 40),
      b(2, -5, 30, 4, 40),
    ],
    notes: 'Vitesse basse et back-spin marqué : la balle flotte et retombe court.',
  },

  'placement-aleatoire-3-zones': {
    name: 'Placement aléatoire sur 3 zones',
    summary: 'Toujours la même balle, mais envoyée au hasard dans trois zones de la table.',
    tags: ['placement', 'aléatoire', 'déplacement'],
    mode: 'endless',
    random: true,
    balls: [
      b(6, 3, 50, -8, 60),
      b(6, 3, 50, 0, 60),
      b(6, 3, 50, 8, 60),
    ],
    notes: 'Seul le point de chute change : la longueur et le rythme restent constants, ' +
      'donc c’est bien le placement que tu travailles.',
  },

  'topspin-progressif': {
    name: 'Top-spin progressif',
    summary: 'Trois paliers de vitesse croissante, en trois séries, pour monter en puissance.',
    tags: ['topspin', 'intensité'],
    mode: 'combos',
    modeValue: 3,
    random: false,
    balls: [
      b(4, 3, 50, 0, 45),
      b(6, 5, 50, 0, 50),
      b(8, 4, 50, 0, 55),
    ],
    notes: 'Trois séries : la même séquence rejouée, de plus en plus vite. ' +
      'Si la dernière vitesse est trop forte, baisse la vitesse du troisième palier de 0.5.',
  },

  'bloc-contre-topspin': {
    name: 'Bloc contre top-spin',
    summary: 'Top-spin rapide et tendu pour travailler le bloc et le contre.',
    tags: ['bloc', 'topspin', 'rapidité'],
    mode: 'endless',
    random: true,
    balls: [
      b(8, 6, 60, -7, 75),
      b(8, 6, 60, 7, 75),
    ],
    notes: 'Vitesse et effet élevés, balle haute : la balle arrive vite et rebondit haut, ' +
      'ce qui laisse le temps de placer la raquette.',
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/** Récupère un gabarit, avec un message d'erreur utile s'il n'existe pas. */
export function getTemplate(name) {
  const key = String(name ?? '').trim().toLowerCase();
  const found = TEMPLATES[key];
  if (!found) {
    throw new Error(
      `Gabarit inconnu : « ${name} ». Disponibles : ${TEMPLATE_NAMES.join(', ')}.`,
    );
  }
  return { key, ...found };
}
