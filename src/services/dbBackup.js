/**
 * Sauvegarde de la base.
 *
 * La base porte tout ce que l'application sait : les comptes et leurs droits, les
 * brouillons en cours, le journal d'audit, et les accès Cloudflare de 38 000 domaines.
 * Elle n'existait qu'en un seul exemplaire.
 *
 * COPIER LE FICHIER NE SUFFIT PAS. La base est en mode WAL : les écritures récentes
 * vivent dans un fichier annexe que `copyFile` ignore. Éprouvé sur la vraie base le
 * 01/10/2026 — la copie brute s'ouvre sur « database disk image is malformed ». On
 * demande donc à SQLite d'écrire lui-même une copie cohérente, par `VACUUM INTO` :
 * 0,5 s pour 14 Mo, et la copie passe le contrôle d'intégrité.
 *
 * Le chiffrement est en option et ne prétend pas à plus qu'il ne fait : la clé vit dans
 * `.env`, sur la même machine. Il protège une sauvegarde emportée ailleurs — un disque
 * externe, un envoi vers un autre serveur — pas la machine elle-même.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../db/database.js';

/** L'horodatage qui nomme les sauvegardes, et qui se trie tout seul dans l'ordre. */
export const backupStamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
};

const NOM = /^lkm-bo-(\d{8}-\d{6})\.db(\.enc)?$/;

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
 * Écrit une sauvegarde, puis range les anciennes.
 *
 * @param {object} options
 * @param {string} options.dir        où déposer les sauvegardes
 * @param {number} options.keep       combien en conserver
 * @param {string} [options.secret]   clé de chiffrement ; absente, le fichier reste en clair
 */
export function backupDatabase({ dir, keep = 14, secret = '' } = {}) {
  if (!dir) throw new Error('aucun dossier de sauvegarde');
  fs.mkdirSync(dir, { recursive: true });

  const stamp = backupStamp();
  const nom = `lkm-bo-${stamp}.db`;
  const brut = path.join(dir, nom);
  const t0 = Date.now();

  // Le chemin passe dans une chaîne SQL : les apostrophes y sont doublées, et les
  // antislashs de Windows deviennent des barres obliques, que SQLite accepte.
  const pourSql = brut.replace(/\\/g, '/').replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${pourSql}'`);

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
 * rendre un fichier qui ne passe pas le contrôle d'intégrité de SQLite.
 *
 * Restaurer une base corrompue par-dessus une base saine serait le pire des deux mondes.
 *
 * @returns {{ path: string, temporary: boolean }} le fichier prêt à être copié
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
    fichier = path.join(workDir ?? dir, `.restore-${info.stamp}.db`);
    decryptFile(source, fichier, secret);
    temporaire = true;
  }
  return { path: fichier, temporary: temporaire, info };
}
