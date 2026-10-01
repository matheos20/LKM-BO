/**
 * Sauvegarde de la base.
 *
 * La base porte tout ce que l'application sait : les comptes et leurs droits, les
 * brouillons en cours, le journal d'audit, et les accès Cloudflare de 38 000 domaines.
 * Elle n'existe qu'en un seul exemplaire, dans MySQL.
 *
 * POURQUOI MYSQLDUMP, ET PAS UNE COPIE DES FICHIERS. Les fichiers d'InnoDB ne se
 * recopient pas à chaud : les écritures récentes vivent dans le journal de transactions,
 * et une copie prise en cours de route donne une base qui refuse de s'ouvrir. La leçon
 * avait déjà été apprise du temps de SQLite, où `copyFile` rendait « database disk image
 * is malformed ». On demande donc au serveur d'écrire lui-même un état cohérent.
 *
 * `--single-transaction` donne cette cohérence SANS verrouiller : la sauvegarde lit un
 * instantané, et l'application continue d'écrire pendant ce temps. C'est possible parce
 * que toutes les tables sont en InnoDB — avec MyISAM, il faudrait verrouiller.
 *
 * LE MOT DE PASSE NE PASSE PAS PAR LA LIGNE DE COMMANDE. Sous Windows comme ailleurs,
 * la ligne de commande d'un processus est lisible par les autres : `--password=…` offre
 * l'accès à la base à quiconque regarde la liste des processus au bon moment. Il part
 * donc dans un fichier temporaire, lu par le client puis effacé.
 *
 * Le chiffrement est en option et ne prétend pas à plus qu'il ne fait : la clé vit dans
 * `.env`, sur la même machine. Il protège une sauvegarde emportée ailleurs — un disque
 * externe, un envoi vers un autre serveur — pas la machine elle-même.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** L'horodatage qui nomme les sauvegardes, et qui se trie tout seul dans l'ordre. */
export const backupStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

const NOM = /^lkm-bo-(\d{8}-\d{6})\.sql(\.enc)?$/;

/** Ce qu'un nom de fichier de sauvegarde raconte, ou null s'il n'en est pas un. */
export function describeDbBackup(name) {
  const m = NOM.exec(String(name ?? ''));
  if (!m) return null;
  const [, stamp, chiffre] = m;
  const at = Date.UTC(
    Number(stamp.slice(0, 4)), Number(stamp.slice(4, 6)) - 1, Number(stamp.slice(6, 8)),
    Number(stamp.slice(9, 11)), Number(stamp.slice(11, 13)), Number(stamp.slice(13, 15)),
  );
  return { name, stamp, at, encrypted: Boolean(chiffre) };
}

// ───────────────────── Trouver les outils de MySQL ─────────────────────

/**
 * Les endroits où chercher `mysqldump` et `mysql`, dans l'ordre.
 *
 * Sur l'installation XAMPP du poste, ils ne sont PAS dans le chemin du système : s'en
 * remettre au seul nom de commande donnerait une sauvegarde qui échoue sans qu'on
 * comprenne pourquoi. On regarde donc aussi les emplacements habituels.
 */
const PISTES = [
  'C:/xampp/mysql/bin',
  'C:/Program Files/MariaDB/bin',
  'C:/Program Files/MySQL/MySQL Server 8.0/bin',
  '/usr/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
];

/**
 * Le chemin d'un outil client, ou null.
 *
 * @param {'mysqldump'|'mysql'} outil
 * @param {string} [impose]  chemin donné par la configuration : il l'emporte, et s'il est
 *                           faux on ne lui cherche pas de remplaçant en silence.
 */
export function findMysqlTool(outil, impose = '') {
  if (impose) return fs.existsSync(impose) ? impose : null;
  const suffixe = process.platform === 'win32' ? '.exe' : '';
  for (const dossier of PISTES) {
    const essai = path.join(dossier, `${outil}${suffixe}`);
    if (fs.existsSync(essai)) return essai;
  }
  // Dernier recours : le chemin du système saura peut-être le résoudre.
  const r = spawnSync(outil, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? outil : null;
}

/**
 * Écrit le fichier qui porte les identifiants, et rend son chemin.
 *
 * Il est créé en lecture seule pour son propriétaire. Sous Windows le mode n'a pas le
 * même effet qu'ailleurs, mais le fichier vit quelques secondes dans le dossier
 * temporaire de l'utilisateur et il est effacé quoi qu'il arrive.
 */
function fichierIdentifiants({ host, port, user, password }) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'lkm-bo-cnf-'));
  const fichier = path.join(dossier, 'client.cnf');
  // Les valeurs ne sont pas échappées par le client : une apostrophe ou un saut de ligne
  // dans un mot de passe casserait le fichier. On refuse plutôt que d'écrire de travers.
  for (const [nom, v] of Object.entries({ host, user, password })) {
    if (/[\r\n]/.test(String(v ?? ''))) throw new Error(`« ${nom} » contient un saut de ligne : impossible à transmettre`);
  }
  fs.writeFileSync(
    fichier,
    `[client]\nhost=${host}\nport=${port}\nuser=${user}\npassword=${password}\ndefault-character-set=utf8mb4\n`,
    { mode: 0o600 },
  );
  return { fichier, dossier };
}

