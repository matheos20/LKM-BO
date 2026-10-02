# LKM-BO — Back-office de gestion des domaines du parc

Application web Node.js qui se connecte en **SSH** (module `ssh2`) aux serveurs du parc pour **lister, consulter, créer, verrouiller/déverrouiller, réparer et supprimer** les domaines, avec une interface TailwindCSS multilingue (FR, EN, ES, IT, PT, DE).

```
Navigateur ──HTTP (127.0.0.1)──▶ Express ──SSH (ssh2, clé ou mot de passe)──▶ tech@VPS:2279   (lecture, add-site, fixdroits)
                                   │                                         └▶ lockop@VPS:2278 (lock / unlock)
                                   └── locales/*.json · config/servers.json · .env
```

---

## 1. Démarrage rapide

```powershell
npm install              # dépendances
npm run build:css        # compile TailwindCSS → public/css/app.css
npm run set-password     # définit le mot de passe admin (hash scrypt dans .env)
npm test                 # tests unitaires (hors ligne, aucun accès serveur)
npm run check            # teste la connexion SSH à chaque serveur (lecture seule)
npm run serve            # → http://127.0.0.1:3000, sous surveillance
```

Prérequis : **Node.js ≥ 20** (testé avec 24.11), **MySQL / MariaDB**, et l'accès réseau aux ports SSH des serveurs.

---

## 1 bis. Rester debout : surveillance et redémarrage

`npm start` lance **un** processus. S'il s'arrête — une erreur jamais prévue, la machine
qui redémarre, MySQL qui n'est pas encore là — le back-office est mort jusqu'à ce que
quelqu'un s'en aperçoive. Cinq agents en dépendent chaque jour.

```powershell
npm run serve                        # lance le serveur SOUS SURVEILLANCE
npm run serve -- --once              # une seule fois, sans relance (pour voir une panne)
npm run service                      # montre ce qui serait installé au démarrage
npm run service -- install --yes     # démarre avec la session Windows
npm run service -- status
npm run service -- uninstall --yes
```

### Ce que le surveillant rattrape

| Panne | Comment elle se voit | Ce qu'il fait |
| --- | --- | --- |
| Le serveur s'arrête | le processus disparaît | relance, immédiatement puis de plus en plus espacé |
| Le serveur ne démarre pas | il meurt en une seconde | réessaie 1 s, 2 s, 4 s… jusqu'à une minute, et dit de regarder MySQL |
| Le serveur **ne répond plus** | il tourne, mais `/api/health` reste muet | le ferme et le relance après trois relévés manqués |

La deuxième colonne est celle qui compte : un processus bloqué ne se voit pas du dehors,
il *tourne*. C'est pour lui que la route de santé existe.

L'attente double à chaque échec parce qu'un serveur qui ne **peut** pas démarrer ne
démarrera pas davantage à la centième tentative : réessayer sans fin remplirait le disque
de journaux et masquerait la cause. Dès que le serveur tient une minute, le compteur
repart de zéro.

Journaux : `logs/supervisor.log` (ce que le surveillant a décidé) et `logs/service.log`
(la sortie du serveur lancé par la tâche planifiée).

### `GET /api/health`

**Sans authentification**, parce que ce qui surveille une application ne peut pas se
connecter avec un compte — et donc sans rien dire d'utile à un curieux : des compteurs
et un verdict, pas de version, pas de nom de serveur.

```json
{ "status": "ok", "uptimeSeconds": 3812,
  "checks": { "database": { "ok": true, "ms": 2 },
              "servers": { "configured": 5, "connected": 3, "connecting": 0, "error": 0, "disconnected": 2 } } }
```

Le code HTTP porte le verdict : **200** si tout va, **503** sinon. Un surveillant n'a donc
pas besoin de lire la réponse.

Le verdict ne retient que ce qui **empêche de travailler** : MySQL. Un VPS déconnecté est
l'état normal au démarrage — les sessions SSH s'ouvrent à la demande de l'agent. Les
compter comme un problème ferait sonner l'alarme tous les matins, et on finirait par ne
plus la regarder.

### Au démarrage de la machine

`npm run service -- install --yes` déclare une tâche Windows qui part **à l'ouverture de
session**. C'est ce qu'il faut sur un poste de travail, et cela ne demande aucun droit
d'administrateur.

Pour que le back-office serve **sans que personne soit connecté**, il faut
`--at=startup` — une console administrateur, **et** MySQL installé en service Windows
(XAMPP sait le faire). Sans cela, le serveur tournerait en rond faute de base.

Sur un serveur Linux, `deploy/lkm-bo.service` fait le même travail avec systemd. Chez un
hébergeur mutualisé comme o2switch, il n'y a rien à installer : c'est le panneau Node.js
de l'hébergeur qui relance l'application.

---

## 2. Configurer les identifiants SSH — étape par étape

### Étape 1 — Le fichier `.env` (secrets)

Copiez `.env.example` vers `.env` s'il n'existe pas encore. Les secrets **ne sont jamais** écrits dans le code ni dans `servers.json` : ce dernier ne contient que des *noms* de variables.

```ini
SSH_KEY_PATH=D:/ssh/tech-tsarajoro     # clé privée du compte tech (port 2279)
SSH_KEY_PASSPHRASE=                    # si la clé est protégée
LOCKOP_KEY_PATH=D:/ssh/tech-tsarajoro  # clé du compte lockop (port 2278), à ajuster si différente
```

> Utilisez des `/` dans les chemins Windows. Le fichier de clé doit rester lisible uniquement par votre compte Windows.

### Étape 2 — Les serveurs (`config/servers.json`)

Chaque serveur hérite du bloc `defaults` ; il suffit de surcharger ce qui change :

```json
{
  "defaults": {
    "port": 2279, "username": "tech",
    "auth": { "type": "key", "keyPathEnv": "SSH_KEY_PATH", "passphraseEnv": "SSH_KEY_PASSPHRASE" },
    "wwwRoot": "/srv/www",
    "commands": {
      "create":   "sudo -n /usr/local/sbin/add-site {domain} --reload",
      "fixPerms": "sudo -n /usr/local/sbin/fixdroits {domain}",
      "delete":   null
    },
    "lockop": { "port": 2278, "username": "lockop", "lock": "lock {domain}", "unlock": "unlock {domain}", "auth": { "...": "..." } }
  },
  "servers": [
    { "id": "vps-001", "label": "VPS 001", "group": "Racing", "host": "176.31.27.245" }
  ]
}
```

| Champ | Rôle |
|---|---|
| `id`, `label`, `group` | Identifiant technique, nom affiché, groupe dans la barre latérale |
| `auth.type` | `key` (clé privée), `password` (mot de passe) ou `agent` (agent SSH / Pageant) |
| `wwwRoot` | Racine des sites (`<wwwRoot>/<domaine>/public_html`) |
| `registry` | Registre domaine → utilisateur (`/etc/parc/sites.tsv`), `null` si absent |
| `canonFile` | Fichier nginx des domaines « www canonique », `null` si absent |
| `commands.*` | Modèles de commandes du CRUD. `{domain}` est **validé puis quoté** automatiquement. `null` = action désactivée |
| `lockop` | Compte à commande forcée pour `lock` / `unlock` (`null` = désactivé) |

**Authentification par mot de passe** : dans `servers.json`, `"auth": { "type": "password", "passwordEnv": "VPS_X_PASSWORD" }`, puis dans `.env`, `VPS_X_PASSWORD=...`.

Un exemple complet se trouve dans `config/servers.example.json`.

### Étape 3 — Empreintes des serveurs (anti-MITM)

À la première connexion, l'empreinte de chaque serveur est enregistrée dans `config/known_hosts.json`. Si elle change ensuite, **la connexion est refusée**. Pour exiger des empreintes pré-enregistrées, passez `SSH_STRICT_HOST_KEY=true`.

Empreintes actuellement épinglées (vérifiées contre votre `~/.ssh/known_hosts`) :

| Serveur | Empreinte ED25519 |
|---|---|
| VPS 001 — 176.31.27.245:2279 | `SHA256:tIQCT6v4mFtssfsLewWFZ/qxuzWDZSjdECkwZFcQc7Q` |
| VPS 002 — 178.32.16.144:2279 | `SHA256:Qmquf8MRv+6ouFpC7sPMppaAvVL3Q7VRBco2k3CaJeo` |
| VPS 003 — 149.56.134.209:2279 | `SHA256:SjK52myND/6EaudYhRcfAjLO++Ap3PYsQHr8K/WkqjA` |
| VPS 004 — 15.235.81.192:2279 | `SHA256:Or6DT8EsDdInaGCWiAvWM8G6wUY2Ww261dsB/5E64Ds` |
| Tiers1 — 51.255.193.235:2279 | `SHA256:yhhGCT4XfiynITgTqP2FCc5hg6pCrRf39ZXkc//VA0E` |

### Étape 4 — Accès au back-office

```powershell
npm run set-password
```

Cette commande demande le mot de passe (12 caractères minimum, saisie masquée), écrit son hash scrypt dans `ADMIN_PASSWORD_HASH` et génère `SESSION_SECRET` s'il est vide. L'identifiant est `ADMIN_USER` (par défaut `admin`). L'application **refuse de démarrer** tant que ces deux valeurs sont absentes.

### Étape 5 — Vérifier puis lancer

```powershell
npm run check            # ou : npm run check vps-002
npm start
```

`npm run check` n'effectue **que des lectures** : authentification, empreinte, droits `sudo -n -l`, nombre de domaines.

**Développement** : `npm run dev` recharge le serveur, et `npm run watch:css` recompile Tailwind à chaque modification.

---

## 3. Ce que l'application fait sur le parc

Le parc repose sur un **vhost nginx mutualisé** : un domaine correspond simplement au dossier `<wwwRoot>/<domaine>/public_html`. Le verrou est l'attribut immuable `chattr +i` posé sur `public_html`.

| Opération | Commande exécutée | Compte |
|---|---|---|
| **Read** — liste | `find` + `lsattr` + registre + carte canonique, en un seul appel (~0,5 s pour 8 000 domaines, mis en cache 2 min) | tech |
| **Read** — détails | `stat`, `du`, `lsattr`, socket PHP-FPM, utilisateur du site… | tech |
| **Create** | `sudo -n /usr/local/sbin/add-site <domaine> --reload` | tech + sudo |
| **Update** — verrouiller / déverrouiller | `lock <domaine>` / `unlock <domaine>` | lockop:2278 |
| **Update** — réparer les droits | `sudo -n /usr/local/sbin/fixdroits <domaine>` | tech + sudo |
| **Delete** | modèle `commands.delete` (désactivé par défaut, voir § 4) | tech + sudo |

La redirection canonique www, le certificat SSL (géré en frontal) et la racine web sont **affichés en lecture seule** : ils découlent du vhost commun et ne se règlent pas domaine par domaine.

À chaque connexion, l'application lit `sudo -n -l` et **désactive les boutons** des actions que le compte ne peut pas exécuter, avec la raison en info-bulle.

---

## 3 bis. Recherche globale

Deux questions reviennent sans cesse : **« sur quel VPS est ce domaine ? »** et
**« à quel article correspond cette adresse ? »**. Le champ de recherche du tableau de
bord répond aux deux — on y colle ce qu'on a sous la main, y compris l'adresse entière
prise dans la barre du navigateur.

```
https://biozenz.fr/transformez-votre-bien-etre-grace-a-la-magie-de-la-pleine-conscience
        └── biozenz.fr · VPS 001 · déverrouillé
            bien-etre/transformez-votre-bien-etre-grace-a-la-magie-de-la-pleine-conscience.php
            [Ouvrir l'article] [Gérer les fichiers] [Détails] [Verrouiller] [Voir en ligne]
```

