# NovaKontrol

Créer un exercice de tennis de table en le **demandant à DeepSeek en français**,
l'enregistrer, puis l'**envoyer au robot Pongbot Nova S Pro** en Bluetooth.

```bash
./nova web          # puis ouvre http://127.0.0.1:4173
```

ou en ligne de commande :

```bash
./nova create "je veux apprendre à retourner les services très rapides avec effets
latéraux qui m'arrivent presque au milieu de la table. Un service à droite, un au
centre et un à gauche, aléatoirement, mais tous de la même longueur."

./nova list
./nova send retour-service-rapide
```

---

## Deux mises au point importantes

### 1. Ce n'est pas de l'infrarouge, c'est du Bluetooth

La télécommande du Nova S Pro est bien infrarouge, mais elle ne sert qu'aux
commandes de base. Les **exercices personnalisés passent en Bluetooth Low
Energy** : service `02f00000-0000-0000-0000-00000000fe00`, écriture sur
`…ff01`, notifications sur `…ff02`, précédés d'une poignée de main MD5 que le
robot exige. C'est le canal qu'utilisent les trois projets de référence et c'est
donc celui qu'implémente NovaKontrol.

Conséquence pratique : **le robot n'accepte qu'un seul maître à la fois.** Si
l'application officielle est ouverte sur ton téléphone, NovaKontrol ne pourra pas
s'y connecter. Ferme-la.

### 2. L'effet latéral : deux mécanismes, pas un

Le Nova S Pro a **deux roues** (supérieure et inférieure) : c'est ce que le
logiciel pilote, et cela produit du **top-spin** ou du **back-spin**.

L'effet latéral vient de **deux** sources :

1. **le placement** (`dropPoint`) : la même balle envoyée à droite, au centre ou
   à gauche — un effet latéral *perçu*, sans rotation ;
2. **la tête pivotante**, réglée **à la main** : elle réoriente l'axe de rotation
   et produit un **vrai** effet latéral.

NovaKontrol gère les deux, et l'interface te dit lequel s'applique.

#### Ce que le manuel anglais a apporté

La version anglaise du manuel (88 pages) est bien plus détaillée que
l'allemande, et trois de ses sections ont corrigé des erreurs ou des manques :

**§3.5.7 — c'est la VITESSE qui règle la profondeur.**
> « For the landing point of the serve, the larger the speed parameter, the
> closer the landing point is to the bottom edge of the table. »

Ce que fait le modèle de profondeur. Le tableau ci-dessous le chiffre.

**§3.5.4 — une hauteur négative donne DEUX rebonds.**
> « If you need to set 2 jump ball (the first landing point is on the robot half
> of the table, and the second landing point is on the player half), you can set
> the ball height parameter to a negative value. »

C'est ce qui manquait à la compréhension : une hauteur négative ne fait pas
plonger la balle dans le filet, elle la fait **rebondir d'abord sur la moitié du
robot**. Les deux vues de l'interface montrent ce premier rebond.

**§3.5.5 — l'application officielle affiche la même chose, et le dit.**
> « The animation effect on the page shows the landing point and trajectory of
> the single ball […] This animation effect is **for reference only**. »

NovaKontrol fait exactement cela, et le dit aussi.

### Placement du robot — le « nine-square grid »

Le manuel §3.5.1 décrit une page de choix de position :

> « on the machine position selection page, you need to select the corresponding
> position in the **nine-square grid** according to the actual position and angle
> of the robot […] The reset button returns the machine angle to the default 0º. »

C'est donc, comme la tête, un réglage **manuel** que le logiciel ne peut pas lire
— et il compte, parce que l'angle de placement détermine la zone couverte.

La grille se choisit **directement sur la vue du dessus** : un clic sur l'une des
neuf cases pose le robot à cet endroit. Un angle (0° par défaut) la complète.

**Le placement change le tir.** Reculer le robot allonge la distance à parcourir,
donc **raccourcit** la balle ; l'avancer l'**allonge**. Le décaler sur le côté
déplace toute la zone couverte. Concrètement, pour une balle réglée à
vitesse 5 / hauteur 50 / sans effet :

| Case | Point de sortie | Profondeur | Vol |
|---|---|---|---|
| Fond de table · Centre *(défaut)* | 0,15 m | 36 % | 400 ms |
| Milieu · Centre | 0,65 m | 49 % | 360 ms |
| Près du filet · Centre | 1,15 m | 63 % | 320 ms |
| Fond de table · Gauche | 0,15 m | 36 %, **décalée de 12 % à gauche** | 400 ms |
| Près du filet · Droite | 1,15 m | 63 %, **décalée de 12 % à droite** | 320 ms |

Plus le robot est **près du filet**, plus la balle est **longue** (elle a moins de
distance à parcourir pour atteindre le filet). Le décalage latéral déplace toute
la zone couverte. La position « Près du filet » est celle que le manuel appelle
« near-net ».