// ───────────────────────────── Chiffrement ─────────────────────────────

const SEL = 'lkm-bo-db-backup';
const cle = (secret) => scryptSync(String(secret), SEL, 32);

/**
 * Chiffre un fichier en AES-256-GCM.
 * Le fichier produit porte en tête le vecteur d'initialisation et l'étiquette
 * d'authentification : déchiffrer un fichier modifié échoue bruyamment, au lieu de
 * rendre des octets faux.
 */
export function encryptFile(source, destination, secret) {
  const iv = randomBytes(12);
  const chiffreur = createCipheriv('aes-256-gcm', cle(secret), iv);
  const chiffre = Buffer.concat([chiffreur.update(fs.readFileSync(source)), chiffreur.final()]);
  fs.writeFileSync(destination, Buffer.concat([iv, chiffreur.getAuthTag(), chiffre]));
  return destination;
}

export function decryptFile(source, destination, secret) {
  const tout = fs.readFileSync(source);
  const iv = tout.subarray(0, 12);
  const tag = tout.subarray(12, 28);
  const dechiffreur = createDecipheriv('aes-256-gcm', cle(secret), iv);
  dechiffreur.setAuthTag(tag);
  // `final()` lève si le contenu a été modifié ou si la clé est fausse.
  fs.writeFileSync(destination, Buffer.concat([dechiffreur.update(tout.subarray(28)), dechiffreur.final()]));
  return destination;
}

// ───────────────────────────── Sauvegarde ─────────────────────────────

/**
 * La marque que mysqldump écrit en DERNIER, et seulement si tout s'est bien passé.
 *
 * C'est le seul contrôle d'intégrité dont on dispose sur un fichier SQL : un dump
 * interrompu — disque plein, serveur arrêté, processus tué — s'arrête au milieu d'un
 * INSERT et ne porte pas cette ligne. Restaurer un tel fichier par-dessus une base saine
 * serait le pire des deux mondes.
 */
const MARQUE_FIN = '-- Dump completed';

/** Un dump est-il complet ? On lit la fin du fichier, pas les 15 Mo. */
export function dumpLooksComplete(file) {
  const taille = fs.statSync(file).size;
  if (!taille) return false;
  const lire = Math.min(taille, 512);
  const tampon = Buffer.alloc(lire);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, tampon, 0, lire, taille - lire);
  } finally {
    fs.closeSync(fd);
  }
  return tampon.toString('utf8').includes(MARQUE_FIN);
}

/**
 * Écrit une sauvegarde, puis range les anciennes.
 *
 * @param {object} options
 * @param {string} options.dir        où déposer les sauvegardes
 * @param {object} options.mysql      { host, port, user, password, database }
 * @param {number} [options.keep]     combien en conserver
 * @param {string} [options.secret]   clé de chiffrement ; absente, le fichier reste en clair
 * @param {string} [options.mysqldump] chemin de l'outil, s'il n'est pas là où on le cherche
 */
export function backupDatabase({ dir, mysql, keep = 14, secret = '', mysqldump = '' } = {}) {
  if (!dir) throw new Error('aucun dossier de sauvegarde');
  if (!mysql?.database) throw new Error('aucune base à sauvegarder');

  const outil = findMysqlTool('mysqldump', mysqldump);
  if (!outil) throw new Error('mysqldump est introuvable : indiquez son chemin dans MYSQLDUMP_PATH');

  fs.mkdirSync(dir, { recursive: true });
  const stamp = backupStamp();
  const brut = path.join(dir, `lkm-bo-${stamp}.sql`);
  const t0 = Date.now();

  const { fichier: cnf, dossier: tmpCnf } = fichierIdentifiants(mysql);
  try {
    const r = spawnSync(
      outil,
      [
        // Doit être le PREMIER argument : le client ne le lit pas ailleurs.
        `--defaults-extra-file=${cnf}`,
        // Un instantané cohérent, sans verrouiller la base pendant ce temps.
        '--single-transaction',
        // Sans cette option, mysqldump pose un verrou de lecture global avant de commencer.
        '--skip-lock-tables',
        // Le fichier rejoue la structure autant que les données : il restaure une base
        // vide comme il remplace une base existante.
        '--add-drop-table',
        '--default-character-set=utf8mb4',
        // Les octets d'une valeur binaire passent en hexadécimal : rien ne se perd au
        // passage par un fichier texte.
        '--hex-blob',
        mysql.database,
        // Le serveur écrit lui-même le fichier : sous Windows, une redirection par le
        // terminal convertirait les fins de ligne et abîmerait le contenu.
        `--result-file=${brut}`,
      ],
      { encoding: 'utf8', maxBuffer: 1 << 20 },
    );

    if (r.status !== 0) {
      fs.rmSync(brut, { force: true });
      const motif = String(r.stderr || r.error?.message || `code ${r.status}`).trim().split('\n')[0];
      throw new Error(`mysqldump a échoué : ${motif}`);
    }
    // On vérifie AVANT de ranger les anciennes : une sauvegarde incomplète ne doit
    // surtout pas servir de prétexte à effacer une bonne.
    if (!dumpLooksComplete(brut)) {
      fs.rmSync(brut, { force: true });
      throw new Error('le fichier produit est incomplet : il n’a pas été conservé');
    }
  } finally {
    fs.rmSync(tmpCnf, { recursive: true, force: true });
  }

  let fichier = brut;
  if (secret) {
    fichier = `${brut}.enc`;
    encryptFile(brut, fichier, secret);
    fs.rmSync(brut, { force: true });
  }

  const taille = fs.statSync(fichier).size;
  const { removed } = pruneBackups({ dir, keep });
  return { file: fichier, name: path.basename(fichier), stamp, bytes: taille, ms: Date.now() - t0, encrypted: Boolean(secret), removed };
}