« Ouvrir l'article » mène **droit au texte**, dans l'éditeur, sans passer par la liste
des 52 articles du site. **Verrouiller / Déverrouiller** agit sur place : le bouton
s'inverse et l'état affiché suit, sans relancer la recherche. Il disparaît sur un
domaine incomplet — il n'y a rien à verrouiller — et reste visible mais inactif quand
le geste est hors de portée, en disant laquelle : « droit manquant pour votre rôle »,
« accès lockop non configuré ».

| Ce qui est collé | Ce qui est rendu |
|---|---|
| `biozenz.fr` | le domaine, son serveur, son état, et les actions |
| `https://www.biozenz.fr/page/?utm=1#haut` | idem, plus l'article désigné par `/page` |
| `biozenz` | les domaines qui s'en approchent, à cliquer |
| un domaine absent | dit tel quel — et les serveurs non connectés sont nommés, car c'est la première raison d'un échec |

#### Trois choix qui font tenir l'ensemble

**Rien ne part au serveur pour un simple filtre.** Tant que ce qui est tapé ne ressemble
ni à un domaine complet ni à une adresse, le tableau en dessous filtre seul et le panneau
reste absent. Un même champ, deux usages, sans aller-retour inutile.

**La recherche se fait côté serveur**, sur les listes déjà en cache : le parc compte près
de 29 000 domaines, les télécharger pour chercher dedans n'aurait pas de sens. Aucune
commande SSH n'est lancée pour trouver un domaine ; le site n'est ouvert que si l'adresse
portait un chemin, pour y retrouver l'article.

**Le domaine exact l'emporte sur ce qui lui ressemble.** Taper `biozenz.fr` ne doit pas
proposer `biozenz.fr.old` à sa place. L'article, lui, est cherché par son adresse
publique (`permalinks.php`) **puis** par son fichier, car une partie du parc n'a pas de
permalinks — avec ou sans `.php`, avec ou sans barre finale.

Éprouvé contre le parc réel : l'adresse complète d'un article de `biozenz.fr` rend le
fichier, sa rubrique et son VPS ; `www.`, le port, les paramètres et l'ancre sont
écartés ; un chemin inventé dit que l'article manque **sans perdre le domaine**.

---

## 4. Gestionnaire de fichiers (par domaine)

Il s'ouvre depuis l'icône dossier d'une ligne du tableau, ou depuis le panneau de détails.

| Fonction | Détail |
|---|---|
| **Explorateur** | navigation dossier par dossier, fil d'Ariane, filtre instantané, dossiers en tête, taille / date / droits |
| **Navigation** | boutons **Précédent**, **Suivant** et **Dossier parent**, ligne `..` en tête de liste ; raccourcis `Alt+←`, `Alt+→`, `Alt+↑`, `Retour arrière`, et boutons latéraux de la souris. En revenant d'un sous-dossier, celui-ci est surligné un instant pour garder ses repères. `Alt+←` est intercepté : il ramène au dossier précédent au lieu de quitter l'application |
| **Édition** | éditeur intégré (Ctrl+S), refus des fichiers binaires, garde anti-écrasement : si le fichier a changé sur le serveur depuis son ouverture, l'enregistrement est refusé |
| **Renommage** | dans le dossier courant, refus si le nom est déjà pris |
| **Suppression** | confirmation listant les éléments ; les dossiers partent avec leur contenu |
| **Nouveau dossier / fichier** | création dans le dossier courant (le nouveau fichier s'ouvre dans l'éditeur) |
| **Téléversement** | envoi d'un fichier depuis votre poste, avec barre de progression ; pour un `.zip`, décompression facultative dans la foulée |
| **Compression** | archive `.zip` créée sur le serveur à partir de la sélection |
| **Décompression** | extraction d'un `.zip` dans un nouveau dossier ; si l'archive ne contient qu'un seul dossier racine, il est retiré — `parts.zip` donne `parts/…` et non `parts/parts/…` |
| **Téléchargement** | un fichier seul, ou une sélection / un dossier en `.zip` |

**Choix d'implémentation.** Les serveurs du parc n'ont ni `zip` ni `unzip` : les archives ZIP sont donc lues et écrites **par l'application** (`zlib`, sans dépendance). Les arborescences transitent en `tar` sur un seul flux, car chaque aller-retour SSH coûte environ 500 ms : une opération = une commande.

**Domaine verrouillé.** Le verrou (attribut immuable) rend le domaine **intégralement en lecture seule**, y compris les sous-dossiers. L'interface affiche un bandeau et désactive les actions d'écriture ; l'API répond `409`. Consultation et téléchargement restent possibles.

**Le verrou se manie sur place.** La barre d'outils porte, après un séparateur, un bouton **Verrouiller** / **Déverrouiller** : c'est le geste qui précède presque toujours une édition, et il obligeait jusqu'ici à sortir du gestionnaire, retrouver la ligne du domaine, puis revenir. Le reste de l'écran suit tout seul — le bandeau, les boutons d'écriture, le dossier relu puisque ses droits viennent de changer — et la liste des domaines est rafraîchie au retour, pour qu'elle ne montre pas un état périmé.

