# NovaKontrol

Créer un exercice de tennis de table en le **demandant à DeepSeek en français**,
l'enregistrer dans sa librairie, puis l'**envoyer au robot Pongbot Nova S Pro** en
Bluetooth.

[Français](#français) · [English](#english)

---

# Français

## Remerciements

Tout le travail difficile a été fait par d'autres, et sans eux ce projet
n'existerait pas : la rétro-ingénierie du protocole Bluetooth, les formules de
vitesse des roues, la mise à l'échelle des paramètres et la poignée de main MD5
ont été comprises, documentées et publiées par des personnes qui n'avaient aucune
obligation de le faire.

**Dépôts GitHub**

- **[olanga/nova](https://github.com/olanga/nova)** — le format des paquets
  d'exercice, les constantes d'authentification, et le format CSV qui sert de
  référence à l'import comme à l'export.
- **[smee/nova-s-custom-drills](https://github.com/smee/nova-s-custom-drills)** —
  les commandes de contrôle et la machine à états de la connexion.
- **[whoisbe/pongbot-mcp](https://github.com/whoisbe/pongbot-mcp)** —
  réimplémentation en Python, mise au point du cycle de connexion et analyse des
  captures Bluetooth.

**Sites et ressources**

- La feuille de mesures **« Sextuples for Slow Balls and Cerves »**, partagée sur
  un forum de tennis de table : 84 valeurs de roues relevées sur le robot, par
  hauteur de balle et par effet. C'est elle qui a rendu le modèle de profondeur
  crédible — et qui a corrigé plusieurs de mes suppositions.
- La **librairie en ligne publique** (PocketBase, `nova.varandal.de`) mise à
  disposition par le projet olanga/nova : c'est elle qui permet de s'échanger des
  exercices par un code de 6 caractères.
- **[DeepSeek](https://platform.deepseek.com)** — l'API qui traduit une intention
  d'entraînement en paramètres de robot.
- **Pongbot**, pour le Nova S Pro et son manuel, qui documente précisément les
  plages de réglage et les réglages manuels.

Merci aussi aux auteurs des bibliothèques utilisées : `node-ble` et le SDK MCP.

> ### 📄 Le détail technique est dans [`docs/TECHNIQUE.md`](docs/TECHNIQUE.md)
>
> **Ce document est le travail des sources citées ci-dessus, pas le mien.** Il
> rassemble le protocole Bluetooth (paquets, poignée de main MD5, commandes), les
> formules de vitesse des deux roues, la mise à l'échelle des paramètres, le
> modèle de profondeur et les formats de fichiers — tout ce qui a été rétro-conçu
> par olanga, smee et whoisbe, et tout ce qui a été mesuré par les auteurs de la
> feuille « Sextuples for Slow Balls and Cerves ».
>
> Il indique aussi, section par section, **ce qui est mesuré, ce qui est calibré
> et ce qui est simplement déduit** — parce que tout n'a pas la même solidité, et
> qu'il serait malhonnête de présenter une estimation comme une mesure. Seule la
> dernière section décrit ce que NovaKontrol ajoute.

## L'intérêt de cette application

**1. Tu décris ce que tu veux travailler, en français.**

```
je veux apprendre à retourner les services très rapides avec effets latéraux qui
m'arrivent presque au milieu de la table. Un service à droite, un au centre et un
à gauche, aléatoirement, mais tous de la même longueur.
```

Trois balles, trois placements, cadence et effet cohérents, avec les conseils
techniques qui vont avec. Tu ne remplis pas six champs numériques par balle.

**2. Tu vois ce que le robot va faire avant de l'envoyer.** Une vue de dessus avec
les rebonds, les zones et la position du robot ; une vue de côté avec la
trajectoire, le filet et le temps de vol. Les balles se déplacent à la souris :
horizontalement pour le placement, verticalement pour la profondeur.

**3. Tu ne peux pas régler quelque chose d'impossible.** Les deux roues du robot
n'acceptent que 500 à 7200 tr/min. Quand ta combinaison vitesse/effet les dépasse,
le logiciel calcule la valeur **réellement jouable**, l'affiche, et affiche le
plafond à côté du champ. Ce que tu lis est ce qui part — jamais un réglage
théorique que le robot refuserait.

**4. Ta librairie t'appartient.** Un dossier, un fichier JSON lisible, des
sauvegardes automatiques. Aucun compte, aucun service tiers, rien qui parte sur
Internet sans que tu le demandes. Et l'import/export parle les formats des autres
outils (CSV d'olanga, format texte de smee), donc rien n'est prisonnier.

**5. Tu peux échanger des exercices.** La librairie en ligne publique se parcourt
par nom ou par code de 6 caractères, et tu peux y publier les tiens.

**6. Tu peux piloter le tout depuis un assistant IA.** Le serveur MCP expose la
création, la liste, l'envoi et l'arrêt : « crée-moi un exercice sur les services
courts, puis envoie-le » fonctionne depuis Claude ou tout autre client MCP.

**7. Ça tourne en local, simplement.** Un processus Node, aucune dépendance côté
navigateur, une interface servie sur `127.0.0.1` uniquement.

**Et tu places les silences où tu veux.** Une pause se pose entre deux balles
précises — pas entre toutes — et se règle comme une cadence : « une pause à
30 bpm », c'est la durée d'un battement à cette cadence, soit 2 secondes. Les
balles sans pause s'enchaînent normalement.

## Déploiement

### Prérequis

| Élément | Détail |
|---|---|
| Node.js | 20 ou plus (testé sur 22) |
| Système | **Linux** — le Bluetooth passe par BlueZ via D-Bus |
| Bluetooth | un adaptateur actif et allumé |
| Robot | un Pongbot Nova S Pro allumé, à moins de 10 m |
| Clé API | une clé DeepSeek pour la création libre (facultatif : des gabarits sont fournis) |

> **macOS / Windows ?** `node-ble` ne fonctionne que sur Linux. Toute la couche
> Bluetooth est isolée derrière l'interface `Link` de `src/ble.js` : la logique
> d'authentification, d'encodage et de commande est indépendante du transport. Il
> suffit d'écrire une autre implémentation de `Link` (par exemple avec
> `@abandonware/noble`, multiplateforme) pour porter le projet. Les tests du
> protocole et de la poignée de main, eux, tournent partout.

### Installation

```bash
cd novaKontrol
npm install
cp .env.example .env      # puis renseigne DEEPSEEK_API_KEY
./nova doctor --scan      # vérifie que tout est en place
```

Le fichier `.env` sert à la clé DeepSeek, au modèle, aux délais Bluetooth et à
l'emplacement des données. Une variable déjà présente dans l'environnement est
toujours prioritaire sur le `.env` — pratique pour lancer une instance de test
avec un `NOVA_DATA_DIR` temporaire.

### Lancer l'interface web

```bash
./nova web                       # http://127.0.0.1:4173
./nova web --port 4174           # un autre port
./nova web --host 0.0.0.0        # exposer sur le réseau (à tes risques)
```

L'interface n'écoute que sur `127.0.0.1` par défaut : elle n'est visible que
depuis cette machine.

### Utiliser la ligne de commande

Trois formes équivalentes — prends celle qui te convient :

```bash
./nova list          # depuis le dossier du projet (le plus simple)
node nova list       # même chose, en passant explicitement par Node
npm link             # puis, depuis n'importe où : nova list
```

```bash
# Créer un exercice
./nova create "trois services rapides, un à droite, un au centre, un à gauche"
./nova create --template poussette-backspin --name "Poussettes du lundi"
./nova create "..." --dry-run          # voir sans enregistrer

# Consulter, exporter
./nova list [--tag service]
./nova show retour-service-rapide --hex
./nova export retour-service-rapide --format csv -o exo.csv
./nova import exo.csv

# Envoyer au robot
./nova scan                            # trouver l'adresse Bluetooth
./nova send retour-service-rapide
./nova stop | pause | resume
./nova status
```

Toutes les commandes sont listées par `./nova help`.

### Utiliser comme serveur MCP

Pour piloter NovaKontrol depuis un assistant (Claude Desktop, LobeHub, etc.),
recopie `mcp-config.example.json` dans la configuration de ton client, en
remplaçant le chemin par le chemin absolu de ce dossier :

```json
{
  "mcpServers": {
    "novakontrol": {
      "command": "node",
      "args": ["/chemin/absolu/vers/novaKontrol/src/mcp.js"]
    }
  }
}
```

L'assistant dispose alors de la création par DeepSeek, de la liste, de la
consultation, de l'envoi, de l'arrêt et de l'export.

### Autoriser l'accès à BlueZ

Si `node-ble` n'arrive pas à joindre BlueZ, autorise ton utilisateur sur le bus
D-Bus système :

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

Sur Ubuntu 24.04, la politique par défaut autorise déjà l'accès à `org.bluez` :
cette étape est en général inutile.

### Où sont les données

| Chemin | Contenu |
|---|---|
| `data/drills.json` | la librairie : un JSON lisible, que tu peux éditer ou versionner |
| `data/settings.json` | la tête, la position du robot, l'adresse Bluetooth retenue |
| `data/backups/` | les 30 dernières versions de la librairie, écrites avant chaque modification |

`NOVA_DATA_DIR` change ce dossier — utile pour tester sans toucher à ta librairie.

### Tests

```bash
npm test        # 316 tests : protocole, poignée de main, API, CLI, MCP, ballistique
```

Les tests n'ont besoin ni de robot ni de clé API : ils tournent dans un dossier
temporaire isolé, avec un robot simulé.

### Dépannage express

| Symptôme | Cause probable |
|---|---|
| `Le serveur ne sert pas le module « … »` | le serveur tourne une version plus ancienne que le code sur le disque : redémarre-le |
| `Device not found` | robot éteint, hors de portée, ou adresse changée : `./nova scan` |
| La page ne répond plus | l'ancien serveur tient encore le port : arrête-le avant d'en relancer un |
| L'interface n'affiche pas mes modifications | recharge la page sans cache (Ctrl+Shift+R) |

---

# English

## Acknowledgements

All the hard work was done by others, and this project would not exist without
them: the reverse-engineering of the Bluetooth protocol, the wheel-speed
formulas, the parameter scaling and the MD5 handshake were figured out,
documented and published by people who had no obligation to do so.

**GitHub projects**

- **[olanga/nova](https://github.com/olanga/nova)** — the drill packet format,
  the authentication constants, and the CSV format used as the reference for both
  import and export.
- **[smee/nova-s-custom-drills](https://github.com/smee/nova-s-custom-drills)** —
  the control commands and the connection state machine.
- **[whoisbe/pongbot-mcp](https://github.com/whoisbe/pongbot-mcp)** — a Python
  reimplementation, which nailed down the connection cycle and analysed the
  Bluetooth captures.

**Websites and resources**

- The **“Sextuples for Slow Balls and Cerves”** measurement sheet, shared on a
  table-tennis forum: 84 wheel values measured on the actual robot, by ball
  height and spin. It is what made the depth model credible — and it corrected
  several of my assumptions.
- The **public online library** (PocketBase, `nova.varandal.de`) provided by the
  olanga/nova project: it is what lets people exchange drills through a
  6-character code.
- **[DeepSeek](https://platform.deepseek.com)** — the API that turns a training
  intention into robot parameters.
- **Pongbot**, for the Nova S Pro and its manual, which documents the setting
  ranges and the manual adjustments precisely.

Thanks as well to the authors of the libraries used: `node-ble` and the MCP SDK.

> ### 📄 The technical details live in [`docs/TECHNIQUE.md`](docs/TECHNIQUE.md)
>
> **That document is the work of the sources credited above, not mine.** It
> gathers the Bluetooth protocol (packets, MD5 handshake, control commands), the
> speed formulas for both wheels, the parameter scaling, the depth model and the
> file formats — everything that olanga, smee and whoisbe reverse-engineered, and
> everything the authors of the “Sextuples for Slow Balls and Cerves” sheet
> measured.
>
> It also states, section by section, **what is measured, what is calibrated and
> what is merely inferred** — because not all of it is equally solid, and passing
> an estimate off as a measurement would be dishonest. Only the last section
> describes what NovaKontrol itself adds.
>
> *(The technical reference is written in French, the language of the source
> code's comments.)*

## Why this application

**1. You describe what you want to work on, in plain language.**

```
I want to learn to return very fast serves with sidespin that land almost in the
middle of the table. One serve to the right, one to the centre and one to the
left, at random, but all the same length.
```

Three balls, three placements, consistent pace and spin, along with the coaching
notes that go with them. You do not fill in six numeric fields per ball.

**2. You see what the robot will do before sending it.** A top-down view with
bounces, zones and the robot's position; a side view with the trajectory, the net
and the flight time. Balls are dragged with the mouse: horizontally for placement,
vertically for depth.

**3. You cannot set something impossible.** The robot's two wheels only accept 500
to 7200 rpm. When your speed/spin combination exceeds that, the software computes
the value that is **actually playable**, shows it, and displays the ceiling next
to the field. What you read is what gets sent — never a theoretical setting the
robot would refuse.

**4. The library is yours.** One folder, one readable JSON file, automatic
backups. No account, no third-party service, nothing leaving your machine unless
you ask. Import and export speak other tools' formats (olanga's CSV, smee's text
format), so nothing is locked in.

**5. You can exchange drills.** The public online library can be browsed by name
or by 6-character code, and you can publish yours.

**6. You can drive the whole thing from an AI assistant.** The MCP server exposes
creation, listing, sending and stopping: “create me a drill on short serves, then
send it” works from Claude or any other MCP client.

**7. It runs locally, simply.** One Node process, no browser-side dependency, an
interface served on `127.0.0.1` only.

**And you place the silences where you want them.** A pause sits between two
specific balls — not between all of them — and is set as a tempo: “a pause at
30 bpm” is the duration of one beat at that tempo, i.e. 2 seconds. Balls without a
pause run straight into the next one.

## Deployment

### Requirements

| Item | Detail |
|---|---|
| Node.js | 20 or later (tested on 22) |
| System | **Linux** — Bluetooth goes through BlueZ over D-Bus |
| Bluetooth | an active, powered adapter |
| Robot | a Pongbot Nova S Pro, powered on, within 10 m |
| API key | a DeepSeek key for free-form creation (optional: templates are included) |

> **macOS / Windows?** `node-ble` only works on Linux. The whole Bluetooth layer
> is isolated behind the `Link` interface in `src/ble.js`: the authentication,
> encoding and command logic is transport-independent. Writing another `Link`
> implementation (for instance with the cross-platform `@abandonware/noble`) is
> all it takes to port the project. The protocol and handshake tests run
> everywhere.

### Installation

```bash
cd novaKontrol
npm install
cp .env.example .env      # then fill in DEEPSEEK_API_KEY
./nova doctor --scan      # check that everything is in place
```

The `.env` file holds the DeepSeek key, the model, the Bluetooth timeouts and the
data location. A variable already present in the environment always takes
precedence over `.env` — handy to run a test instance with a temporary
`NOVA_DATA_DIR`.

### Run the web interface

```bash
./nova web                       # http://127.0.0.1:4173
./nova web --port 4174           # another port
./nova web --host 0.0.0.0        # expose on the network (at your own risk)
```

The interface listens on `127.0.0.1` only by default: it is reachable from this
machine alone.

### Use the command line

Three equivalent forms — pick whichever suits you:

```bash
./nova list          # from the project folder (simplest)
node nova list       # the same, going through Node explicitly
npm link             # then, from anywhere: nova list
```

```bash
# Create a drill
./nova create "three fast serves, one right, one centre, one left"
./nova create --template poussette-backspin --name "Monday pushes"
./nova create "..." --dry-run          # preview without saving

# Browse, export
./nova list [--tag service]
./nova show retour-service-rapide --hex
./nova export retour-service-rapide --format csv -o drill.csv
./nova import drill.csv

# Send to the robot
./nova scan                            # find the Bluetooth address
./nova send retour-service-rapide
./nova stop | pause | resume
./nova status
```

Every command is listed by `./nova help`.

### Use as an MCP server

To drive NovaKontrol from an assistant (Claude Desktop, LobeHub, etc.), copy
`mcp-config.example.json` into your client's configuration, replacing the path
with the absolute path to this folder:

```json
{
  "mcpServers": {
    "novakontrol": {
      "command": "node",
      "args": ["/absolute/path/to/novaKontrol/src/mcp.js"]
    }
  }
}
```

The assistant then has access to DeepSeek creation, listing, inspection, sending,
stopping and export.

### Allow access to BlueZ

If `node-ble` cannot reach BlueZ, allow your user on the system D-Bus:

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

On Ubuntu 24.04 the default policy already allows access to `org.bluez`: this step
is usually unnecessary.

### Where the data lives

| Path | Contents |
|---|---|
| `data/drills.json` | the library: a readable JSON file you can edit or version |
| `data/settings.json` | head angle, robot position, remembered Bluetooth address |
| `data/backups/` | the last 30 versions of the library, written before each change |

`NOVA_DATA_DIR` changes that folder — useful to experiment without touching your
library.

### Tests

```bash
npm test        # 316 tests: protocol, handshake, API, CLI, MCP, ballistics
```

The tests need neither a robot nor an API key: they run in an isolated temporary
folder, against a simulated robot.

### Quick troubleshooting

| Symptom | Likely cause |
|---|---|
| `Le serveur ne sert pas le module « … »` | the server runs an older version than the code on disk: restart it |
| `Device not found` | robot off, out of range, or address changed: `./nova scan` |
| The page stops responding | the previous server still holds the port: stop it before starting another |
| The interface does not show my changes | reload without cache (Ctrl+Shift+R) |

---

## Licence

MIT — dans les deux langues, et pour la même raison. Les remerciements ci-dessus
ne sont pas décoratifs : le protocole a été rétro-conçu par d'autres, et cette
licence est la moindre des choses.

MIT — in both languages, and for the same reason. The acknowledgements above are
not decorative: the protocol was reverse-engineered by others, and this licence is
the least I owe them.