/** Les sauvegardes présentes, de la plus récente à la plus ancienne. */
export function listDbBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map(describeDbBackup)
    .filter(Boolean)
    .map((b) => ({ ...b, bytes: fs.statSync(path.join(dir, b.name)).size }))
    .sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/**
 * Efface les sauvegardes au-delà du nombre conservé.
 * Un plancher de trois : même réglé bas, on ne se retrouve jamais avec une seule copie,
 * qui pourrait être celle d'un incident qu'on cherche justement à défaire.
 */
export function pruneBackups({ dir, keep = 14 }) {
  const garde = Math.max(3, Number(keep) || 0);
  const toutes = listDbBackups(dir);
  const aEffacer = toutes.slice(garde);
  for (const b of aEffacer) fs.rmSync(path.join(dir, b.name), { force: true });
  return { kept: toutes.length - aEffacer.length, removed: aEffacer.map((b) => b.name) };
}

/**
 * Prépare une sauvegarde à être remise en place : déchiffre si besoin, et REFUSE de
 * rendre un fichier qui ne porte pas la marque de fin de mysqldump.
 *
 * @returns {{ path: string, temporary: boolean, info: object }} le fichier prêt à rejouer
 */
export function prepareRestore({ dir, name, secret = '', workDir = null }) {
  const info = describeDbBackup(name);
  if (!info) throw new Error(`nom de sauvegarde non reconnu : ${name}`);
  const source = path.join(dir, name);
  if (!fs.existsSync(source)) throw new Error(`sauvegarde introuvable : ${name}`);

  let fichier = source;
  let temporaire = false;
  if (info.encrypted) {
    if (!secret) throw new Error('cette sauvegarde est chiffrée : la clé est nécessaire');
    fichier = path.join(workDir ?? dir, `.restore-${info.stamp}.sql`);
    decryptFile(source, fichier, secret);
    temporaire = true;
  }

  if (!dumpLooksComplete(fichier)) {
    if (temporaire) fs.rmSync(fichier, { force: true });
    throw new Error(`cette sauvegarde est incomplète : ${name}`);
  }
  return { path: fichier, temporary: temporaire, info };
}

/**
 * Rejoue une sauvegarde dans la base.
 *
 * GESTE DESTRUCTEUR : le fichier porte des « DROP TABLE », donc tout ce que la base
 * contient aujourd'hui est remplacé par l'état de la sauvegarde. Rien ne se fait sans
 * `confirm: true` — une faute de frappe ne doit pas effacer le travail du jour.
 *
 * Une sauvegarde est prise AVANT de rejouer, sauf si on la refuse explicitement : c'est
 * ce qui rend la remise en place elle-même réversible.
 */
export function restoreDatabase({ dir, name, mysql, secret = '', confirm = false, backupFirst = true, mysqldump = '', mysqlClient = '' } = {}) {
  if (!confirm) throw new Error('restauration non confirmée : rien n’a été fait');
  const client = findMysqlTool('mysql', mysqlClient);
  if (!client) throw new Error('le client mysql est introuvable : indiquez son chemin dans MYSQL_CLIENT_PATH');

  const pret = prepareRestore({ dir, name, secret });
  const avant = backupFirst ? backupDatabase({ dir, mysql, secret, mysqldump }) : null;
  const t0 = Date.now();
  const { fichier: cnf, dossier: tmpCnf } = fichierIdentifiants(mysql);
  try {
    const r = spawnSync(client, [`--defaults-extra-file=${cnf}`, mysql.database], {
      input: fs.readFileSync(pret.path),
      encoding: 'utf8',
      maxBuffer: 1 << 20,
    });
    if (r.status !== 0) {
      const motif = String(r.stderr || r.error?.message || `code ${r.status}`).trim().split('\n')[0];
      throw new Error(`la restauration a échoué : ${motif}`);
    }
  } finally {
    fs.rmSync(tmpCnf, { recursive: true, force: true });
    if (pret.temporary) fs.rmSync(pret.path, { force: true });
  }
  return { restored: name, ms: Date.now() - t0, safetyBackup: avant?.name ?? null };
}