| | Gauche | Centre | Droite |
|---|---|---|---|
| **Fond de table** | | **défaut** | |
| **Milieu** | | polyvalent | |
| **Près du filet** | | **position « near-net »** | |

Les neuf cases **pavent la moitié du robot** : du fond de table jusqu'au filet, trois
colonnes sur toute la largeur, trois bandes sur la profondeur. Elles sont dessinées
sur la table elle-même, pas à côté.

> Le manuel **n'énumère pas** les neuf cases, et ne donne **aucune conversion**
> entre la case et le point de chute. La grille et les décalages ci-dessus sont
> donc un modèle : ils respectent ce que le manuel affirme qualitativement (reculer
> raccourcit, décaler déplace la zone), mais ce ne sont pas des valeurs
> constructeur.

### Le réglage voyage avec l'exercice

Position du robot et rotation de tête sont **enregistrées avec chaque exercice** :
un exercice a été conçu avec un certain réglage, il le garde. Changer le réglage
courant ne modifie donc pas les exercices déjà enregistrés, et ouvrir un exercice
rapplique son réglage à l'interface.

Les deux vues sont recalculées avec ce réglage : profondeur, point de chute,
arcs et temps de parcours en découlent.

### La tête pivotante

Le manuel officiel du NOVA S PRO (Benutzerhandbuch V1.0, §2.2) dit :

> « Mit Ausnahme des **seitlichen Drehgelenks** werden andere Gelenke dieses
> Produkts automatisch eingestellt. »
> *À l'exception du pivot latéral, les autres articulations de ce produit sont
> réglées automatiquement.*

| Réglage | Fonction | Angle |
|---|---|---|
| Links-/Rechtsschwung (placement) | **automatique, continu** | 44° (−22°~22°), mécanique ±25° |
| Bogen auf/ab (hauteur) | non automatique | 50° (−20°~30°) |
| **Einstellung des Seitenspins** | **manuell** | **180° ± 90°** |

Le robot **sait donc produire un effet latéral** — mais ce réglage se fait **à la
main**, en tournant le pivot latéral, seule articulation manuelle de la machine.
Le manuel liste neuf positions : *Top-Spin · linker Top-Spin · linker Spin · links
unter Spin · unter Spin · Rechts unter Spin · Rechts Spin · Rechts Top Spin ·
Kein Spin*.

**Aucune commande Bluetooth ne lit ni n'écrit cet angle** : la capture BLE ne
contient que huit opcodes, aucun ne s'y rapporte. Le logiciel ne peut donc que
**te demander où tu as placé la tête**, puis en tenir compte.

Ce que NovaKontrol en fait :

- un sélecteur **Tête (pivot latéral)** dans l'en-tête de l'interface, sept positions ;
- la **couleur et le libellé d'effet** de chaque balle sont recalculés : le même
  `spin` positif est « top-spin » à 0° et « effet latéral » à ±90° ;
- **le paquet envoyé au robot ne change pas** — la rotation est physique, pas
  protocolaire, et un test le vérifie explicitement ;
- **le prompt de DeepSeek reçoit l'angle**, avec la consigne de ne pas
  double-compter l'effet latéral (inutile d'ajouter une variation de placement
  « pour faire latéral » si la tête est déjà tournée) et de rappeler de tourner le
  pivot quand c'est nécessaire.

Le modèle est géométrique — top/back = `spin·cos(θ)`, latéral = `spin·sin(θ)` —
parce que le manuel ne donne pas l'angle exact de ses neuf positions. C'est une
description, jamais une mesure.

---

## Prérequis

| Élément | Détail |
|---|---|
| Node.js | 20 ou plus (testé sur 22) |
| Système | **Linux** — le transport BLE s'appuie sur BlueZ via D-Bus |
| Bluetooth | un adaptateur actif et allumé |
| Robot | un Pongbot Nova S Pro allumé, à moins de 10 m |
| Clé API | une clé DeepSeek pour la création libre (facultatif : des gabarits sont fournis) |

> **macOS / Windows ?** `node-ble` ne fonctionne que sur Linux. Toute la couche
> Bluetooth est isolée derrière l'interface `Link` de `src/ble.js` : la logique
> d'authentification, d'encodage et de commande est indépendante du transport.
> Il suffit d'écrire une autre implémentation de `Link` (par exemple avec
> `@abandonware/noble`, multiplateforme) pour porter le projet. Les tests du
> protocole et de la poignée de main, eux, tournent partout.

---

## Installation

```bash
cd novaKontrol
npm install
cp .env.example .env      # puis renseigne DEEPSEEK_API_KEY
./nova doctor --scan      # vérifie que tout est en place
```

### Comment lancer les commandes

Trois formes équivalentes — utilise celle qui te convient :

```bash
./nova list          # depuis le dossier du projet (le plus simple)
node nova list       # même chose, en passant explicitement par Node
npm link             # puis, depuis n'importe où :
nova list
```