Le bouton disparaît sur un domaine **incomplet** (il n'y a rien à verrouiller) et reste visible mais inactif quand le geste est hors de portée, en disant laquelle : « Indisponible : droit manquant pour votre rôle », « Indisponible : accès lockop non configuré ». Les capacités du serveur et les droits du compte sont croisés côté serveur, jamais dans le navigateur.

**Après une extraction ou une création**, lancez « Réparer les droits » (`fixdroits`) sur le domaine pour réappliquer propriétaire et ACL attendus par nginx et PHP-FPM.

**Limites** (réglables dans `.env`) : 2 000 entrées affichées par dossier, 2 Mio par fichier dans l'éditeur, 200 Mio par archive, 200 Mio par téléversement, 200 éléments par opération groupée.

Un téléversement **n'écrase jamais** une entrée existante : renommez ou supprimez d'abord.

---

## 5. Utilisateurs, rôles et permissions (RBAC)

Les comptes vivent dans **MySQL / MariaDB** (base `lkm_bo`), comme tout le reste : rôles, permissions, sessions, journal d'audit, brouillons de sites, comptes et zones Cloudflare. Les migrations sont appliquées au démarrage, et chaque table comme chaque colonne porte un commentaire — la base se lit directement dans phpMyAdmin.

Les réglages par défaut visent l'installation XAMPP locale (`127.0.0.1:3306`, utilisateur `root`) et se changent dans `.env` : `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`.

### Sauvegarde

**Elle se fait toute seule** pendant que le serveur tourne : rien à lancer, rien à
penser. Une sauvegarde qu'il faut penser à faire n'est pas une sauvegarde.

```bash
npm run backup                     # en écrire une tout de suite
npm run backup -- list             # ce qui existe
npm run backup -- verify [nom]     # la RESTAURER pour de bon, dans une base jetable
npm run backup -- restore <nom>    # montre ce qui se passerait
npm run backup -- restore <nom> --yes
```

### On ne pose pas un minuteur, on rattrape le retard

Un minuteur de vingt-quatre heures posé au démarrage ne se déclencherait **jamais** sur
une machine qu'on éteint le soir, ou qu'un surveillant relance : le compte repartirait de
zéro à chaque fois. Le serveur regarde donc l'âge de la **dernière** sauvegarde, et en
fait une si elle est trop vieille. Une machine éteinte tout un week-end est sauvegardée
en revenant.

Cet âge se lit dans le dossier lui-même — les fichiers portent leur horodatage dans leur
nom. Rien à mémoriser ailleurs, rien à désynchroniser.

### Et on restaure pour de bon, régulièrement

Une sauvegarde jamais rejouée est un fichier dont on espère quelque chose. Tous les sept
jours, le serveur en **restaure une dans une base jetable** (`lkm_bo_verif`), compare
table par table, puis efface la base d'épreuve. La vraie base n'est jamais touchée.

Ce qui fait échouer le contrôle : le fichier ne se rejoue pas, une table manque, ou une
table est **vide** dans la sauvegarde alors qu'elle porte des lignes en production —
c'est la forme qu'aurait une perte de données. Les petits écarts de comptage, eux, ne
sont qu'une observation : la sauvegarde est plus ancienne que la base, le journal a
grossi depuis. Exiger l'égalité ferait échouer un contrôle parfaitement sain, et une
alerte qui se trompe finit par ne plus être lue.

Sauvegardes et contrôles entrent **au journal d'audit**, au nom de « système » : c'est
là que l'agent les retrouve, et c'est là qu'un échec se voit. La console, elle, aura
disparu au prochain redémarrage.

| Réglage | Défaut | |
| --- | --- | --- |
| `BACKUP_AUTO` | `true` | à `false`, plus rien d'automatique |
| `BACKUP_EVERY_HOURS` | `24` | âge au-delà duquel on en refait une |
| `BACKUP_VERIFY_EVERY_DAYS` | `7` | à `0`, le contrôle de restauration est coupé |
| `BACKUP_KEEP` | `14` | plancher de trois, quoi qu'on mette |

Une sauvegarde de la base complète pèse environ 10 Mo et prend moins d'une seconde. Les fichiers vont dans `backups/`, ignoré par git : **ils portent les clés API de 38 000 domaines**. `BACKUP_SECRET` les chiffre, ce qui n'a de sens que si un fichier quitte la machine. Une restauration prend d'abord une sauvegarde de l'état courant, et refuse un fichier incomplet.

### Premier démarrage

Sans aucun compte en base, l'application en crée un :

- si `ADMIN_PASSWORD_HASH` est présent dans `.env`, **votre compte historique est repris à l'identique** (même identifiant, même mot de passe) ;
- sinon, un mot de passe aléatoire est généré et **affiché une seule fois** dans la console, à changer à la première connexion.

### Rôles fournis d'origine

| Rôle | Droits |
|---|---|
| **Administrateur** | tout, y compris la gestion des comptes et des rôles |
| **Opérateur** | consulter, verrouiller/déverrouiller, réparer les droits, gérer les fichiers |
| **Éditeur** | consulter et modifier les fichiers (ni suppression, ni verrouillage) |
| **Lecteur** | consultation et téléchargement uniquement |

Ces quatre rôles sont resynchronisés à chaque démarrage : ils ne sont pas modifiables. En revanche, vous créez autant de **rôles personnalisés** que nécessaire, en cochant les permissions voulues.

### Les dix permissions

| Groupe | Permission | Ce qu'elle autorise |
|---|---|---|
| Serveurs | `servers.connect` | ouvrir et fermer les sessions SSH |
| Domaines | `domains.read` · `domains.create` · `domains.delete` | consulter · créer · supprimer |
| Domaines | `domains.lock` · `domains.fix_perms` | verrouiller/déverrouiller · réparer les droits |
| Fichiers | `files.read` · `files.write` · `files.delete` | explorer et télécharger · modifier, envoyer, compresser · supprimer |
| Administration | `users.manage` | gérer les comptes et les rôles |

**Portée par serveur** : chaque compte voit soit tous les serveurs, soit une liste choisie. Un compte limité à VPS 003 ne voit que celui-ci, et toute requête visant un autre serveur est refusée.

### Sécurité des comptes

- Mots de passe hachés en **scrypt**, jamais renvoyés par l'API ; longueur minimale configurable (12 par défaut).
- **Verrouillage temporaire** du compte après 10 échecs, pendant 15 minutes, en plus de la limite par adresse IP.
- **Sessions stockées en base et révocables** : désactiver un compte, changer son rôle ou réinitialiser son mot de passe ferme ses sessions immédiatement, sans attendre l'expiration.
- Les droits sont **rechargés à chaque requête** : un changement de rôle s'applique sans reconnexion.
- Garde-fous : impossible de supprimer ou désactiver le dernier administrateur actif, ni son propre compte, ni son propre rôle.
- Toute action d'administration est tracée dans `logs/audit.log`.

### En ligne de commande (porte de secours)

Si plus personne ne peut se connecter :

```powershell
npm run user list                       # comptes, rôles, portées
npm run user roles                      # rôles et permissions
npm run user add marie operator         # crée un compte (mot de passe affiché)
npm run user passwd marie               # réinitialise un mot de passe
npm run user role marie admin           # change le rôle
npm run user disable marie              # désactive / enable pour réactiver
```

---

## 6. Éditeur de design et de contenu

Il s'ouvre depuis l'icône palette d'une ligne de domaine, ou depuis le panneau de détails.

### Le moteur des sites, en bref

Les sites du parc partagent un moteur PHP commun : **26 330 sites** sur les quatre VPS « Racing » (Tiers1 utilise un autre modèle et n'est pas concerné). Chaque site se résume à :

- `config.php` — 14 variables : identité, présets d'en-tête, de pied de page et d'articles, rubriques, liste des blocs de la page d'accueil et leurs contenus ;
- `style.css` — 9 variables CSS, soit toute la charte graphique ;
- `parts/sections/` — une bibliothèque de **53 modèles de blocs**, répartis en 9 familles (bannière, rubriques, liste d'articles, texte + image, chiffres clés, témoignages, appel à l'action, questions fréquentes, newsletter) ;
- `parts/lang.php` — un dictionnaire unique FR, UK, ES, IT, DE, NL, PT, choisi par `$site_lang`.

L'éditeur agit exactement sur ces points, sans jamais toucher au moteur.

### Ce que l'utilisateur peut faire

| Onglet | Contenu |
|---|---|
| **Page d'accueil** | ordonner, ajouter et retirer les blocs ; choisir la disposition de chaque bloc ; saisir tous les textes, images, boutons, listes (chiffres, témoignages, questions) ; import d'images depuis le poste ; description pour les moteurs de recherche |
| **Couleurs** | les 9 couleurs de la charte, avec aperçu immédiat |
| **Identité** | nom, slogan, émoji, langue, présets d'en-tête, de pied de page, de rubriques et d'articles |
| **Articles** | compteurs par rubrique, recherche par titre ou par adresse, filtre par rubrique, puis édition du titre, du chapeau, de l'image, de l'auteur, de la date, et du corps de l'article, en mode visuel ou directement en HTML |
| **Sauvegardes** | restauration en un clic d'une version antérieure |

### L'écran « Page d'accueil »

L'écran est prévu pour un agent qui n'a pas de culture technique, et pour une prise en main sans formation.

- **La page se lit comme une page.** À gauche, les blocs dans l'ordre où le visiteur les verra : un schéma de la mise en page, le nom courant du bloc (« Bannière », « Appel à l'action ») et le début du texte réellement saisi, qui suit la frappe. Les flèches déplacent le bloc.
- **Un seul bloc à la fois.** Le bloc sélectionné s'ouvre à droite, ses champs regroupés dans un ordre constant : contenu, visuel, boutons, éléments. Fini l'empilement de tous les blocs dépliés.
- **Aucun nom de gabarit.** Les 53 modèles du parc sont présentés par leur forme : un schéma et un intitulé en langage courant (« Texte à gauche, image à droite », « Bandeau pleine largeur · dégradé »). Un test vérifie qu'aucun modèle n'échappe à cette traduction, dans les six langues.
- **Aucune balise à l'écran.** Un texte mis en valeur s'affiche en italique, en gras ou en couleur, avec trois boutons **B**, **I** et **A** ; le HTML reste dans le fichier, jamais dans le champ.
- **Couleur d'un mot, en direct.** On sélectionne le texte, on ouvre **A** : les neuf couleurs de la charte du site viennent en premier, puis des neutres, puis un sélecteur et un champ de code (`#c81e4a` ou `rgb(200, 30, 74)`). La couleur s'applique au moment du choix, et « Retirer les couleurs de ce champ » revient en arrière. L'outil est le même dans les blocs, dans les listes (témoignages, questions, chiffres) et dans le corps d'un article — où il ne colore que la sélection, jamais tout le texte par mégarde.
- **Deux façons de voir le même contenu.** Un commutateur **Visuel / Texte** est posé sur chaque champ mis en forme et sur le corps des articles. « Visuel » montre le résultat, « Texte » montre le code HTML — une balise de bloc par ligne pour un article. Le passage d'un mode à l'autre repasse par le même filtre que l'enregistrement : ce qui est affiché est exactement ce qui sera écrit, et regarder le code sans y toucher ne marque pas le brouillon comme modifié. Une balise que le site ne sait pas rendre, saisie en mode texte, disparaît au retour en visuel — son texte, lui, est conservé.
- **Rien à penser à enregistrer.** Chaque modification part en brouillon toute seule après deux secondes ; la barre d'action, toujours visible, indique l'heure du dernier enregistrement et rappelle que rien n'est en ligne avant « Publier ». Le bouton d'enregistrement manuel reste disponible.
- **Le seul réglage technique**, la description pour les moteurs de recherche, est rangé à part sous « Référencement ».

### Images du site

Le moteur du parc n'affiche jamais le fichier d'origine : il ne connaît que des déclinaisons `<identifiant>-<largeur>.<extension>`, en **400, 600, 900 et 1920 pixels**, chacune en **WebP et en JPEG** — huit fichiers par image, indexés dans `images/manifest.json`.

Le sélecteur d'images propose donc, à côté des images déjà présentes, un bouton **Importer une image** : l'agent dépose un JPEG, un PNG, un WebP ou un GIF, et les huit déclinaisons sont fabriquées **sur le serveur du site**, par son propre PHP (GD), aux dimensions et à la qualité relevées sur le parc. L'identifiant reprend le nom du fichier déposé, ramené à la forme du parc (`Ma Photo Été.JPG` → `ma-photo-ete`) et décliné en `-2`, `-3`… s'il est déjà pris. Aucune image n'est agrandie : une source large de 900 pixels donne huit fichiers dont le plus grand fait 900 pixels.

Le format est reconnu aux **premiers octets**, jamais à l'extension : un script renommé en `.jpg` est refusé avant d'atteindre le serveur. Sur un domaine verrouillé, le bouton est désactivé.

### L'onglet « Articles »

#### Le nom des images importées

Une image importée depuis le poste s'appelle « IMG_4821.jpg » ou « sans-titre (3).png » :
un nom qui ne dit rien de l'article et qui se ressemble d'un site à l'autre. Quand
l'import part **depuis un article ouvert**, l'image prend donc le nom de l'article, et le
moteur en tire ses quatre largeurs :

```
bien-etre/transformez-votre-bien-etre-grace-a-la-magie-de-la-pleine-conscience.php
   ↓
images/transformez-votre-bien-etre-grace-a-la-magie-de-la-pleine-conscience-400.webp
images/…-600.webp   images/…-900.webp   images/…-1920.webp      (et les .jpg)
```

Le nom est annoncé **avant** l'import, dans la fenêtre de choix : l'agent ne découvre pas
après coup que son fichier a été renommé.

**Rien n'est jamais écrasé.** Un article qui a déjà son image en reçoit une seconde sous
`<article>-2`, puis `-3` — les largeurs valent 400, 600, 900 et 1920, un `-2` ne peut donc
pas se confondre avec elles. L'annonce compte ce suffixe, pour que l'agent ne croie pas
avoir remplacé l'image d'origine.

**C'est le serveur qui décide du nom**, et il vérifie que l'article demandé est bien un
article de ce site : sans cela, n'importe quelle chaîne dicterait le nom des fichiers
écrits. Un article inconnu fait simplement retomber sur le nom du fichier importé.

Sans article ouvert — une image de page d'accueil, par exemple — le nom vient du fichier,
comme avant. Relevé sur `biozenz.fr` : **28 des 36 images du site portaient déjà le nom
d'un article**, à la main. Le geste était donc déjà la règle ; il est désormais fait tout
seul.

#### La barre d'outils de l'article

Le corps de l'article s'écrit dans une zone visuelle, avec les gestes qu'on attend d'un
éditeur :

| Groupe | Outils |
|---|---|
| Blocs | Paragraphe, Titre de partie (`h2`), Sous-titre (`h3`) |
| Caractère | Gras, Italique, Couleur du texte (palette du site) |
| Listes | Liste à puces, Liste numérotée, Citation |
| Alignement | Gauche, Centre, Droite |
| Liens | Insérer / modifier, Retirer |

Les boutons **s'allument selon l'endroit du curseur** : l'agent voit s'il est dans une
liste ou dans du gras sans avoir à deviner.

Le lien s'ouvre dans un panneau posé au ras du texte choisi, à la place de la fenêtre
`prompt()` d'avant : l'adresse en place y est reprise, Entrée valide, Échap referme, et
un bouton retire le lien sans toucher au texte. Une adresse refusée par `safeUrl` — tout
ce qui n'est ni `https://` ni un chemin commençant par `/` — est signalée, pas écrite.

**L'alignement est la seule mise en forme de bloc qui survit au nettoyage**, et seulement
avec `center`, `right` ou `justify` : `left` est déjà la valeur du site, l'écrire
n'apporterait rien. Tout le reste de l'attribut `style` part — un article collé depuis un
traitement de texte arrive avec des styles qui déformeraient la page, et le site a sa
propre typographie. C'est la seule porte laissée ouverte sur `style`, et elle ne laisse
passer que ces trois mots.

Le serveur reste le dernier filet : `validateArticleContent` refuse le PHP, les scripts,
les `<iframe>` et tout attribut `on…=`, quoi que le navigateur ait laissé écrire.

- **Les articles sont cherchés là où ils sont.** Le fichier `permalinks.php` donne l'adresse publique de chaque article, mais **il est vide sur une partie du parc** (15 sites sur 200 relevés sur le VPS 003) : l'éditeur parcourt donc aussi les dossiers de rubriques, et ne retient que les fichiers portant le bloc `$article_meta` du moteur. Sur un site où l'onglet annonçait « aucun article », il en liste 80.
- **Compteurs en tête de liste.** Le total du domaine et la répartition par rubrique (« Services 21 », « Formation 17 »…). Chaque compteur est aussi un filtre : un clic n'affiche que cette rubrique.
- **Une seule recherche pour deux usages.** Le champ cherche à la fois dans le **titre** et dans l'**adresse** du fichier, ce qui couvre la recherche par titre et par slug sans multiplier les champs.
- **Un incident ne bloque pas l'onglet.** Les titres sont un confort de recherche : si leur chargement s'interrompt — une session SSH qui tombe, par exemple — la liste reste utilisable et l'indicateur devient un bouton « reprendre », qui repart là où il s'était arrêté. Aucun message d'erreur ne s'interpose.
- **Les titres arrivent par paquets de soixante.** Les connaître demande d'ouvrir chaque article sur le serveur : la liste s'affiche immédiatement, les titres la complètent ensuite, et un discret « titres 60/80 » dit où en est le chargement. La recherche par titre couvre donc tout le site, pas seulement le premier écran.
- **Rien n'est rechargé.** Changer de filtre ou recevoir un paquet de titres ne redessine que la liste et les compteurs : le curseur ne quitte jamais le champ de recherche.

### Les deux temps : brouillon et publication

**Prévisualiser** rend la page telle qu'elle serait publiée, **sans rien écrire dans le site** : le moteur est recopié dans un dossier temporaire du serveur, la page y est produite avec le brouillon, le dossier est supprimé aussitôt, et le résultat est servi par le back-office. Conséquences utiles : cela fonctionne même sur un **domaine verrouillé**, aucun brouillon n'est exposé au public, et rien n'est à nettoyer. La page s'ouvre **dans l'application**, dans une fenêtre avec bascule ordinateur / mobile (un onglet séparé reste possible, via le bouton dédié). Elle affiche un bandeau permanent, ses scripts sont retirés, ses polices sont embarquées dans la page — sinon le navigateur les refuserait, la prévisualisation n'étant pas servie par le domaine — et elle est interdite d'indexation. Le lien est valable 20 minutes.

**Publier** écrit pour de bon, en quatre temps : sauvegarde horodatée du fichier existant → contrôle de syntaxe PHP du fichier candidat → écriture sur place (propriétaire, droits et ACL conservés) → **relecture de contrôle**. Si la relecture ne correspond pas exactement à ce qui était demandé, la sauvegarde est restaurée automatiquement et la publication est déclarée en échec.

Un brouillon vit dans la base du back-office, pas sur le serveur. Il mémorise l'empreinte du fichier d'origine : si quelqu'un modifie le site entre-temps, la publication est refusée plutôt que d'écraser son travail.

> **Publier exige un domaine déverrouillé.** Sur un domaine verrouillé, l'éditeur affiche un bandeau et désactive le bouton ; la prévisualisation, elle, reste disponible.

> **Après publication**, les fichiers sont à jour immédiatement, mais la page publique peut mettre quelques minutes à changer : le vhost applique un micro-cache de 5 minutes et Cloudflare une heure. Le message de confirmation fournit un lien qui contourne ces caches.

### Garde-fous

- **Les textes sont filtrés avant écriture.** Les gabarits du parc affichent les valeurs de `config.php` sans échappement : tout ce que le back-office y écrit est du HTML servi aux visiteurs. Chaque champ est donc filtré selon son contexte — mise en valeur, couleur et lien dans le corps de la page ; texte brut partout où la valeur finit dans un attribut (`alt`, `<title>`, description pour les moteurs) ; adresses refusées si elles peuvent exécuter du code (`javascript:`, `data:`). Le filtre ne recopie jamais une balise reçue : il la reconstruit à partir de son seul attribut utile, ce qui exclut `onerror` et consorts. La mise en forme déjà présente dans le parc — `<em>`, `<b>`, `<br>` et les liens sortants — est préservée à l'identique.
- Les couleurs de la charte n'acceptent que des valeurs hexadécimales ; les couleurs de texte sont ramenées à `#rrggbb` avant d'être écrites.
- Un bloc ne peut être choisi que s'il est **réellement installé** sur ce site.
- Le corps d'un article refuse `<script>`, le code PHP, les gestionnaires d'événements et la marque de fin du bloc de texte.
- Les valeurs de présets et la langue sont vérifiées contre la liste que le moteur sait rendre.
- Toute variable inconnue présente dans un `config.php` existant est **recopiée telle quelle** : l'éditeur n'appauvrit jamais un fichier.
- L'article est modifié **par positions d'octets**, celles que PHP calcule, et non par positions de caractères : un texte riche en apostrophes typographiques ou en accents se découpe au bon endroit. Un fichier candidat mal formé serait de toute façon refusé par `php -l` avant écriture.
- Une publication **ne touche que ce que l'agent a changé** : les métadonnées sont réécrites dans l'ordre du fichier d'origine, et un champ vide que le fichier n'avait pas n'est jamais ajouté. Republier sans rien modifier rend le fichier à l'octet près ; changer une image ne modifie qu'une ligne.
- La prévisualisation d'un article le rend **depuis le dossier de sa rubrique** : certaines versions du moteur déduisent la rubrique du nom du dossier, et un dossier technique faisait perdre le fil d'Ariane et les liens de rubrique.

### Droits

Trois permissions distinctes : `design.read` (consulter), `design.edit` (brouillon et prévisualisation), `design.publish` (mise en ligne). Le rôle **Rédacteur** en tire parti : il prépare et prévisualise, mais ne publie pas.

---

## 6 bis. Le journal d'audit

Toute action qui écrit laisse une trace : **qui**, **quoi**, **sur quoi**, **quand**, et
**avec quel résultat**. Elle s'écrit à deux endroits, volontairement :

| Destination | Rôle |
|---|---|
| `logs/audit.log` (JSON Lines) | La trace brute, ajoutée ligne à ligne, lisible avec n'importe quel outil, qui survit à une remise à zéro de la base |
| La table `audit_events` | La seule forme qu'on puisse filtrer, chercher et paginer — c'est elle que lit l'écran |

### L'auteur, qui manquait

Le journal existait déjà, mais il notait l'auteur dans `req.session.user` — un champ qui
n'existe pas : la session ne garde qu'un `userId`. **446 des 703 premières lignes sont
donc anonymes** (63 %). Un journal d'audit sans auteur ne répond pas à la question qu'on
lui pose. L'auteur est désormais lu dans `req.user`, que le middleware charge depuis la
base à chaque requête.

Le nom, le nom d'affichage et le rôle sont **recopiés au moment des faits**, et la table
ne porte **aucune clé étrangère** vers `users`. Deux conséquences voulues : effacer un
compte n'efface pas ses traces, et une ligne dit quel rôle son auteur avait *alors*, même
s'il en a changé depuis.

### L'écran

Troisième onglet de l'**Administration**, derrière une permission distincte,
`audit.read` : superviser ce que font les autres n'oblige pas à pouvoir créer des
comptes, et l'inverse est vrai aussi.

L'écran s'adresse à quelqu'un qui cherche une chose précise — « qu'est-ce qui s'est passé
sur ce domaine hier ? » — et non à quelqu'un qui lit du début à la fin :

- **une recherche libre** qui balaie l'auteur, le domaine, l'action et la cible, sans
  avoir à choisir la colonne ;
- **des raccourcis de période** (aujourd'hui, 7 jours, 30 jours) avant les dates exactes,
  parce que c'est ce qu'on demande neuf fois sur dix ;
- **des listes qui ne proposent que ce qui figure vraiment au journal**, avec leur
  nombre : « Anna Dupont (12) ». Un filtre qui ne rendrait rien ne s'affiche pas.

Chaque action porte une couleur tirée de son nom, jamais déclarée à côté — une action
ajoutée demain se range sans qu'on y pense :

| Couleur | Famille | Exemples |
|---|---|---|
| 🟢 Vert | Création | `user.create`, `categories.add`, `file.upload` |
| 🟠 Orange | Modification | `file.save`, `design.publish`, `translate.apply` |
| 🔴 Rouge | Suppression | `user.delete`, `categories.remove`, `rm` |
| 🔵 Bleu | Connexion | `login`, `logout`, `connect` |
| ⚪ Gris | Consultation | `file.download`, `design.preview` |

« Supprimer » est reconnu **en premier** : une action qui supprime ne doit jamais finir en
vert par accident. Et `unlock` ne se confond pas avec `lock`.

### Ce qui tient l'écran à l'échelle

Le filtrage et la pagination se font **en base**, jamais dans le navigateur : l'écran reste
le même à dix mille lignes. La taille de page est bornée à 200, une page hors bornes se
replie sur la dernière au lieu de rendre du vide, et les jokers de `LIKE` sont neutralisés
— chercher « 100 % » ne rend pas tout le journal.

Il n'existe **aucune route d'effacement** : un journal qu'on peut vider depuis l'interface
ne prouve plus rien. La purge se fait par ancienneté, au démarrage, selon
`AUDIT_RETENTION_DAYS` (180 jours par défaut, 0 pour ne rien effacer). Le fichier, lui,
n'est jamais purgé.

Éprouvé de bout en bout sur une copie jetable de la base : connexion, création de compte,
renommage, réinitialisation de mot de passe, suppression, ouverture de session serveur et
une création de domaine refusée. Les dix événements portent tous leur auteur, les cinq
familles tombent juste, l'échec est distingué de la réussite, et les six filtres rendent
le compte attendu.

---

## 6 ter. Le journal en fichier tourne

`logs/audit.log` grossissait sans fin. Un journal qui remplit le disque fait tomber ce
qu'il observe — la panne la plus bête qui soit, puisqu'elle vient de l'outil censé aider
à comprendre les autres.

Il tourne désormais : `audit.log` → `.1` → `.2`… jusqu'à `AUDIT_LOG_KEEP` générations de
`AUDIT_LOG_MAX_MB` mégaoctets (cinq fois cinq par défaut). On garde donc toujours la même
quantité de passé, quelle que soit l'activité.

Deux détails qui ne vont pas de soi :

- **On tourne AVANT d'écrire**, jamais après : une ligne ne doit pas se retrouver coupée
  entre deux fichiers, sinon le journal n'est plus relisible ligne à ligne par aucun
  outil. Conséquence voulue : un fichier reste légèrement *sous* la limite.
- **L'écriture est synchrone.** L'écriture différée paraissait plus prudente, mais elle
  rendait la rotation fausse : le renommage arrivait pendant que des lignes étaient
  encore en vol. Sous Windows le renommage échouait (EPERM) ; ailleurs les lignes
  atterrissaient dans le fichier déjà mis de côté. Mesuré : un journal à 2 000 octets
  pour une limite de 1 000. Écrire sur place coûte quelques microsecondes, à comparer au
  demi-seconde d'un aller-retour SSH que l'action vient de payer.

La taille est suivie en mémoire, lue une seule fois à l'ouverture : interroger le
système de fichiers à chaque événement coûterait plus cher que l'écriture elle-même.

---

## 7. État actuel des droits SSH (relevé le 15/09/2026)

| Serveur | Domaines | Réparer les droits | Créer | Supprimer |
|---|---|---|---|---|
| VPS 001 | 7 859 | ✅ sudo fixdroits | ❌ pas de sudo add-site | ⛔ non configuré |
| VPS 002 | 6 006 | ❌ aucun sudo | ❌ | ⛔ |
| VPS 003 | 7 910 | ❌ aucun sudo | ❌ | ⛔ |
| VPS 004 | 5 179 | ✅ sudo fixdroits | ❌ | ⛔ |
| Tiers1 | 1 838 | ✅ sudo fixdroits | ⛔ (pas de add-site, modèle « à plat ») | ⛔ |

La colonne verrou/déverrou dépend de l'accès `lockop@<VPS>:2278` avec `LOCKOP_KEY_PATH`. Cet accès n'a pas encore été testé depuis l'application.

**Activer la création** : dans le conteneur `parc` de chaque VPS, en root :

```bash
echo 'tech ALL=(root) NOPASSWD: /usr/local/sbin/add-site' > /etc/sudoers.d/lkm-bo-add-site
chmod 440 /etc/sudoers.d/lkm-bo-add-site && visudo -c
```

Faites de même avec `fixdroits` sur VPS 002 et 003 pour y activer la réparation des droits.

**Activer la suppression** : il n'existe pas encore de script côté serveur. Un script de référence est fourni dans [`server-scripts/del-site`](server-scripts/del-site). C'est l'inverse de `add-site` : il refuse les sites verrouillés et déplace le dossier dans une **corbeille** (`/srv/.parc-trash`) au lieu de le détruire. **Relisez-le**, installez-le avec sa règle sudoers (instructions en tête du fichier), puis renseignez :

```json
"delete": "sudo -n /usr/local/sbin/del-site {domain} --reload"
```

---

## 8. Multilingue de l'interface (i18n)

- Une langue = un fichier `locales/<code>.json` (`fr`, `en`, `es`, `it`, `pt`, `de` fournis).
- **Ajouter une langue** : copiez `en.json` vers `nl.json`, traduisez les valeurs et renseignez `_meta.name`. Le fichier est pris en compte **à chaud**, sans redémarrage, et apparaît dans le sélecteur.
- Les mêmes fichiers servent à l'interface et aux **messages d'erreur de l'API**. Langue retenue : `?lang=` → en-tête `X-Lang` → `Accept-Language` → `DEFAULT_LANG`.
- Clés manquantes : repli sur la langue par défaut, puis sur l'anglais.

---

## 9. API REST

Toutes les routes `/api/*` (sauf i18n et login) exigent une session. Les requêtes modifiantes doivent porter l'en-tête `X-Requested-With: lkm-bo`.

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/health` | État de l'application — **sans authentification**, 200 ou 503 |
| `POST` | `/api/auth/login` · `/api/auth/logout` | Ouverture / fermeture de session |
| `GET` | `/api/auth/me` | Profil, rôle, permissions et portée du compte connecté |
| `POST` | `/api/auth/password` `{ current, password }` | Changement de son propre mot de passe |
| `GET` | `/api/admin/permissions` · `/api/admin/roles` · `/api/admin/users` | Catalogue, rôles, comptes (permission `users.manage`) |
| `POST`/`PATCH`/`DELETE` | `/api/admin/roles[/:id]` · `/api/admin/users[/:id]` | Gestion des rôles et des comptes |
| `POST` | `/api/admin/users/:id/password` | Réinitialisation d'un mot de passe |

Traitements de masse — `POST /api/domains/resolve { domains[] }` répartit une liste de domaines
entre les serveurs, et `GET /api/servers/:id/domain-names` donne les noms d'un serveur sans pagination.

Traduction des pages d'accueil, sous `/api/servers/:id/translation` :

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/status` | Traduction automatique disponible ou non, langues reconnues |
| `POST` | `/scan` `{ domains[] }` | Analyse un lot de domaines (lecture seule, 150 au maximum) |
| `POST` | `/translate` `{ texts[], from, to }` | Propositions de traduction (clé DeepL requise) |
| `POST` | `/apply` `{ domain, changes[] }` | Écrit les textes retenus (sauvegarde + vérification) |

Éditeur de design, sous `/api/servers/:id/domains/:domain/design` :

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/` | État publié, brouillon éventuel, blocs et images disponibles |
| `PUT` · `DELETE` | `/draft` | Enregistre ou abandonne le brouillon |
| `POST` | `/preview` `{ article? }` | Rend la prévisualisation (aucune écriture) |
| `GET` | `/preview/:id.html` | Sert la page prévisualisée |
| `POST` | `/publish` | Publie le brouillon (sauvegarde + vérification) |
| `GET` | `/articles` · `/article?path=` | Liste des articles · contenu d'un article |
| `PUT` | `/article/draft` | Brouillon d'article |
| `POST` | `/article/publish` | Publication d'un article |
| `GET` · `POST` | `/backups` · `/backups/restore` | Sauvegardes et restauration |
| `GET` | `/api/design/catalog` | Catalogue des familles de blocs et des présets |
| `GET` | `/api/i18n` · `/api/i18n/:lang` | Langues disponibles · dictionnaire |
| `GET` | `/api/servers` | Serveurs, état SSH, capacités |
| `POST` | `/api/servers/:id/connect` · `/disconnect` | Ouvre / ferme la session SSH |
| `GET` | `/api/servers/:id/domains?q=&status=&sort=&page=&size=&refresh=1` | **Read** — liste paginée |
| `GET` | `/api/servers/:id/domains/:domain` | **Read** — détails |
| `POST` | `/api/servers/:id/domains` `{ "domain": "exemple.com" }` | **Create** |
| `PATCH` | `/api/servers/:id/domains/:domain` `{ "action": "lock" \| "unlock" \| "fixPerms" }` | **Update** |
| `DELETE` | `/api/servers/:id/domains/:domain` `{ "confirm": "exemple.com" }` | **Delete** |
| `GET` | `/api/domains?q=…` | Vue agrégée de tous les serveurs connectés |

Gestionnaire de fichiers, sous `/api/servers/:id/domains/:domain/files` :

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/?path=` | Contenu d'un dossier |
| `GET` | `/read?path=` | Contenu d'un fichier texte |
| `PUT` | `/content` `{ path, content, expectMtime }` | Enregistrement (refus si le fichier a changé) |
| `POST` | `/rename` · `/mkdir` · `/new-file` | Renommage · nouveau dossier · nouveau fichier |
| `POST` | `/upload?path=&name=&extract=1` | Téléversement (corps binaire brut, sans multipart) |
| `POST` | `/compress` `{ path, names[], archive }` | Création d'une archive `.zip` |
| `POST` | `/extract` `{ path, dest }` | Décompression d'une archive |
| `DELETE` | `/` `{ paths[] }` | Suppression |
| `GET` | `/download?path=` | Téléchargement d'un fichier |
| `POST` | `/download` `{ path, names[] }` | Téléchargement d'une sélection en `.zip` |

Erreurs : `{ "error": { "key": "errors.ssh_auth_failed", "message": "<traduit>", "detail": "<stderr éventuel>" } }`.

Chaque route SSH vérifie qu'une connexion active existe (sinon `409 errors.ssh_not_connected`). Chaque action est tracée dans `logs/audit.log` au format JSON Lines.

---

## 10. Sécurité

- **Injection shell** : validation stricte des domaines (`[a-z0-9.-]`, même règle que `add-site`), quoting POSIX systématique de toute valeur insérée dans une commande, modèles de commandes issus de la seule configuration.
- **SSH** : secrets lus depuis `.env` au moment de la connexion, épinglage des clés d'hôte, keepalive, fermeture automatique après 15 min d'inactivité (`SSH_IDLE_TIMEOUT_MS`), timeouts de commande, 4 canaux parallèles maximum par serveur, fermeture propre des sessions à l'arrêt (Ctrl+C).
- **Session tombée** : une coupure réseau ou la fermeture pour inactivité n'oblige pas à se reconnecter à la main. La session est rouverte **au moment d'ouvrir le canal**, c'est-à-dire avant que la commande ne démarre : la relancer ne peut donc rien exécuter deux fois. Une coupure survenue *pendant* une commande remonte telle quelle, et une session fermée par l'utilisateur n'est jamais rouverte toute seule.
- **Web** : écoute sur `127.0.0.1` par défaut, mot de passe hashé (scrypt), session régénérée à la connexion, cookie `HttpOnly` + `SameSite=Strict`, anti-CSRF, 10 tentatives de connexion par 15 min, CSP stricte (aucun script inline, aucune feuille de style extérieure), rendu DOM sans `innerHTML`. L'éditeur colorant du texte, seuls les **attributs** `style` sont autorisés (`style-src-attr`) : une couleur choisie ne peut vivre ailleurs, et cette ouverture ne permet aucun script.
- **Suppression** : confirmation par saisie du nom, refus si le domaine est verrouillé.
- **Traçabilité** : toute action qui écrit est journalisée avec son auteur, dans un fichier et en base. Le journal se lit derrière la permission `audit.read` et ne s'efface pas depuis l'interface.

Pour exposer l'outil au-delà du poste local, placez-le derrière un reverse-proxy HTTPS, avec `SECURE_COOKIES=true` et un filtrage IP.

---

## 11. Structure

```
src/
  server.js                 Express : sécurité, sessions, routes
  config.js                 .env + config/servers.json (héritage "defaults")
  i18n.js                   chargement / rechargement à chaud des langues
  ssh/SshManager.js         connexions ssh2 (clé, mot de passe, agent), exec, timeouts
  ssh/knownHosts.js         épinglage des empreintes d'hôte
  ssh/shell.js              validation des domaines + quoting anti-injection
  auth/permissions.js       catalogue des permissions et rôles d'origine
  auth/authService.js       authentification, verrouillage, amorçage du 1er compte
  db/mysql.js               accès MySQL : groupe de connexions, requêtes, transactions
  db/mysqlSchema.js         schéma et migrations (seul fichier lié au moteur)
  db/repositories.js        comptes et rôles, règles métier
  db/audit.js               journal : qui a fait quoi, quand, avec quel résultat
  db/phrases.js             dictionnaire d'expressions ajouté par les agents
  services/dbBackup.js      sauvegarde par mysqldump, rotation, chiffrement
  db/sessionStore.js        sessions en base, révocables à chaud
  db/drafts.js              brouillons de design et de contenu
  services/siteCatalog.js   familles de blocs, présets, validation
  services/siteService.js   lecture, brouillon, prévisualisation, publication
  services/siteDriver.js    commandes serveur (rendu temporaire, sauvegardes)
  services/translationService.js  analyse de langue du parc, propositions, application
  services/langTools.js     langues du parc, dictionnaire d'expressions, DeepL
  services/phpScripts.js    scripts PHP exécutés par le moteur du site lui-même
  services/phpWriter.js     génération de config.php, style.css et articles
  services/parcDriver.js    commandes & parsing propres au modèle « parc »
  services/domainService.js CRUD, cache, pagination, capacités sudo
  services/fsDriver.js      commandes fichiers + garde-fous anti-évasion de chemin
  services/fileService.js   explorateur, édition, archives, téléchargements
  util/zip.js · util/tar.js formats ZIP et TAR en pur Node (aucun binaire requis)
  routes/                   auth, i18n, servers (CRUD), domains (agrégé), files, design, translation
  styles/tailwind.css       thème Tailwind (#7bc9a9 · #182433 · #ffffff)
public/                     index.html + js/ (app, design, actions, translate, files, ui, api, i18n) + css/app.css (généré)
locales/                    fr, en, es, it, pt, de
scripts/                    set-password, check-ssh
tests/                      tests unitaires (npm test) : configuration, chemins, archives, i18n
server-scripts/del-site     script serveur de référence pour la suppression
server-scripts/traduire-homepage.sh  même travail en ligne de commande (voir § 13)
```

## 10 bis. Redirections 301 — pourquoi un fichier, et pas `.htaccess`

**Les cinq machines du parc tournent sous nginx.** Il ne lit jamais `.htaccess` : les
règles `Redirect 301` qui y étaient écrites n'ont **jamais rien fait**, et rien ne le
disait à l'agent, qui voyait son geste confirmé.

Trois tentatives ont été mesurées avant de trouver la bonne :

| Tentative | Résultat |
| --- | --- |
| `.htaccess` | **ignoré** |
| Bloc en tête de `404.php` | en-tête `Location` posée… mais **statut 404** |
| **Fichier `.php` à l'ancienne adresse** | **301 Moved Permanently** |

La deuxième a échoué pour une raison précise : le vhost partagé écrit
`error_page 404 /404.php` **sans le signe `=`**, ce qui force nginx à conserver le code
404. Un navigateur **ignore** une redirection posée sur un 404.

Le mécanisme retenu dépose, à l'ancienne adresse, un petit fichier PHP qui ne fait que
rediriger. Comme ce fichier **existe**, nginx le sert comme une page normale — et PHP y
impose son propre code.

### Les garde-fous

- **Une vraie page n'est jamais écrasée.** Si l'adresse est déjà occupée par une page du
  site, l'état renvoyé est `exists` et rien n'est écrit. Nos fichiers se reconnaissent à
  une marque ; tout autre contenu est laissé intact.
- **Seules les adresses en `.php`** sont acceptées (`unsupported` sinon) : nginx servirait
  tout autre fichier **en clair**, code source compris.
- Sauvegarde avant écriture dans `.lkm-backups/`, puis **relecture** : c'est le fichier
  relu qui fait foi, jamais l'intention.
- Le registre `.lkm-redirects.json` est **reconstruit depuis les fichiers réellement
  présents**. Un registre qui annoncerait une redirection disparue ferait croire une
  adresse couverte alors qu'elle rend 404.
- Registre et sauvegardes commencent par un point : nginx refuse ces chemins
  (vérifié : **403**).

### Un détail qui coûte cher

Les fichiers posés sont en **0644**, et c'est nécessaire : PHP tourne sous le compte **du
site**, qui n'appartient qu'à son propre groupe — ni `www-data`, ni `editors`. En 0640,
un fichier créé par le compte SSH lui serait totalement inaccessible, et la redirection
ne partirait jamais. Ce n'est pas une ouverture : le dossier parent interdit `other`
(mode 2770), donc aucun autre compte du serveur n'y accède.

### Rediriger vers un AUTRE domaine

Un article déménagé d'un de vos sites vers un autre est courant. Une destination
complète est donc acceptée — `https://autre-site.fr/article.php` — **à condition que le
domaine visé soit hébergé sur la même machine**. `http` y devient `https`, puisque le
parc y redirige de toute façon.

Vers un domaine **inconnu du parc**, l'état renvoyé est `hors du parc` et rien n'est
écrit : une redirection ouverte ferait de chaque site un tremplin d'hameçonnage — un
lien portant le nom d'un de vos domaines, et le visiteur atterrit ailleurs. Il faut
cocher **« autoriser »** pour passer outre.

De même, rediriger une page **en ligne** demande de cocher **« remplacer »** : la page
disparaîtrait du site, et ce n'est pas la même chose que réparer une adresse morte.
L'ancienne page est sauvegardée avant d'être remplacée.

### Le cache peut vous faire croire que rien ne marche

Cloudflare garde la réponse 404 jusqu'à **48 heures**. Une redirection fraîchement posée
peut donc sembler sans effet. Ajoutez `?test=1` à l'adresse pour contourner le cache et
voir la vérité immédiatement.

### À savoir

Un domaine **verrouillé** refuse toute écriture, redirection comprise — c'est le verrou du
parc qui fait son travail. Il faut le déverrouiller, poser la redirection, puis le
reverrouiller.

---

## 11 ter. Des jetons à la place des clés globales

La base portait **38 195 clés globales**. Une clé globale ouvre la *totalité* d'un compte
Cloudflare : la facturation, les membres de l'équipe, les Workers, la suppression de
zones, et jusqu'à la création d'autres clés. Le back-office, lui, a besoin de six
choses. Confier tout le compte pour faire cela, c'est laisser la clé de l'immeuble à qui
vient relever le compteur.

```bash
npm run cf -- token                         # l'état, sans rien écrire
npm run cf -- token <domaine> --yes         # un seul compte
npm run cf -- token --all --limit 20 --yes  # commencer doucement
```

| Ce qu'un jeton **peut** | Ce qu'une clé globale donnait **en plus** |
| --- | --- |
| lire une zone, la retrouver par son nom | la facturation et les abonnements |
| lire et changer ses réglages (SSL, HTTPS…) | les membres du compte et leurs droits |
| lire et écrire son DNS | la création et la suppression de zones |
| vider son cache | les Workers, R2, les tunnels |
| — | la création d'autres clés et jetons |

### L'ordre des gestes EST la garantie

1. **créer** le jeton, avec la clé globale — c'est le seul moment où elle sert ;
2. le **vérifier**, en interrogeant Cloudflare *avec lui* : un jeton créé mais inactif
   existe, et on ne le saurait qu'au premier usage, en production ;
3. l'**enregistrer** — sa valeur n'est montrée qu'une fois, la perdre oblige à recommencer ;
4. alors seulement, **effacer la clé**.

Inverser 2 et 4 laisserait le domaine injoignable au premier pépin. Si la vérification
échoue, le jeton bancal est révoqué et **la clé n'est pas touchée**.

La clé globale reste valable *chez Cloudflare* : ce qui change, c'est que **notre base ne
la porte plus**. En cas de besoin, `npm run cf -- import dataCF.csv --yes` la remet.
`--keep-key` permet de garder les deux le temps de prendre confiance — mais l'exposition
reste alors inchangée.

### Options

`--ip=203.0.113.7` limite le jeton à une adresse : la protection la plus forte, et la
plus fragile — elle se brise le jour où l'adresse change. `--expires-in-days=90` force la
rotation : bonne pratique, et piège d'exploitation si personne n'y pense. Ni l'une ni
l'autre par défaut.

Sur 38 195 comptes, la conversion passe par une **tournée** (`cloudflare.token`) : le
serveur la mène, elle reprend où elle s'arrête, et un compte qui résiste est noté sans
arrêter les autres — sa clé reste intacte.

---

## 11 bis. Les tournées : un traitement de masse confié au serveur

La boucle d'un traitement de masse vivait dans **l'onglet du navigateur** : il envoyait
les domaines par lots de cent. Fermer l'onglet, couper le Wi-Fi, et la tournée s'arrêtait
au milieu — sans que rien ne dise où elle en était. Sur 7 733 sites, ou sur les 37 930
domaines Cloudflare, c'était intenable.

Une tournée est désormais **menée par le serveur et écrite en base**. L'agent la lance,
ferme son navigateur, se déconnecte, revient le lendemain : elle a continué, et l'écran
la retrouve. Si le serveur redémarre en route, il **reprend au bon lot**.

### Ce qui rend la reprise possible

| | |
| --- | --- |
| La liste des cibles est **figée** au départ | une tournée d'une heure ne dépend pas de ce que l'écran avait en tête au moment du clic |
| Le découpage est **stable** | au redémarrage on refait le même, et on saute les lots déjà écrits |
| Le point de reprise se lit dans **ce qui est écrit** | le nombre de lots enregistrés, pas un compteur qui pourrait mentir après un arrêt brutal |
| Les totaux s'**additionnent** depuis les lots | le processus qui termine n'a pas vu ce qu'a fait celui qui avait commencé |

**Une seule tournée à la fois.** Deux balayages du parc en parallèle doubleraient la
charge SSH sur les mêmes machines, et les deux iraient deux fois moins vite.

**Un serveur qui tombe n'emporte pas les autres.** Une session SSH peut lâcher au milieu
d'une tournée de dix minutes : les lots de cette machine sont écrits **en échec, avec la
liste des domaines non traités**, et la tournée continue ailleurs. Un trou silencieux
serait pire que l'échec — l'agent ne saurait pas quels sites n'ont pas été vus.

**On peut l'arrêter**, et elle s'arrête *entre* deux lots : interrompre un lot en plein
travail laisserait des sites à moitié traités.

### Ce que l'agent voit

Un bandeau annonce la tournée en cours — son avancement, qui l'a lancée — avec un bouton
pour la suivre, et replie l'historique des dernières, qu'on peut rouvrir. Il disparaît
quand il n'a rien à dire. `job.start` et `job.finish` entrent au **journal d'audit** :
qui a lancé quoi, sur combien de sites, avec quel résultat.

### Cloudflare

Une opération sur plus de **200 domaines** devient une tournée. En dessous, la réponse
immédiate vaut mieux : vider le cache de trois sites et attendre deux secondes est plus
simple à comprendre. Au-dessus, une seule requête pour 37 930 domaines tiendrait une
heure et demie — le navigateur, le relais et la patience de l'agent abandonneraient bien
avant.

### API

| | | |
| --- | --- | --- |
| `POST` | `/api/jobs` | lance une tournée `{ kind, label, params, targets[] }` |
| `GET` | `/api/jobs` | l'historique `?kind= ?status= ?mine=1 ?limit=` |
| `GET` | `/api/jobs/:id` | l'état d'une tournée |
| `GET` | `/api/jobs/:id/results?after=` | ses résultats, lot par lot |
| `POST` | `/api/jobs/:id/cancel` | demande l'arrêt |

Le droit exigé est **celui du traitement**, pas un droit « tournée » générique : confier
un travail au serveur ne doit pas permettre de faire ce qu'on n'aurait pas le droit de
faire soi-même. Les tournées terminées partent avec leurs résultats au bout de
`JOB_RETENTION_DAYS` jours (30 par défaut).

**Ajouter un traitement**, c'est ajouter une entrée dans `src/services/jobKinds.js` —
le droit exigé, la taille du lot, et l'appel. Le reste appartient au moteur.

---

## 12. L'écran « Actions »

Les traitements de masse du parc vivent dans un écran unique, accessible depuis la barre
latérale. Un menu **Action** choisit le traitement — aujourd'hui *Traduction des pages
d'accueil*, demain les suivants : l'écran apporte ce qui leur est commun (choix des sites,
avancement, arrêt), chaque action ne rendant que ses propres résultats.

### Ajouter une action

L'écran ne connaît aucun traitement en particulier : il apporte ce qui leur est commun —
choisir l'action, choisir les sites, avancer par lots, montrer la progression, arrêter — et
chaque action fournit le reste. En ajouter une, c'est écrire un module et l'inscrire dans
`ACTIONS` ([public/js/actions.js](public/js/actions.js)).

| Ce que l'action fournit | Rôle |
|---|---|
| `key`, `icon`, `labelKey`, `hintKey` | Son entrée dans le menu déroulant |
| `run(serveur, domaines)` | Le travail, un lot à la fois |
| `stats()`, `results()`, `emptyState()` | Ce qu'elle affiche — l'écran ne décide de rien |
| `reset()`, `ready()`, `finished()` | Son cycle de vie |
| `form()` *(facultatif)* | Une carte de saisie **avant** le périmètre : les rubriques à créer, par exemple |
| `targets()` *(facultatif)* | Ses propres sites, quand la saisie les désigne déjà — le périmètre s'efface |
| `canRun()`, `startLabelKey` *(facultatifs)* | Garde et libellé du bouton de lancement |

### Choisir les sites

| Périmètre | Usage |
|---|---|
| **Tout le serveur** | La tournée de fond sur les milliers de sites d'un VPS. |
| **Tout le parc** | Tous les serveurs connectés, d'une traite. **Une pastille par serveur** permet d'en retenir un seul, ou de reprendre celui qui reste. Les serveurs hors ligne sont nommés : c'est la première raison pour qu'un domaine manque à l'appel. |
| **Liste de domaines** | Ceux qu'un agent colle depuis un tableur — un par ligne, ou séparés par des virgules ; les adresses complètes (`https://www.exemple.com/page.php`) sont acceptées. |

Une liste collée **peut mélanger les serveurs** : le back-office cherche chaque domaine dans
les listes déjà en cache (`POST /api/domains/resolve`), annonce « 2 · VPS 002 — 1 · VPS 001 »,
et nomme ceux qu'il ne trouve pas. Un serveur non connecté est signalé comme tel : c'est la
première raison pour laquelle un domaine bien réel reste introuvable.

### L'action « Traduction des pages d'accueil »

Sur le parc, quelques pour cent des pages d'accueil gardent un texte dans la langue du modèle
d'origine : un slogan français sur un site anglais, une question de FAQ oubliée.

1. **Analyser.** Lecture de la page d'accueil des sites retenus, par lots de 100, progression
   visible et interruptible. Rien n'est modifié.
2. **Relire.** Chaque texte est présenté avec son **emplacement en clair** — « Bannière — Titre »,
   « Questions fréquentes — Question 3 » — la langue détectée, et un champ de traduction déjà
   rempli quand le dictionnaire du parc connaît l'expression.
3. **Publier.** L'écriture emprunte le circuit de publication du site : sauvegarde horodatée dans
   `.lkm-backups`, contrôle `php -l`, écriture sur place, puis relecture de contrôle — un écart
   restaure la sauvegarde. Le site suivant s'ouvre automatiquement.

**Trois gestes de plus sur la fiche d'un site**

- **Verrouiller / déverrouiller** : un domaine verrouillé refuse toute écriture. L'état est lu à
  la sélection et les deux boutons sont dans l'en-tête, pour ne pas envoyer l'agent chercher
  l'écran des domaines au milieu de son travail.
- **Fichiers** : ouvre le gestionnaire de fichiers sur le domaine — images, articles,
  `config.php` du site en cours de correction. Le retour ramène à l'écran Actions **avec
  l'analyse intacte** : un relevé sur des milliers de sites ne doit pas disparaître parce
  qu'on est allé regarder un fichier.
- **Contrôle des balises** : la traduction doit porter les mêmes balises que l'original, et
  autour des mêmes mots. « Le hardware, cet `<em>`écosystème`</em>` fragile » rendu par
  « Hardware: That `<em>`Fragile Ecosystem`</em>` » garde bien la balise, mais elle est passée
  d'un mot à deux, dont l'adjectif qui était dehors : le site reste valide, la mise en valeur a
  changé de sens. Un avertissement le signale sous le champ, à la frappe.

**Ce qui protège le parc**

- Seuls trois champs sont modifiables : `site_tagline`, `header_cta_text` et le tableau `$homepage`.
  Une demande portant sur une rubrique, une adresse ou un préréglage est refusée, pas ignorée.
- Le texte d'origine accompagne chaque demande : s'il a changé sur le serveur entre l'analyse et la
  publication, il est **laissé intact** et l'agent en est averti.
- Aucune case n'est cochée d'office, sauf quand la traduction vient du dictionnaire. Un texte que
  l'analyse juge incertain — moins de cinq mots, ou écart faible entre deux langues — porte la
  mention « à vérifier ».
- L'analyse demande `design.read`, la publication `design.publish` : les mêmes droits que l'éditeur.

### L'action « Gérer les rubriques »

Reprise du script `ajout_categories.sh`, et répartie là où chaque écriture est la plus sûre.
Une rubrique du parc tient en **trois pièces**, et c'est la raison d'être de l'action : à la
main, il en manque toujours une.

| Pièce | Comment elle est écrite |
|---|---|
| La page `<rubrique>/index.php` | Script serveur — créée seulement si elle manque |
| L'entrée du menu dans `$categories` | **Le circuit de publication** : `config.php` est reconstruit, validé, sauvegardé, contrôlé par `php -l`, puis relu — et restauré tout seul en cas d'écart |
| La ligne de `wp_summary.json` | Script serveur, avec sauvegarde ; le reste du fichier est conservé |

L'ordre compte : **page d'abord, menu ensuite**. Un dossier sans entrée de menu ne dérange
personne ; l'inverse afficherait une rubrique qui mène à une page inexistante. Une rubrique déjà
en place n'est jamais réécrite — son nom, son icône et sa description sont l'œuvre de quelqu'un.

**L'écran, pour un agent non technique.** Trois étapes **numérotées**, et aucun mot de métier : on
parle de rubrique et d'adresse, jamais de dossier, de slug ni de configuration. Chaque bouton dit
ce qu'il fera **avant** qu'on le presse — « Aucune écriture : vous verrez d'abord, site par site,
ce qui sera créé » — et l'étape suivante porte son numéro, pour qu'on sache toujours où l'on est.

1. **Quelles rubriques ?** Les mêmes pour tous — l'agent tape « Sport », l'adresse `/sport/`
   s'affiche à côté — ou **un tableau collé** depuis un tableur, une ligne par site, quand chaque
   site a les siennes. Les domaines collés sont retrouvés sur tout le parc, et ceux qui manquent
   sont nommés.
2. **Quels sites ?** Le périmètre habituel. En mode tableau, il s'efface : les sites viennent du
   tableau.
3. **Vérifier**, puis **Créer**. La vérification est une lecture seule qui montre les trois pièces
   pour chaque rubrique — *déjà là* ou *à créer* — et la création demande confirmation, chiffres à
   l'appui. Relancer ne recrée rien.

**Importer un fichier.** En mode tableau, une zone de glisser-déposer accepte le CSV du tableur :
il est lu **dans le navigateur**, jamais envoyé. Séparateur virgule ou point-virgule, ligne
d'en-tête reconnue toute seule, et les champs entre guillemets restent entiers — « Cuisine,
recettes » compte pour une rubrique, pas deux. Le contenu lu remplit la zone de texte, que l'agent
peut encore corriger.

### Supprimer une rubrique

Le même écran, l'autre verbe.

**L'agent ne tape rien : il coche.** Dès que les sites sont choisis, l'écran lit les rubriques
réellement déclarées et les présente à cocher, avec leur adresse et le nombre d'articles qu'elles
portent. C'est ce qui rend la suppression utilisable sur des rubriques que personne n'a créées
depuis le back-office.

Sans cela, il fallait deviner le nom exact, et parfois aucun nom ne convenait. Relevé sur 600
sites du VPS 003 — **4 152 rubriques**, dont :

| Mesure | Nombre |
|---|---|
| Rubriques dont le nom affiché ne redonne pas la clé interne | **104** (1 sur 40) |
| Rubriques portant au moins un article | **3 885** (94 %) |
| Rubriques sans page `index.php` | 0 |

Le cas type : « Finance &amp; real estate » se range sous `finance-real-estate`. Un agent qui tape
le nom affiché produit `finance-amp-real-estate`, qui ne désigne rien — la suppression ne trouvait
rien à retirer et semblait sans effet. La clé lue sur le serveur **repart désormais telle quelle**,
sans repasser par la fabrication d'adresse ; le nom, lui, est affiché décodé, comme le visiteur le
voit. Une rubrique absente de la liste reste atteignable en la saisissant à la main.

**Les articles ne sont jamais touchés** : un dossier de rubrique en contient — sur le parc,
`hardware/` en porte sept — et leurs adresses publiques viennent de `permalinks.php`, pas du
dossier.

| Ce qui part | Ce qui reste |
|---|---|
| L'entrée du menu dans `$categories` | Les articles de la rubrique, à leur adresse |
| La page de la rubrique (`index.php`) | Le dossier, s'il contient encore quelque chose |
| La ligne de `wp_summary.json` | Le reste du fichier |

La vérification affiche, pour chaque rubrique, **combien d'articles sont en jeu**, et la fenêtre de
confirmation le répète : « 7 articles sont conservés : seule la page de la rubrique et son entrée de
menu disparaissent. » L'ordre est inversé par rapport à la création — **le menu part en premier**,
car une rubrique encore au menu dont la page a disparu donne un lien mort, visible de tous.

Éprouvé sur un site jetable, cycle complet : deux rubriques créées avec les bonnes adresses
(« Vie quotidienne » donne `/vie-quotidienne/`), puis supprimées avec une troisième qui n'existait
pas. **L'article a survécu**, le dossier vide a disparu, celui qui portait l'article est resté,
le résumé WordPress est à jour, ses autres clés intactes, `php -l` propre et une sauvegarde par
écriture.

Puis rejoué sur le cas difficile, reproduit à l'identique : un site portant « Finance &amp; real
estate » (6 articles), « Woman / fashion » (3), « Health » (2) et « Tourism » (vide). Les deux
premières cochées dans la liste, **11 articles sur 11 conservés**, la page de la rubrique retirée,
le dossier plein gardé, le dossier vide effacé, le résumé WordPress à jour et `php -l` propre.

### L'action « Redirections 301 »

Une page renvoie 404 ; l'agent saisit son adresse et celle où envoyer le visiteur. Le
back-office écrit la règle dans le `.htaccess` du site, **juste après la ligne de
repère du moteur** :

```
# Direct access to .php files redirects 301 to the old URL.

# >>> LKM-BO redirections 301
Redirect 301 /cystite-comprendre-les-causes.php /cystite-comprendre-les-causes
# <<< LKM-BO redirections 301
```

Le bloc délimité sépare ce que le back-office a écrit de ce qui était là avant : les
règles posées ailleurs dans le fichier sont **comptées et laissées intactes**, et le
tableau récapitulatif ne montre que les nôtres. Retirer la dernière règle efface le
bloc entier, ligne vide comprise — cinq cycles poser/retirer rendent un fichier
identique à l'octet près.

#### Ce que la mesure a dit avant d'écrire une ligne de code

| Mesure (VPS 003) | Résultat |
|---|---|
| Sites portant la ligne de repère, une seule fois | **395 / 400** |
| `.htaccess` modifiables par le compte SSH | **1 138 / 5 273** (21,6 %) |
| Taille médiane / maximale du fichier | 11,8 Ko / 99,1 Ko |
| `Redirect 301` déjà présents sur le parc | 12 sites, 21 règles |

Les 4 sites sur 5 non modifiables n'ont pas l'ACL `editors`. L'écran le dit avant
d'écrire, nomme les sites concernés et renvoie vers **« Réparer les droits »**
(`fixdroits`), qui réapplique les droits attendus.

#### Un résultat mesuré qu'il faut connaître

Les **12 `Redirect 301` déjà posés sur le parc renvoient tous 404**. Vérifié en direct,
domaine par domaine : `16secrets.com`, `bizactuel.fr`, `caraventure.fr`… La cause est
la dernière règle de chaque fichier :

```
# Catch non-existent .php files before PHP-FPM
RewriteCond %{REQUEST_FILENAME} !-f
RewriteRule ^.*\.php$ /404.php [L]
```

**La vraie cause, trouvée ensuite :** le parc n'est pas servi par Apache mais par
**nginx**, qui ne lit pas les `.htaccess`. Ces fichiers sont un reliquat de l'import
WordPress ; rien de ce qu'on y écrit n'a d'effet. Lu dans
`/etc/nginx/sites-enabled/00-parc-dynamic.conf` :

```nginx
location ~ .php$ { try_files $uri =404; ... }
```

Un `.php` absent du disque rend **404 sans même lancer PHP**. Quand le fichier existe,
PHP tourne, `article.php` lit `permalinks.php` et pose l'en-tête 301 — c'est de là que
venaient les 12 redirections que j'avais d'abord attribuées au `.htaccess` : leurs
fichiers `.php` étaient tous présents sur le disque.

Pour qu'une redirection agisse sur le parc tel qu'il est, il faut donc viser autre chose
que le `.htaccess` : créer le fichier `.php` manquant, écrire dans `permalinks.php`, ou
modifier la configuration nginx (qui demande `sudo`, dont le compte ne dispose pas).

#### Deux formes, au choix de l'agent

L'écran demande **quel serveur web sert ces sites**, et écrit en conséquence. Le bloc
entier passe dans la forme choisie : les deux ne se mélangent jamais dans un fichier, et
basculer de l'une à l'autre réécrit toutes les règles d'un coup.

| Choix | Ce qui est écrit |
|---|---|
| Règle de réécriture (mod_rewrite) | `RewriteCond %{ENV:REDIRECT_STATUS} ^$` puis `RewriteRule ^page.php$ /page [R=301,L]` |
| Apache · Redirect 301 (mod_alias) | `Redirect 301 /page.php /page` |

Une règle déjà posée dans l'autre forme n'est pas annoncée « déjà là » — elle serait
restée inerte : elle est marquée **à réécrire**, et l'écriture la fait basculer.

**Aucune des deux ne prend effet tant que nginx sert le parc** : nginx ne lit pas les
`.htaccess`. L'écran le dit sous le choix Apache. Voir plus bas pourquoi.

#### Ce qui protège le fichier

Le `.htaccess` porte tout le routage d'un site : une écriture ratée le casse
entièrement. Quatre garde-fous, dans cet ordre :

1. **La ligne de repère doit être là, une seule fois.** Absente, on ne sait pas où
   écrire ; en double, il y aurait deux endroits possibles. Dans les deux cas on refuse
   plutôt que de choisir.
2. **Rien n'est écrit si le fichier a changé** depuis la vérification : la somme de
   contrôle vue à l'étape 2 est comparée avant d'écrire.
3. **Une sauvegarde horodatée** part dans `.lkm-backups/` avant toute écriture.
4. **Le fichier est relu et comparé octet à octet** à ce qu'on voulait écrire. Au moindre
   écart, la sauvegarde est remise en place.

L'écriture se fait **sur place**, pas par un renommage : un renommage donnerait au
`.htaccess` le propriétaire du compte SSH au lieu de celui du site.

#### Les adresses refusées

Un saut de ligne dans une adresse laisserait écrire n'importe quelle directive Apache.
C'est la seule injection possible par cette fonctionnalité, et elle est fermée **trois
fois** : dans l'écran, dans le service, et dans le script PHP. Sont refusés les blancs,
les caractères de contrôle, les guillemets, une source qui ne commence pas par `/`, et
une redirection vers elle-même. Une destination peut être un chemin ou une adresse
`https://` complète — un article déplacé sur un autre site du parc est un cas courant.

Éprouvé sur un bac à sable portant un **vrai `.htaccess` du parc** (259 lignes, copié
depuis un site) : la règle atterrit ligne 29, aucune ligne n'est retirée, la demande
rejouée se dit « déjà là » sans toucher au fichier, une somme de contrôle périmée bloque
l'écriture, et les cinq formes d'adresse interdites sont refusées avant d'atteindre le
serveur.

### L'action « Traduction des gabarits »

La seconde action du menu traite les fichiers du moteur — `parts/`, `404.php`, `sitemap.php`… —
là où la première traite `config.php`. Elle reprend le travail du script
[`traduire-langue.sh`](server-scripts/) et l'amène dans l'interface.

**Elle ne devine jamais.** Chaque correction vient soit du lexique du site
(`$lang['home'] ?? 'Accueil'` → la valeur `'Home'` de `parts/lang.php`), soit du dictionnaire du
parc pour les expressions connues. **Aucune analyse statistique** : les gabarits contiennent des
tables multilingues — `$_copyright_texts = ['FR' => …, 'ES' => …]` — qu'une détection par
fréquence de mots signalerait à tort sur *chaque* site. Mesuré : 7 981 faux positifs sur 1 200
sites par la voie statistique, **zéro** par le dictionnaire.

Le fichier est relu par l'analyseur de PHP lui-même (`token_get_all`) : une chaîne dans un
commentaire, un heredoc ou une interpolation ne peut pas être prise pour du texte affiché.

**Seulement ce que le visiteur voit.** Trois sortes de PHP cohabitent dans un site, et une seule
est affichée :

| | Analysé ? |
|---|---|
| Pages servies par une adresse : `index.php`, `404.php`, `sitemap.php`, `contact.php`… | **oui** |
| Morceaux inclus par ces pages : `parts/header.php`, `parts/footer.php`, `parts/picture.php`… | **oui** |
| Les 53 gabarits de `parts/sections/`, assemblés sur la page d'accueil | **oui** |
| Fichiers qu'aucune page n'inclut et qu'aucune adresse ne sert : `parts/_scan_.php`, `_scan_.php` | non |
| Données du moteur : `config.php`, `permalinks.php`, `parts/lang.php` | non |
| Articles | non — ils ont leur propre éditeur |

L'appartenance se décide en lisant les `include` du site, pas sur une liste de noms : un morceau
que personne n'inclut n'atteint jamais un navigateur. Relevé sur flashkod.com : 85 fichiers
retenus — 28 pages, 4 morceaux inclus sur 6 présents dans `parts/`, et les 53 sections.

**Ce qui n'est jamais touché** : le contenu des articles, les adresses (`*_url`, `/chemin`,
`https://…` — traduire un lien changerait sa destination), les identifiants et les classes CSS,
et les tables multilingues.

Chaque fichier corrigé est contrôlé par `php -l`, sauvegardé sous `.lkm-backups/templates/`, puis
écrit sur place.

**Le dictionnaire vient d'abord du site.** Comme dans le script, chaque clé de `parts/lang.php`
fournit une paire « valeur française → valeur de la langue du site » : une vingtaine de mots
propres à ce site, auxquels s'ajoutent le dictionnaire du parc et les mots des agents. Le lexique
a priorité : c'est lui qui fait foi.

### Ajouter un mot qui manque

Ce que l'action ne sait pas traduire, elle le **signale** au lieu de deviner : « Textes français
qu'aucun dictionnaire ne couvre », avec le site et la ligne. Un bouton reprend la phrase dans le
formulaire, l'agent écrit la traduction, et **l'analyse suivante la corrige sur tout le parc**.

Le dictionnaire des agents vit dans la base du back-office — pas sur les serveurs — et sert
immédiatement, sans redémarrage :

| Méthode | Route | Droit |
|---|---|---|
| `GET` | `/api/design/phrases` | `design.read` |
| `POST` | `/api/design/phrases` `{ source, lang, target }` | `design.edit` |
| `DELETE` | `/api/design/phrases/:id` | `design.edit` |

**Mesures du 24/09/2026.** Sur 200 sites : 153 francophones (rien à traduire vers leur propre
langue) et **aucune correction à faire** sur les 47 autres. Le parc est propre de ce côté ; le seul
cas relevé sur 1 600 sites reste `acnav.net`, avec cinq restes dont quatre dans `sitemap.php` — un
fichier qu'on ne pense pas à ouvrir.

> **Un relevé précédent annonçait 134 sites sur 134 à corriger. Il était faux.** Ce qu'il voyait
> était le français **source** de la table `$t404` de la page 404 :
> `['FR' => ['back' => "Retour à l'accueil"], 'UK' => ['back' => 'Back to home'], …]`. Le site y
> choisit sa ligne — rien n'apparaît tel quel dans un navigateur. Écrire ces « corrections » aurait
> remplacé la ligne française par de l'anglais sur des milliers de sites : une donnée corrompue,
> sans le moindre symptôme visible. La garde couvrait les tables plates (`'ES' => 'texte'`), pas
> celles à deux niveaux ; elle couvre désormais les deux.

### Traduction automatique (facultative)

Quatre services au choix, à renseigner dans `.env` — **le premier configuré est retenu** :

| Service | Variable | Remarque |
|---|---|---|
| **DeepL** | `DEEPL_KEY` | Offre gratuite : 500 000 caractères par mois — huit fois le besoin du parc. Une clé finissant par `:fx` désigne cette offre. |
| **Claude** | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`) | Garde le ton d'un slogan et les balises `<em>`, là où un traducteur rend la phrase plate. Le parc entier coûte moins d'un dollar. |
| **Google** | `GOOGLE_TRANSLATE_KEY` | Cloud Translation v2, facturé au caractère. |
| **LibreTranslate** | `LIBRETRANSLATE_URL` (+ `LIBRETRANSLATE_KEY`) | Libre et installable sur vos serveurs : aucun texte ne sort du parc. |

Sans clé, l'écran le dit en toutes lettres sous la barre d'actions, en nommant les variables
attendues — plutôt que de cacher le bouton sans explication.

Deux boutons apparaissent alors : **Traduire tout** remplit les propositions de tous les sites
analysés, **Publier (n)** les met en ligne après une confirmation qui annonce le nombre de sites
et de textes. Les deux gestes restent séparés pour qu'une relecture puisse s'intercaler. Sans
service configuré, l'écran fonctionne à l'identique, l'agent saisissant lui-même les textes.

**Ce que coûte le parc entier.** Relevé du 23/09/2026 sur 2 400 sites (600 par serveur) : 74 sites
à corriger (**3,1 %**), 138 textes, mais seulement **131 textes distincts pour 5 675 caractères** —
les phrases éditoriales ne se répètent pas d'un site à l'autre. Rapporté aux 28 176 domaines du
parc : environ **66 000 caractères**, soit le huitième de l'offre gratuite de DeepL. Un dictionnaire
plus fourni, lui, ne gagnerait presque rien : il couvre déjà les expressions qui reviennent.

### Comment un texte est repéré

Chaque texte est noté sur ses mots outils — « le », « the », « der »… — dans les sept langues du
parc. Trois règles, toutes nées d'un défaut constaté :

1. **Premier tour, la preuve franche.** Le texte doit devancer d'au moins deux points la langue du
   site, et pas seulement la deuxième du classement. « Transformer la donnée biologique en levier
   de longévité » marque 3 en espagnol (`la`, `en`, `de`) contre 2 en français, sans être espagnol.
2. **Second tour, la preuve de contexte.** Une langue déjà prise en faute sur CE site n'a plus à
   convaincre autant. « Architectes du code, compilez ! 💻 » ne marque qu'un point (`du`) : beaucoup
   trop peu pour accuser un site au hasard, largement assez quand deux autres textes de la même page
   sont du français avéré. Ces textes portent la mention « à vérifier » et ne sont jamais cochés
   d'office. Sur 2 400 sites, le second tour ajoute 26 textes, tous réels après relecture.
3. **La marque ne compte pas.** Le nom de domaine et `$site_name` sont retirés du calcul :
   « Explorez l'univers Be You Tiful » est du français, même si `be` et `you` sont deux mots outils
   anglais.

Le reste est affaire de listes : elles se complètent quand un relevé montre un trou. « Bleiben Sie
informiert über… » ne marquait aucun point en allemand — ni `sie` ni `über` n'y figuraient — et
passait pour du français à cause de son « (DE) » final.

**Le parc entier, relevé du 24/09/2026** — les cinq serveurs, 28 176 domaines, **9 min 26 s** :

| Serveur | Domaines | À corriger | Textes |
|---|---:|---:|---:|
| VPS 001 | 7 733 | 147 | 180 |
| VPS 002 | 5 930 | 170 | 235 |
| VPS 003 | 7 561 | **273** | **414** |
| VPS 004 | 5 114 | 119 | 247 |
| Tiers1 | 1 838 | 0 | 0 |
| **Total** | **28 176** | **709** (2,7 %) | **1 076** |

Soit environ 46 000 caractères à traduire — le dixième de l'offre gratuite de DeepL. VPS 003
concentre le problème : deux fois plus de textes que les autres, à domaines comparables.

**Sites ignorés.** Un site sans `config.php` tourne sur un autre moteur. Relevé exhaustif du
24/09/2026 : **1 841 sites**, dont 1 836 sur Tiers1 (MiniBlog — les 2 autres sites de ce serveur
portent bien le moteur du parc), et **cinq isolés** sur les VPS : `missis-beauty.fr`,
`demo-lkm.fr`, `a-lasserre.com`, `noelwhelandesign.com`, `actualitesport.fr`. **Aucun fichier
illisible sur les 28 176 domaines.** Les deux cas étaient d'abord comptés ensemble sous
« illisibles », ce qui faisait passer une banalité pour une alerte ; ils sont désormais séparés.

> À noter : 51 sites français écrivent « Questions frequentes » sans accent. Ce n'est pas un défaut
> de langue et l'écran ne le signale plus — mais c'est le genre de correction de masse que le menu
> **Action** pourra accueillir.

## 13. Traduction des pages d'accueil du parc (script serveur)

Script autonome à exécuter **sur les serveurs** : [`server-scripts/traduire-homepage.sh`](server-scripts/traduire-homepage.sh). Il complète `traduire-langue.sh`, qui traite les gabarits (`parts/`, `homepage.php`) : celui-ci traite le **contenu**, qui vit dans `config.php` — `$site_tagline`, `$header_cta_text` et le tableau `$homepage`.

**Ce qu'il fait**

1. Détermine la langue du site : `$site_lang`, puis l'extension du domaine, puis l'analyse du contenu.
2. Détermine la langue de **chaque texte** de la page d'accueil et repère ceux qui ne sont pas dans la langue du site — dans les deux sens : du français sur un site allemand comme de l'anglais sur un site espagnol.
3. Traduit ce qui est sûr : le dictionnaire intégré pour les expressions qui reviennent partout, un service de traduction pour le reste si une clé est fournie.
4. Réécrit `config.php` **par le lexer de PHP** : seuls les littéraux visés changent, l'indentation et les commentaires restent intacts, et `php -l` valide le fichier avant qu'il ne remplace l'original. Une sauvegarde `.bak-traduire` est posée, comme pour `traduire-langue.sh`.

**Utilisation**

```bash
./traduire-homepage.sh /srv/www --dry-run              # relevé, n'écrit rien
./traduire-homepage.sh /srv/www --deepl=CLE -j 8       # traduction réelle, 8 sites à la fois
./traduire-homepage.sh /srv/www --rapport=/tmp/r.tsv   # relevé exploitable (TSV)
./traduire-homepage.sh /srv/www --restore              # tout annuler
```

Sans clé de traduction, les phrases qu'aucun dictionnaire ne couvre sont **signalées** avec leur domaine et leur chemin exact (`homepage.hero.title`…). Le rapport TSV indique alors à un agent quoi corriger, et où, dans le back-office.

**Mesures sur le parc** (relevé du 23/09/2026, 4 000 sites examinés) : environ **6 % des sites** ont au moins un texte dans la mauvaise langue sur leur page d'accueil, le plus souvent le slogan, l'étiquette ou le titre de la bannière, et les questions de la FAQ. Traitement de 200 sites : 92 s en série, **16 s avec `-j 8`**.

## 14. Dépannage

| Symptôme | Piste |
|---|---|
| `Configuration .env incomplète` au démarrage | Lancez `npm run set-password` |
| `Variable d'environnement manquante : SSH_KEY_PATH` | Renseignez `.env` |
| `Authentification SSH refusée` | Mauvaise clé ou passphrase, ou clé absente de `authorized_keys` |
| `La clé d'hôte … a changé !` | Serveur réinstallé ? Vérifiez l'empreinte **hors bande**, puis retirez la ligne de `config/known_hosts.json` |
| `sudo refusé …` | Ajoutez la règle sudoers NOPASSWD correspondante (§ 4) |
| Interface sans style | `npm run build:css` |
# LKM-BO
