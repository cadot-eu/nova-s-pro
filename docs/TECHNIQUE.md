# NovaKontrol — Référence technique

> **Ce document n'est pas mon travail.** Presque tout ce qu'il contient a été
> rétro-conçu, mesuré et publié par d'autres, sans aucune obligation :
> [olanga](https://github.com/olanga/nova),
> [smee](https://github.com/smee/nova-s-custom-drills),
> [whoisbe](https://github.com/whoisbe/pongbot-mcp) et les participants du forum
> qui ont partagé la feuille de mesures « Sextuples for Slow Balls and Cerves ».
> Les sections 1 à 4 et 9 à 10 sont **leur travail**, retranscrit ici pour ne pas
> avoir à rouvrir trois dépôts à chaque question. La section 5 dit précisément ce
> qui est mesuré, ce qui est calibré et ce qui est déduit — c'est la partie que je
> dois à leur honnêteté méthodologique. La section 11 est la seule qui soit de
> NovaKontrol.

---

## 1. Le robot et la liaison

Le Pongbot Nova S Pro se pilote en **Bluetooth Low Energy**, pas en infrarouge.
Sous Linux, la liaison passe par **BlueZ via D-Bus** (bibliothèque `node-ble`).
Le robot se repère de deux façons : par son nom (`nova`, `pongbot`) ou, plus
sûr, par l'UUID court **`feff`** qu'il annonce.

| Rôle | UUID |
|---|---|
| Service | `02f00000-0000-0000-0000-00000000fe00` |
| Écriture (commandes, paquets) | `02f00000-0000-0000-0000-00000000ff01` |
| Notification (réponses) | `02f00000-0000-0000-0000-00000000ff02` |
| Lecture | `…ff00` et `…ff03` |
| UUID court annoncé | `feff` |

### Poignée de main

Le robot envoie un défi, le logiciel répond par un MD5 salé :

- sel : `Mjgx1jAwXDBaMFcxCz3JBgNVBAYT4kJF7Rkw`
- pour chaque caractère `c` du défi, on concatène `sel[code(c) % 36]`
- on renvoie le MD5 hexadécimal de la chaîne obtenue

### Commandes de contrôle

| Commande | Octets |
|---|---|
| Défi (challenge) | `07 00 00 00` |
| Acquittement 1 | `01 00 00` |
| Acquittement 2 | `02 00 00` |
| Réveil | `80 01 00 00` |
| Arrêt | `80 01 00 01` |
| Pause | `80 01 00 02` |
| Reprise | `80 01 00 03` |
| Keepalive | `83 06 00` |

Le **keepalive** est nécessaire : le robot coupe la liaison après environ
13 minutes d'inactivité. NovaKontrol l'envoie toutes les 10 secondes.

## 2. Protocole des exercices

Rétro-conçu par olanga (format des paquets, constantes d'authentification) et
smee (commandes, machine à états). Les entiers sont **little-endian**.

### Nouvel exercice — `0x81`

```
[0x81] [u16 longueur = 4 + 24×n] [u8 mode] [u16 modeValue] [u8 random] [n × 24 octets]
```

### Modification de l'exercice en cours — `0x84`

```
[0x84] [u16 longueur = 1 + 24×n] [n × 24 octets]
```

### Une balle — 24 octets

| Décalage | Type | Champ |
|---|---|---|
| 0 | u32 | vitesse de la roue **haute**, en tr/min |
| 4 | u32 | vitesse de la roue **basse**, en tr/min |
| 8 | f32 | hauteur de balle (échelle du §3) |
| 12 | f32 | point de chute (échelle du §3) |
| 16 | f32 | cadence (échelle du §3) |
| 20 | u32 | répétitions, 1 à 200 |

**Le paquet ne transporte aucune profondeur.** La longueur de la balle est une
conséquence de la vitesse, de la hauteur et de l'effet — jamais un paramètre.

### Modes

| Valeur | Sens | `modeValue` |
|---|---|---|
| `0x00` | minutes | nombre de minutes |
| `0x01` | séries (combos) | nombre de séries |
| `0x03` | sans fin | ignoré |

### Limites de taille

**20 balles maximum** : au-delà, l'écriture longue ATT (512 octets) tronque le
paquet. smee limite explicitement ses exercices personnalisés à **9 balles** —
c'est pourquoi NovaKontrol avertit au-delà de 9.

## 3. Mise à l'échelle des paramètres

Les unités « utilisateur » ne sont pas celles du paquet. Conversions exactes,
reprises d'olanga et vérifiées octet par octet contre son encodeur :

| Paramètre | Plage utilisateur | Formule vers le paquet |
|---|---|---|
| `height` | −50 … 100 | `(h + 50) / 150 × 50 − 20` → −20 … 30 |
| `dropPoint` | −10 … 10 | `(d + 10) / 20 × 44 − 22` → −22 … 22 |
| `frequency` | 30 … 90 bpm | `((bpm − 30) / 0,6) / 100 + 0,5` → 0,5 … 1,5 |
| `reps` | 1 … 200 | tel quel |

### La cadence, en balles par minute

Le paquet ne stocke pas des bpm mais un **pourcentage interne** de 0 à 100, que
la formule ci-dessus encode ensuite entre 0,5 et 1,5. Le manuel Pongbot l'appelle
« fréquence », en allemand *Stück pro Minute* — des pièces par minute. C'est
aussi ce que smee expose directement, en pourcentage par pas de 10 : d'où les
cadences rondes (45, 60 bpm) des exercices importés.

### Convention de signe du point de chute

Le manuel (§3.5.6) est explicite : **point de chute positif = à droite du
joueur**. Donc négatif = à gauche, côté revers ; `0` = plein milieu. Cette
convention a été inversée une fois dans NovaKontrol, ce qui envoyait toutes les
balles du mauvais côté — elle est désormais verrouillée par des tests.

## 4. Les roues : 500 à 7200 tr/min

Formules des deux roues, telles que publiées par olanga :

```
roue haute = 970 + 630,5 × speed + 342 × spin
roue basse = 970 + 630,5 × speed − 342 × spin
```

`spin` positif = top-spin, négatif = back-spin.

### D'où vient la plage

Sources divergentes, et il faut trancher :

- olanga borne à **[400, 7500]** ;
- smee valide **[500, 7200]**, alors que son propre encodeur tolère 7274 ;
- la feuille de mesures « Sextuples for Slow Balls and Cerves » (84 valeurs de
  roues relevées sur le robot) ne sort **jamais** de **[500, 7200]** et se colle à
  ces deux bornes — la signature d'une limite sondée expérimentalement.

NovaKontrol retient **[500, 7200]**.

### Deux plafonds qui ne coïncident pas

olanga publie une table « vitesse → amplitude de spin maximale » qui est une
limite du **firmware**. Elle ne coïncide pas avec la limite des **roues** :

| vitesse | table firmware | limite des roues | plafond retenu |
|---|---|---|---|
| 0 | 2 | 1 | **1** |
| 5 | 9 | 8,5 | **8,5** |
| 8,5 | 3 | 2,5 | **2,5** |
| 9,5 | 1 | 0,5 | **0,5** |
| 10 | 0 | 0 (vitesse à réduire) | **0**, vitesse bloquée à 9,5 |

Afficher la table du firmware seule revient à promettre « effet 3 à vitesse
8,5 » — un réglage que le robot refuse ensuite. NovaKontrol calcule le **minimum
des deux** et n'affiche que celui-là.

### Conséquences

- Vitesse maximale : **9,5**. À vitesse 10 sans effet, la formule donne
  7275 tr/min, au-delà de la borne. Le maximum absolu n'est donc atteignable
  qu'avec un peu d'effet — ce que les mesures confirment.
- Effet maximal à vitesse 0 : **1**. La limite basse (roue qui tourne trop
  lentement) mord avant la limite haute.

## 5. Mesuré, calibré, déduit

C'est le tableau à garder en tête : tout n'a pas la même solidité.

| Élément | Statut | Origine |
|---|---|---|
| Vitesses de roues | **mesuré** | 84 relevés sur le robot, feuille du forum |
| Nombre de rebonds selon la hauteur | **mesuré** | même feuille |
| Plage utilisable des roues | **mesuré** | la feuille bute exactement sur 500 et 7200 |
| Formules des roues, protocole, poignée de main | **rétro-conçu** | olanga, smee, whoisbe |
| Réglages manuels du robot | **documenté** | manuel Pongbot Nova S Pro |
| Profondeur en % de la table | **calibré** | modèle de NovaKontrol, aucune mesure |
| Effet chiffré du placement du robot | **estimé** | NovaKontrol |
| Temps de vol, apex, marge au filet | **calculé** | conséquence du modèle, pas mesuré |

Les vues de l'interface étiquettent la profondeur comme une **estimation** : le
protocole ne transporte aucune profondeur, il serait malhonnête de la présenter
comme une mesure.

## 6. Modèle de profondeur

La profondeur vient du **nombre de rebonds**, la seule grandeur liée à la
longueur qui ait été mesurée sur le robot.

```
profondeur = 0,95 − 0,115 × (rebonds − 1)
           + 0,16 × (vitesse/10 − 0,5)
           − 0,14 × (spin/10)
           + décalage de placement
```

Le nombre de rebonds sur la moitié du joueur est ajusté sur la feuille :

```
rebonds = 1 + 7,6 × ((max(0, hauteur − 10) / 85) ^ 1,15)
atténué par 1 / (1 + vitesse/14)     (les mesures portent sur des balles lentes)
minimum 1                            (la balle doit retomber sur la moitié du joueur)
```

Valeurs mesurées contre valeurs du modèle : 1 rebond à hauteur 10, 2 à 25, 3,8 à
50, 5 à 60, 7 à 80, 8 à 95. Une loi de puissance colle mieux qu'une droite
(écart moyen 0,32 rebond), parce que le nombre de rebonds se tasse au lieu de
croître indéfiniment.

**Pas de « falaise » entre 1 et 2 rebonds.** Une telle marche collait mieux aux
libellés de la feuille, mais elle rendait toute la zone 45–85 % **inatteignable** :
impossible de poser une balle au fond en la glissant, ni une balle mi-longue.
Décroissance régulière : on perd un peu de fidélité aux libellés, on gagne une
table entièrement réglable.

**Hauteur négative** (manuel §3.5.4) : le premier rebond se fait sur la moitié du
**robot**, ce qui ajoute un rebond sans allonger la balle.

## 7. Tête pivotante

Le manuel est clair : l'effet latéral est **manuel**. C'est le seul joint que
l'on règle à la main, sur `180° ± 90°`. Le logiciel ne peut donc pas le régler à
distance — il en **tient compte** et rappelle l'angle à utiliser.

Sept préréglages, repris des libellés du manuel : 0°, ±30°, ±60°, ±90°.

Décomposition de l'effet selon l'angle `θ` :

```
effet avant/arrière = spin × cos θ
effet latéral       = spin × sin θ
```

À 0° tout l'effet est avant/arrière ; à ±90° il est entièrement latéral. Les
balles sont colorées selon le résultat : vert top-spin, jaune back-spin, orange
mixte, bleu latéral pur.

## 8. Placement du robot

Le manuel décrit une page « position de la machine » en **neuf cases** : trois
lignes (fond de table, milieu, près du filet) et trois colonnes (gauche, centre,
droite), angle 0° par défaut.

L'effet chiffré de ce placement est une **estimation de NovaKontrol** :

- chaque cran de profondeur vaut **8 %** de la moitié de table — reculer le robot
  raccourcit la balle, l'avancer l'allonge (le manuel §3.5.7 dit la même chose
  pour la vitesse : plus vite = plus près du bord) ;
- chaque cran latéral vaut **12 %** de la largeur.

Le réglage physique est **enregistré avec l'exercice** : un exercice a été conçu
avec une position de robot et une rotation de tête données.

## 9. Formats de fichiers

| Format | Origine | Contenu |
|---|---|---|
| `csv` | olanga/nova v2 | 10 colonnes : `Set;Ball;Name;Speed;Spin;Type;Height;Drop;BPM;Reps` |
| `csv-legacy` | olanga/nova 1.3 | 9 colonnes, vitesses de roues au lieu de vitesse/effet |
| `smee` | smee | 6 nombres : roue haute, roue basse, hauteur, chute, cadence %, répétitions |

La détection est automatique (nombre de points-virgules). À l'import, les formats
qui portent des **tr/min** font autorité : la vitesse et l'effet sont recalculés
depuis les roues, parce que c'est la mesure, pas l'arrondi.

## 10. Librairie en ligne

PocketBase public, mis à disposition par le projet olanga/nova :

```
https://nova.varandal.de/api/collections/shared_drills/records
```

Chaque exercice est identifié par un code de partage de **3 lettres suivies de
3 chiffres** (par exemple `JOB857`). La lecture est libre ; la publication est
publique et **irréversible** — l'API n'expose pas de suppression.

## 11. Ce que NovaKontrol ajoute

Le protocole et les formules viennent d'ailleurs. Ce qui suit est propre à ce
projet :

- **Génération en français par DeepSeek** — une intention d'entraînement devient
  un exercice, avec les conseils techniques qui vont avec.
- **Une interface web locale** : vue de dessus avec rebonds, zones et position du
  robot ; vue de côté avec trajectoire, filet et temps de vol ; balles déplaçables
  à la souris.
- **Cohérence entre ce qui est affiché et ce qui est envoyé.** L'écrêtage
  silencieux des roues est remplacé par un recalcul : quand une combinaison est
  impossible, le logiciel calcule la valeur réellement jouable, l'affiche, et
  affiche le plafond à côté du champ. Un seul jeu de limites, partagé entre le
  serveur et le navigateur (`src/wheels.js`), pour que l'écran ne puisse pas
  annoncer autre chose que ce que le robot recevra.
- **Pauses placées entre deux balles précises** — notion absente du protocole,
  obtenue en découpant l'exercice en segments envoyés successivement. Elles se
  règlent comme une **cadence** et non en secondes : « une pause à 30 bpm » vaut la
  durée d'un battement à cette cadence, soit 2 s. Le pas de 15 (15 · 30 · 45 · 60 ·
  75 · 90) tombe pile sur les cadences rondes du robot.
- **Librairie locale** en JSON lisible, avec sauvegardes automatiques avant
  chaque écriture, import/export aux formats des autres outils, et journalisation
  des suppressions.
- **Serveur MCP**, pour piloter le tout depuis un assistant.

### Ce que le robot ne sait pas faire

- Il **ne stocke pas** d'exercice : couper l'alimentation efface le dernier
  exercice reçu.
- Il ne transporte **aucune profondeur**.
- Il ne règle **pas** l'effet latéral : c'est un joint manuel.
- Il n'a **pas** de notion de pause entre deux balles.

---

## Sources

- **[olanga/nova](https://github.com/olanga/nova)** — format des paquets,
  constantes d'authentification, formules des roues, mise à l'échelle des
  paramètres, formats CSV, table « vitesse → spin » du firmware.
- **[smee/nova-s-custom-drills](https://github.com/smee/nova-s-custom-drills)** —
  commandes de contrôle, machine à états de la connexion, limite à 9 balles,
  format texte à six nombres.
- **[whoisbe/pongbot-mcp](https://github.com/whoisbe/pongbot-mcp)** —
  réimplémentation en Python, mise au point du cycle de connexion, analyse des
  captures Bluetooth.
- **Feuille « Sextuples for Slow Balls and Cerves »**, partagée sur un forum de
  tennis de table — 84 relevés de roues, et le nombre de rebonds par hauteur.
  C'est la source la plus précieuse du lot : c'est la seule **mesure**.
- **Manuel Pongbot Nova S Pro** — plages de réglage, réglages manuels, grille de
  placement, convention de signe du point de chute.
- **[DeepSeek](https://platform.deepseek.com)** — API de génération.