Le reste de cette documentation écrit `./nova`. Le lanceur est du JavaScript : il
fonctionne aussi bien avec `./nova` qu'avec `node nova`, y compris depuis un autre
répertoire.

Si `node-ble` ne parvient pas à joindre BlueZ, autorise ton utilisateur sur le
bus D-Bus système :

```bash
echo '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
  "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <policy user="'"$(id -un)"'">
    <allow own="org.bluez"/>
    <allow send_destination="org.bluez"/>
    <allow send_interface="org.bluez.GattCharacteristic1"/>
    <allow send_interface="org.bluez.GattDescriptor1"/>
    <allow send_interface="org.freedesktop.DBus.ObjectManager"/>
    <allow send_interface="org.freedesktop.DBus.Properties"/>
  </policy>
</busconfig>' | sudo tee /etc/dbus-1/system.d/node-ble.conf > /dev/null
sudo systemctl restart dbus
```

Sur Ubuntu 24.04 la politique par défaut autorise déjà l'accès à `org.bluez` :
en général cette étape n'est pas nécessaire.

---

## Interface web

```bash
./nova web                    # http://127.0.0.1:4173
./nova web --port 4174
```

Elle sert à ce qui est pénible en ligne de commande :

- **parcourir** la bibliothèque, chaque exercice montrant ses balles en pastilles colorées ;
- **voir le placement sur un schéma du plateau vu du dessus**, balles numérotées et
  colorées selon l'effet réel ;
- **modifier un exercice existant** balle par balle, valeurs recalculées en direct ;
- **créer par IA**, **importer/exporter**, **publier et récupérer** des exercices en ligne ;
- **envoyer au robot**, mettre en pause, arrêter.

Le serveur n'écoute que sur `127.0.0.1` : la page n'est pas exposée au réseau. Il
garde aussi la connexion Bluetooth ouverte entre les requêtes, ce qu'un processus
lancé à la demande ne peut pas faire.

### Les deux vues

**Vue de côté** (en haut) : profil du plateau, filet à sa vraie hauteur (15,3 cm),
robot, et la trajectoire des balles. La balle sélectionnée est tracée en gras avec
son sommet, son point de chute et sa **hauteur au-dessus du filet** — l'information
la plus utile pour juger un exercice. Les autres restent en filigrane pour garder
le contexte. Travailler dans une ligne de l'éditeur met sa trajectoire en avant.

**Vue du dessus** (en dessous) : placement sur la table. Chaque balle porte son
numéro et la couleur de son **effet réel** :

| Couleur | Effet |
|---|---|
| vert | top-spin |
| jaune | back-spin |
| orange | mixte (tête tournée : top/back **et** latéral) |
| bleu | latéral pur (tête à ±90°) |

Une flèche indique le sens de l'effet latéral.

### Déplacer les balles à la souris

Les balles de la vue du dessus se **glissent** directement sur la table, et les
paramètres suivent :

| Geste | Ce qui change |
|---|---|
| **horizontal** | le **placement** (`dropPoint`) — toujours exact |
| **vertical** | la **profondeur**, via la **vitesse** (ou la **hauteur**, au choix) |
| *jamais* | l'**effet** — c'est un réglage distinct, qui influe lui aussi sur la profondeur |

Un sélecteur sous la vue du dessus choisit ce que fait le glissement vertical.
Pendant le geste, une ligne indique en direct le placement, la valeur modifiée et
la profondeur atteinte. Au relâchement, la balle se recale sur les valeurs
arrondies : tu vois exactement ce qui sera envoyé au robot.

Si la cible est hors de portée — avec un fort top-spin, la vitesse maximale ne
suffit pas à atteindre le fond — la balle va **au plus loin possible** et
l'interface le dit, plutôt que de mentir sur la position.

Au clavier : `Tab` pour atteindre une balle, `Entrée` pour la sélectionner, les
**flèches** pour la déplacer (avec `Maj` pour un pas plus grand).

> **Ce que les vues savent, et ce qu'elles estiment.** L'axe **gauche-droite** est
> réel : il vient du paramètre de placement du robot (`dropPoint`). La
> **profondeur** est une **estimation** — le protocole ne transporte aucune
> profondeur et le robot ne publie pas sa balistique.

### Ce que les mesures du forum ont corrigé

Une feuille publiée sur le forum TableTennisDaily (« *Sextuples for Slow Balls
and Cerves* ») contient **84 valeurs de roues relevées sur le robot** : 21 hauteurs
× 2 effets × min/max, avec les notes de qualité de l'auteur. Quatre corrections en
sont sorties.

**1. La plage des roues est 500–7200 tr/min, pas 400–7500.** Les 84 valeurs y
tiennent toutes, et se collent à ces deux bornes — signature d'une limite sondée
expérimentalement. NovaKontrol s'y est resserré. Conséquence assumée : à vitesse
10 sans effet la formule donne 7275, ramené à 7200.

**2. La profondeur vient du NOMBRE DE REBONDS.** C'est la seule grandeur liée à
la longueur qui ait été **mesurée**. Une balle qui ne rebondit qu'une fois sur la
moitié du joueur atteint le fond ; dès qu'elle rebondit deux fois, c'est qu'elle
n'a pas eu l'énergie d'y arriver. La feuille le dit explicitement — « 1bounce,
near table edge » à hauteur 20 contre « 2bounce, short push » à hauteur 25.

Il y a donc une **falaise entre un et deux rebonds**, pas une progression
régulière :

| Description de la feuille | Rebonds | Profondeur affichée |
|---|---|---|
| « 1bounce, near table edge » | 1 | **82 %** (2,49 m) |
| « #longpush » | 1,5 | **81 %** (2,48 m) |
| « 2bounce, short push » | 2 | **41 %** (1,93 m) |
| « 3.8bounce, flickable » | 3,8 | **32 %** (1,81 m) |
| « 8bounce, high short empty push » | 8 | **13 %** (1,55 m) |

**3. Une balle haute est COURTE, pas longue.** Les mesures comptent les rebonds :
1 à hauteur 10, 2 à 25, 3,8 à 50, 5 à 60, 7 à 80, **8 à 95**. Une balle qui
rebondit huit fois est une balle courte. Le modèle faisait l'inverse — il est
corrigé, et le nombre de rebonds suit désormais une loi de puissance ajustée sur
ces mesures (écart moyen 0,32 rebond, maximum 1).

| Hauteur | Rebonds mesurés | Modèle |
|---|---|---|
| 10 | 1 | 1 |
| 25 | 2 | 1,5 |
| 50 | 3,8 | 3,5 |
| 60 | 5 | 4,5 |
| 80 | 7 | 6 |
| 95 | 8 | 7,5 |

Une balle rapide rebondit moins qu'une balle lente de même hauteur : l'atténuation
`1/(1 + vitesse/14)` reproduit cet effet.

**4. Le top-spin est impossible à très basse hauteur.** La table top-spin des
mesures est vide à hauteur 0 et ne devient consistante que vers 30 : il n'existe
pas de top-spin lent et bas.

> Ces mesures portent sur des balles **lentes** (roues proches du minimum). Les
> extrapoler aux balles rapides est un choix de modèle, signalé comme tel.

### Le modèle de profondeur, et pourquoi il est calibré

L'effet change la longueur : un top-spin plonge et raccourcit, un back-spin flotte
et allonge. `src/ballistics.js` traduit donc `speed`, `height` **et** `spin` en une
position de chute :

| Réglage | Effet sur la profondeur |
|---|---|
| vitesse 0 → 10 | 27 % → 98 % (plus vite, plus loin) |
| effet −10 → +10 | 98 % → 27 % (le top-spin raccourcit, le back-spin allonge) |
| hauteur < 0 | **2 rebonds** : le premier sur la moitié du robot (§3.5.4) |

Deux grandeurs viennent du manuel, pas de nous : la vitesse de sortie (2 à 15 m/s)
et l'angle mécanique de la tête (−17° à 33°, donné pour `height` −50 à 100).

**La profondeur est une calibration, pas une mesure.** Ce n'est pas un choix de
confort : une simulation physique directe est *impossible à calibrer ici*. Le
protocole expose vitesse, hauteur et effet comme des paramètres **indépendants**,
alors qu'un vrai robot les couple pour poser la balle sur la table. En intégrant
gravité, traînée et effet Magnus sur toute la plage, à peine 40 % des combinaisons
retombent sur la table, et la moitié part au-delà du fond — un tir à −17° depuis
40 cm ne peut tout simplement pas atteindre le fond de la table.

On procède donc en deux temps :

1. la **profondeur** vient de la calibration ci-dessus, avec les bonnes tendances ;
2. la **trajectoire** est l'arc qui aboutit *exactement* à cette profondeur, sa
   flèche dépendant de la hauteur (réglage « Bogen auf/ab ») et de l'effet.

Les deux vues lisent ainsi la même source : elles ne peuvent pas se contredire, et
un test vérifie que la trajectoire retombe au millimètre là où la profondeur
l'annonce. La hauteur au-dessus du filet et le temps de parcours sont **dérivés de
l'arc**, et présentés comme indicatifs.

## Librairie en ligne

NovaKontrol lit et publie sur la librairie partagée du client d'olanga
(`nova.varandal.de`, une instance PocketBase publique). Environ 200 exercices y
sont disponibles, identifiés par un code de six caractères.

```bash
# dans l'interface : onglet « Librairie en ligne »
# ou en ligne de commande
./nova send <id>                 # après import
```

| Action | Où |
|---|---|
| parcourir, chercher | onglet **Librairie en ligne** de l'interface |
| importer par code | champ **Code à importer** |
| publier | bouton **Publier en ligne** de l'exercice courant |

> ⚠ **Publier rend l'exercice public.** L'interface demande confirmation avant
> l'envoi. Ce serveur n'est pas le nôtre et peut disparaître : il sert à
> *échanger* des exercices, pas de stockage principal — ta bibliothèque locale
> reste la référence.

## Utilisation

### Créer un exercice

```bash
# En le décrivant à DeepSeek
./nova create "top-spin rapide alterné revers / coup droit, 3 séries, beaucoup d'effet"

# En partant d'un gabarit, sans consommer de jetons
./nova create --template retour-service-rapide

# Voir ce qui serait créé, sans rien enregistrer
./nova create "bloc contre top-spin" --dry-run

./nova templates            # liste les gabarits
```

DeepSeek reçoit un brief complet (bornes matérielles, formules de RPM, tableau
« vitesse → spin maximal », convention de signe du placement) et renvoie un
exercice structuré.

#### Quel modèle ?

L'API DeepSeek n'expose que deux modèles :

| Modèle | Usage | Ordre de grandeur |
|---|---|---|
| `deepseek-flash` | **défaut**, suffisant pour traduire une intention | ~20 s, ~5000 jetons |
| `deepseek-v4-pro` | demandes retorses, arbitrages pédagogiques fins | plus lent, plus cher |

```bash
./nova create "..." --model deepseek-v4-pro
```

Les deux sont des modèles de **raisonnement** : ils réfléchissent avant de
répondre, ce qui explique le temps de réponse et le nombre de jetons (souvent
plusieurs milliers, dont la majorité en raisonnement — NovaKontrol l'affiche).

Les anciens noms `deepseek-chat` et `deepseek-reasoner` ne sont plus documentés.
`deepseek-chat` reste accepté par l'API comme alias de `deepseek-flash`, mais
mieux vaut écrire le vrai nom. Pour connaître la liste à jour :

```bash
curl https://api.deepseek.com/models -H "Authorization: Bearer $DEEPSEEK_API_KEY"
```

NovaKontrol ne code pas en dur les capacités des modèles — elles ont déjà changé
une fois. Si l'API refuse `temperature` ou `response_format` pour un modèle, la
requête est automatiquement rejouée sans le paramètre fautif, et l'ajustement
est signalé. NovaKontrol le **valide ensuite** : si le modèle propose un
paramètre hors bornes ou incohérent, il est soit ramené automatiquement dans la
plage (et signalé), soit renvoyé au modèle pour correction, jusqu'à trois
tentatives.

### Consulter la bibliothèque

```bash
./nova list                       # tableau récapitulatif
./nova list --tag service         # filtré par étiquette
./nova show retour-service-rapide # détail
./nova show retour-service-rapide --hex   # + le paquet binaire exact
./nova export retour-service-rapide -o drill.csv
./nova delete retour-service-rapide
```

### Envoyer au robot

```bash
./nova scan                       # trouve le robot et affiche son adresse
./nova send retour-service-rapide # envoie et reste connecté pendant l'exercice
```

`./nova send` **affiche toujours l'exercice et demande confirmation** avant de
faire bouger le robot. `--yes` passe directement (et il n'y a pas de question
quand l'entrée n'est pas un terminal, donc les scripts ne sont pas bloqués).

Ensuite, `./nova send` **garde la connexion ouverte** tant que l'exercice tourne :
le robot s'arrête si la liaison Bluetooth tombe. C'est pour ça que la commande
reste au premier plan — `Ctrl-C` arrête l'exercice et libère le robot en quelques
secondes. Il ouvre en même temps un socket de contrôle local, ce qui permet de
piloter l'exercice depuis un autre terminal :

```bash
./nova stop        # dans un second terminal
./nova pause
./nova resume
./nova status
```

Sans socket actif, ces commandes tentent une connexion directe.

Autres options d'envoi :

```bash
./nova send <id> --dry-run          # affiche le paquet sans rien envoyer ni connecter
./nova send <id> --yes              # envoie sans demander confirmation
./nova send <id> --address AA:BB:.. # force l'adresse
./nova send <id> --modify           # modifie l'exercice en cours (paquet 0x84)
./nova send <id> --no-wait          # envoie et se déconnecte aussitôt
```

> `--no-wait` déconnecte immédiatement, ce qui a de bonnes chances d'arrêter
> l'exercice. À réserver aux tests.

### Le robot ne peut pas stocker d'exercice

Point important si tu cherches à ranger un exercice « dans » le robot : **c'est
impossible.** L'analyse de la capture Bluetooth (`btsnoop_hci.log`, 80 écritures
vers le descripteur d'écriture du robot) ne montre que 8 opcodes :

| Opcode | Rôle |
|---|---|
| `0x07` `0x08` `0x01` `0x02` | authentification |
| `0x80` | réveil, stop, pause, reprise |
| `0x81` | nouvel exercice — **il démarre immédiatement** |
| `0x83` | keepalive |
| `0x84` | modifier l'exercice en cours |

Aucune commande n'écrit en mémoire. Le `0x81` est indissociablement « voici un
exercice » et « joue-le ». Les exercices des groupes A / B / C du client
d'olanga sont stockés dans le navigateur, pas dans la machine.

**C'est donc NovaKontrol qui est ta librairie** : `./nova list` pour parcourir,
`./nova show <id>` pour examiner, `./nova send <id>` pour jouer. Tu peux aussi
exporter en CSV pour rouvrir un exercice dans le client web d'olanga.

### Import / export de fichiers

NovaKontrol lit et écrit **deux formats**, ceux des deux clients de référence.

**CSV d'[olanga/nova](https://github.com/olanga/nova)** — c'est le format de son
interface web :

```
Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps
A;1;Mon exercice;9;2;top;50;-6;70;1
```

**CSV de l'ancien client d'[olanga/nova](https://github.com/olanga/nova) 1.3**
(dossier `1.3/`) — il donne les RPM des roues au lieu de vitesse/effet :

```
Set;Ball;Name;Top;Bottom;Height;Drop;Freq;Reps
A;1;push 1;1000;1000;-40;6;0;1
```

**Texte de [smee/nova-s-custom-drills](https://github.com/smee/nova-s-custom-drills)**
— c'est le contenu de son `<textarea>`, celui de son fichier `novadrill.txt` :

```
500   4000  -50   6   0  1
1000, 4000,  20, 10, 30, 1 | 5000,  700,  40, -10, 20, 1 ; soit cd soit revers
4000   700  100   2  20  1
```

Six nombres par balle : **RPM roue haute, RPM roue basse, hauteur, chute,
cadence, répétitions**. `;` commence un commentaire, et `|` sépare des variantes
d'une même balle — à l'import, leur présence active l'ordre aléatoire.

> Dans les formats **smee** et **CSV 1.3**, la cadence est un **pourcentage**
> (0–100), pas des bpm : `0` → 30 bpm, `50` → 60 bpm, `100` → 90 bpm. NovaKontrol
> fait la conversion dans les deux sens.

```bash
./nova export retour-service-rapide -o drill.csv              # CSV actuel (défaut)
./nova export retour-service-rapide --format smee             # texte de smee
./nova export retour-service-rapide --format csv-legacy       # ancien CSV 1.3

./nova import drill.csv --name "Repris d'olanga"              # format détecté
./nova import novadrill.txt --name "Repris de smee"
./nova import ancien.csv --format csv-legacy                  # forcer le format
```

Le format est **détecté automatiquement** à l'import : dix colonnes séparées par
`;` → CSV actuel, neuf colonnes → CSV 1.3, le reste → texte de smee.

Deux limites à connaître :

- **Les formats smee et CSV 1.3 décrivent les roues en tours/minute**, pas en
  « vitesse + effet ».
  Or ces deux paramètres avancent par pas de 0.5 (contrainte du tableau
  « vitesse → spin maximal » du firmware), soit 171 tr/min par cran d'effet.
  Un `4000/700` de smee devient donc `3941/521`. NovaKontrol affiche l'écart
  maximal plutôt que de le taire.
- **Aucun des deux formats ne transporte l'ordre aléatoire ni le mode**
  (minutes / séries / sans fin). Un aller-retour repart en ordre fixe et sans
  fin — sauf avec le format smee, où la présence de `|` réactive le hasard.

---

## Utilisation comme serveur MCP

NovaKontrol est aussi un serveur MCP : DeepSeek ou Claude peut alors créer et
envoyer les exercices lui-même, sans que tu tapes de commande.

### Configuration

```json
{
  "mcpServers": {
    "novakontrol": {
      "command": "node",
      "args": ["/home/michael/novaKontrol/src/mcp.js"]
    }
  }
}
```

- **Claude Desktop** : `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) ou `%APPDATA%\Claude\claude_desktop_config.json` (Windows).
- **LobeHub / tout client MCP** : même structure ; `command` et `args` suffisent.
- La commande `./nova mcp` lance le même serveur.

### Outils exposés

| Outil | Rôle |
|---|---|
| `create_drill` | Traduit une demande en langage naturel et enregistre l'exercice |
| `create_from_template` | Enregistre un gabarit, sans IA |
| `list_templates` | Liste les gabarits |
| `list_drills` / `get_drill` / `delete_drill` | Parcourir et gérer la bibliothèque |
| `export_drill` / `import_drill` | Échanger des fichiers (CSV d'olanga, CSV 1.3 ou texte de smee) |
| `describe_parameters` | Bornes et contraintes physiques, pour raisonner |
| `scan_robots` | Chercher le robot |
| `connect_robot` / `disconnect_robot` | Ouvrir et fermer la liaison |
| `send_drill` | Envoyer un exercice (connexion automatique si besoin) |
| `stop_drill` / `pause_drill` / `resume_drill` | Piloter l'exercice en cours |
| `get_status` | État du robot et de la bibliothèque |

Le serveur vit longtemps : il garde la connexion Bluetooth entre les appels, donc
un `send_drill` suivi d'un `stop_drill` fonctionne naturellement.

---

## Les paramètres d'un exercice

| Paramètre | Plage | Pas | Signification |
|---|---|---|---|
| `speed` | 0 – 10 | 0.5 | vitesse de la balle (0 = très lent, 10 = très rapide) |
| `spin` | −10 – 10 | 0.5 | **positif = top-spin**, négatif = back-spin |
| `height` | −50 – 100 | 1 | hauteur de la balle (50 = hauteur moyenne) |
| `dropPoint` | −10 – 10 | 0.5 | **négatif = à droite** (côté revers), **0 = plein milieu**, positif = à gauche (côté coup droit) |
| `frequency` | 30 – 90 | 1 | cadence, en **balles par minute** (bpm) |
| `reps` | 1 – 200 | 1 | nombre de répétitions de la balle avant de passer à la suivante |

**Mode** : `endless` (tourne jusqu'à l'arrêt), `minutes` (durée), `combos`
(nombre de séries). **Ordre** : `random: true` joue les balles dans le désordre —
c'est ce qui rend une répartition droite / centre / gauche réellement imprévisible.

**Contrainte physique** : plus la balle est rapide, moins on peut y mettre
d'effet.

| vitesse | 0 | 0.5 | 1 | 1.5 | 2 | 2.5 | 3 | 3.5 | 4 | 4.5 | 5 | 5.5 | 6 | 6.5 | 7 | 7.5 | 8 | 8.5 | 9 | 9.5 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| spin max | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 10 | 9 | 8 | 8 | 7 | 6 | 5 | 4 | 3 | 2 | 1 | 0 |

Une vitesse de 10 interdit donc tout effet. NovaKontrol ramène automatiquement
une combinaison impossible dans les bornes et te le signale plutôt que de laisser
le robot refuser l'exercice.

> **Sur la cadence : attention à l'unité.** Elle s'exprime en **balles par minute**
> (30–90), comme le champ « BPM » de l'interface d'olanga. Mais le paquet, lui,
> ne stocke pas des bpm : olanga applique une double conversion
>
> ```
> pourcentage interne p = (bpm − 30) / 0,6      →  0…100
> valeur du paquet      = p / 100 + 0,5         →  0,5…1,5
> ```
>
> Donc **30 bpm vaut 0,5** dans le paquet, pas 0,8. Confondre les deux unités est
> l'erreur facile — elle a réellement existé dans ce projet, et faisait envoyer
> 45 bpm à 0,95 au lieu de 0,75, soit 27 % trop vite. NovaKontrol applique
> exactement la conversion d'olanga (`js/state.js` pour le CSV,
> `js/bluetooth.js` pour l'encodage), et un test la verrouille.
>
> Corollaire : les presets *internes* d'olanga comme
> `PUSH_B = [1547, 2915, 50, -5, 10, 1]` contiennent un **pourcentage**, pas des
> bpm — leur `10` correspond à 36 bpm.

---

## Architecture

```
src/
  protocol.js        encodage binaire, validation, formules de RPM, formats de fichier
  auth.js            poignée de main MD5, décodage des notifications
  head.js            rotation du pivot latéral : effet réel selon l'angle (pur)
  ballistics.js      profondeur, rebonds et trajectoire : source unique des deux vues
  setup.js           placement du robot (grille 3×3 et angle) et conseils associés
                     (purs ; head.js, ballistics.js et setup.js sont servis au
                     navigateur via /lib/, depuis une liste blanche explicite)
  ble.js             Link (interface) → BleLink (node-ble) · NovaSession · NovaRobot
  library.js         bibliothèque d'exercices et réglages, persistés en JSON
  cloud.js           librairie en ligne partagée (lister, lire par code, publier)
  deepseek.js        appel à l'API DeepSeek + validation et réparation
  templates.js       gabarits utilisables sans clé API
  server.js          serveur HTTP local : API JSON + fichiers de l'interface
  control-socket.js  socket local pour piloter l'exercice depuis un autre terminal
  cli.js             interface en ligne de commande
  mcp.js             serveur MCP
  config.js / ui.js  configuration (.env) et affichage
web/                 interface : index.html, app.js, style.css (aucune dépendance)
test/                277 tests, sans matériel ni réseau
```

`protocol.js` et `auth.js` sont **purs** : aucune entrée-sortie, donc entièrement
testables. `NovaSession` ne connaît que l'interface `Link`, ce qui permet de lui
donner un robot simulé.

### Le protocole, vérifié

L'encodage a été reconstitué à partir de [olanga/nova](https://github.com/olanga/nova),
[smee/nova-s-custom-drills](https://github.com/smee/nova-s-custom-drills) et
[whoisbe/pongbot-mcp](https://github.com/whoisbe/pongbot-mcp), puis **confronté
octet par octet aux implémentations d'origine** (voir `test/protocol.test.js`) et
à une implémentation Python indépendante pour l'empreinte MD5.

Deux corrections par rapport à ce qu'on lit parfois :

- **Il n'existe pas de champ « miroir » ni de champ « niveau » dans le paquet.**
  L'en-tête est `[0x81][longueur u16le][mode u8][valeur u16le][aléatoire u8]`.
  Les octets 2 et 5 qu'on voit interprétés ailleurs comme « niveau » et
  « miroir » sont en réalité les octets de poids fort de la longueur et de la
  valeur de mode. Les confondre fonctionne tant qu'ils valent zéro, et corrompt
  le paquet dès qu'on les change. Le miroir se fait en **inversant le point de
  chute**.
- **Jusqu'à 20 balles par exercice** : `7 + 20×24 = 487` octets, ce qui tient
  dans une écriture longue ATT (512 octets).

La séquence d'authentification (7 étapes, MD5 salé) est rejouée dans les tests
par un robot simulé qui **recalcule l'empreinte de son côté** : une erreur
d'authentification fait donc échouer la suite.

---

## Tests

```bash
npm test
```

227 tests, sans matériel ni accès réseau requis :

- l'encodage binaire, comparé aux implémentations d'origine sur plus de
  2000 combinaisons de paramètres ;
- la poignée de main d'authentification, rejouée par un robot simulé qui
  recalcule l'empreinte de son côté ;
- le transport BLE complet (connexion, envoi, arrêt, keepalive, déconnexion) ;
- le modèle de rotation de tête et ses couleurs ;
- la balistique : réponses aux trois paramètres, cohérence entre la profondeur
  annoncée et le point de chute, et modèle de rebonds comparé aux mesures
  publiées sur le forum ;
- le placement du robot : neuf cases, bornage, et descriptions ;
- la librairie en ligne et le format d'échange d'olanga, avec un `fetch` factice ;
- l'API HTTP du serveur, sur un port éphémère et un robot simulé ;
- la génération DeepSeek, la bibliothèque, la configuration, le CLI et le
  serveur MCP de bout en bout.

---

## Dépannage

**Le bouton « Connecter » ne semble rien faire**
La connexion prend une dizaine de secondes (scan Bluetooth). Le bouton passe à
« Connexion… », se désactive, et l'**en-tête** annonce l'étape en cours
(« Connexion au robot… », « Tentative 2/3… »). Si l'adresse mémorisée n'est plus
joignable, un scan est relancé automatiquement — la cause la plus fréquente étant
un robot déplacé ou réappairé.

**« Aucun robot Nova trouvé »**
Le robot est éteint, hors de portée, ou déjà connecté à l'application officielle
sur un téléphone. Ferme l'application, puis `nova scan`.

**« L'adaptateur Bluetooth est éteint »**
```bash
bluetoothctl power on
rfkill unblock bluetooth
```

**Le robot s'arrête tout seul au bout d'un moment**
L'exercice est interrompu si la liaison Bluetooth tombe. Garde `nova send` ouvert
pendant l'entraînement. À noter : le robot coupe aussi la liaison après environ
13 minutes d'inactivité, keepalive ou non — un défaut connu du firmware, sans
solution à ce jour. Relance simplement la connexion.

**« Délai dépassé en attendant : le défi d'authentification »**
Le robot a refusé la poignée de main, souvent parce qu'une autre connexion
Bluetooth est active. Éloigne les autres appareils, redémarre le robot, réessaie.

**« Réponse DeepSeek sans contenu exploitable »**
Le modèle a raisonné mais n'a pas conclu : son budget de sortie a été absorbé par
le raisonnement. Reformule la demande, ou essaie `--model deepseek-v4-pro`.

**Quel modèle DeepSeek utiliser ?**
Voir [Quel modèle ?](#quel-modèle) plus haut.

**La clé API n'est pas lue**
Vérifie qu'elle est bien dans `.env` à la racine du projet, puis `nova doctor`.
Une variable d'environnement déjà définie et non vide l'emporte sur le fichier ;
`NOVA_ENV_PATH` permet de pointer vers un autre fichier `.env`.

**Une roue est ramenée à 400 tr/min**
C'est le plancher matériel. À faible vitesse avec beaucoup d'effet, la roue
lente descend sous 400 tr/min : NovaKontrol la remonte et te le signale, mais
l'effet réellement produit sera plus faible que demandé.

---

## Crédits

Le travail difficile — rétro-ingénierie du protocole BLE, formules de RPM,
mise à l'échelle des paramètres et poignée de main MD5 — a été fait par d'autres :

- **[olanga](https://github.com/olanga/nova)** — format des paquets de drill et
  constantes d'authentification ; c'est aussi la référence pour le format CSV.
- **[smee](https://github.com/smee/nova-s-custom-drills)** — commandes de
  contrôle et machine à états de la connexion.
- **[whoisbe](https://github.com/whoisbe/pongbot-mcp)** — réimplémentation
  Python, mise au point du cycle de connexion et analyse des captures BLE.

NovaKontrol est une réimplémentation en Node.js, avec une bibliothèque
d'exercices, une couche de génération par DeepSeek et un serveur MCP.

Licence MIT.
# nova-s-pro
