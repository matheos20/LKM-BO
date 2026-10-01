/**
 * Import d'un export Cloudflare : validation des lignes, puis écriture en base.
 *
 * Ce que la mesure de l'export du parc a appris, et que ce code prend pour acquis :
 *   - 40 781 lignes, 38 345 domaines distincts ;
 *   - 93 % des lignes sont complètes et exploitables telles quelles ;
 *   - 5,8 % portent le TEXTE « NULL » en guise de domaine — inutilisables ;
 *   - 3,9 % n'ont pas d'identifiant de zone, que l'API saura retrouver plus tard ;
 *   - 58 domaines apparaissent deux fois, dont 6 avec des valeurs divergentes.
 *
 * Aucune ligne n'est devinée ni réparée en silence : ce qui n'entre pas est compté,
 * classé par motif, et rendu à l'appelant. Un import qui ne se raconte pas ne se
 * vérifie pas.
 */
import { getDb } from '../db/database.js';
import { parseCsv } from './csv.js';

/** Un identifiant Cloudflare : trente-deux caractères hexadécimaux. */
const ID_RE = /^[0-9a-f]{32}$/i;
/**
 * Une clé globale fait trente-sept caractères hexadécimaux : cette forme-là est sûre.
 *
 * Pour le reste, on reste large. Une première version n'acceptait un jeton qu'à
 * quarante caractères, la longueur des jetons actuels : elle écartait 63 lignes de
 * l'export, dont les toutes premières, qui portent des secrets de 52 caractères.
 * Décider à la place de Cloudflare ce qui est un accès valable, c'est se tromper sur
 * ses formats passés et futurs. On accepte donc toute chaîne de forme plausible, et
 * c'est la vérification auprès de l'API qui tranchera pour de bon.
 */
const GLOBAL_KEY_RE = /^[0-9a-f]{37}$/i;
const TOKEN_RE = /^[A-Za-z0-9_.-]{20,200}$/;
/** Un nom de domaine, sans chercher à valider l'extension : la liste change trop. */
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Le texte « NULL » d'un export vaut une absence, pas une valeur. */
const vide = (v) => {
  const s = String(v ?? '').trim();
  return !s || s.toUpperCase() === 'NULL' ? '' : s;
};

/** Le domaine, ramené à sa forme canonique : minuscules, sans schéma ni chemin. */
export function normalizeDomain(value) {
  let s = vide(value).toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return DOMAIN_RE.test(s) ? s : '';
}

/**
 * Examine une ligne de l'export.
 * @returns {{ ok: true, domain, accountId, key, token, zoneId } | { ok: false, reason: string }}
 */
export function validateRow(row) {
  const domain = normalizeDomain(row.domain);
  if (!domain) return { ok: false, reason: vide(row.domain) ? 'domaine invalide' : 'domaine absent' };

  const accountId = vide(row.account_id);
  if (!accountId) return { ok: false, reason: 'compte absent' };
  if (!ID_RE.test(accountId)) return { ok: false, reason: 'compte mal formé' };

  // Une même colonne peut porter l'une ou l'autre forme de secret : on reconnaît
  // laquelle plutôt que de l'imposer.
  const secret = vide(row.global_api_key ?? row.api_key ?? row.token);
  if (!secret) return { ok: false, reason: 'aucun accès' };
  const token = TOKEN_RE.test(secret) && !GLOBAL_KEY_RE.test(secret) ? secret : '';
  const key = token ? '' : secret;
  if (!token && !GLOBAL_KEY_RE.test(secret)) return { ok: false, reason: 'accès mal formé' };

  // La zone peut manquer : l'API sait la retrouver depuis le domaine. Ce n'est donc
  // pas un motif de rejet, seulement un travail remis à plus tard.
  const zoneId = vide(row.zone_id);
  return { ok: true, domain, accountId, key, token, zoneId: ID_RE.test(zoneId) ? zoneId : '', email: vide(row.email) };
}

/**
 * Lit un export et le résume SANS rien écrire.
 * C'est ce qui permet de montrer à l'agent ce qui entrera avant qu'il ne décide.
 */
export function analyzeCsv(text) {
  const { columns, rows, malformed } = parseCsv(text);
  const manquantes = ['domain', 'account_id'].filter((c) => !columns.includes(c));
  const report = {
    columns,
    rowsRead: rows.length,
    malformed: malformed.length,
    missingColumns: manquantes,
    valid: 0,
    withoutZone: 0,
    duplicates: 0,
    conflicts: 0,
    skipped: 0,
    reasons: {},
    accounts: 0,
    samples: [],
  };
  if (manquantes.length) return report;

  const vues = new Map();
  const comptes = new Set();
  for (const row of rows) {
    const r = validateRow(row);
    if (!r.ok) {
      report.skipped += 1;
      report.reasons[r.reason] = (report.reasons[r.reason] ?? 0) + 1;
      if (report.samples.length < 5) report.samples.push({ line: row.__line, domain: String(row.domain ?? '').slice(0, 60), reason: r.reason });
      continue;
    }
    report.valid += 1;
    if (!r.zoneId) report.withoutZone += 1;
    comptes.add(r.accountId);

    const avant = vues.get(r.domain);
    if (avant) {
      report.duplicates += 1;
      // Deux lignes pour un même domaine, mais pas les mêmes valeurs : il faudra
      // trancher, et l'agent doit le savoir.
      if (avant.accountId !== r.accountId || avant.zoneId !== r.zoneId) report.conflicts += 1;
    }
    vues.set(r.domain, r);
  }
  report.accounts = comptes.size;
  report.domains = vues.size;
  return report;
}

const maintenant = () => Date.now();

/**
 * Écrit un export en base.
 *
 * La dernière ligne gagne en cas de doublon : c'est le choix le plus prévisible, et le
 * rapport dit combien de fois il a fallu trancher. Tout se fait dans UNE transaction :
 * un import à moitié écrit serait pire que pas d'import du tout.
 */
export function importCsv(text, { source = '', onProgress = null } = {}) {
  const db = getDb();
  const report = analyzeCsv(text);
  if (report.missingColumns.length) {
    const err = new Error(`colonnes absentes : ${report.missingColumns.join(', ')}`);
    err.key = 'errors.cf_csv_columns';
    throw err;
  }

  const { rows } = parseCsv(text);
  const now = maintenant();
  const compte = { accountsAdded: 0, accountsUpdated: 0, zonesAdded: 0, zonesUpdated: 0 };

  const chercheCompte = db.prepare('SELECT id, email, global_api_key, api_token FROM cf_accounts WHERE account_id = ?');
  const ajouteCompte = db.prepare(
    `INSERT INTO cf_accounts (account_id, email, global_api_key, api_token, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const majCompte = db.prepare('UPDATE cf_accounts SET email = ?, global_api_key = ?, api_token = ?, updated_at = ? WHERE id = ?');
  const chercheZone = db.prepare('SELECT id, zone_id, account_ref FROM cf_zones WHERE domain = ?');
  const ajouteZone = db.prepare('INSERT INTO cf_zones (domain, zone_id, account_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const majZone = db.prepare('UPDATE cf_zones SET zone_id = ?, account_ref = ?, updated_at = ? WHERE id = ?');

  // Une seule transaction, à la main : `node:sqlite` n'offre pas l'enveloppe de
  // better-sqlite3, et le dépôt écrit déjà ses transactions ainsi. Un import à moitié
  // écrit serait pire que pas d'import du tout.
  db.exec('BEGIN');
  try {
    let n = 0;
    for (const row of rows) {
      const r = validateRow(row);
      if (!r.ok) continue;

      let compteExistant = chercheCompte.get(r.accountId);
      if (!compteExistant) {
        ajouteCompte.run(r.accountId, r.email, r.key, r.token, now, now);
        compteExistant = chercheCompte.get(r.accountId);
        compte.accountsAdded += 1;
      } else {
        // On ne REMPLACE jamais un accès déjà renseigné par du vide : l'e-mail saisi à
        // la main après coup survit à un nouvel import.
        const email = r.email || compteExistant.email;
        const key = r.key || compteExistant.global_api_key;
        const token = r.token || compteExistant.api_token;
        if (email !== compteExistant.email || key !== compteExistant.global_api_key || token !== compteExistant.api_token) {
          majCompte.run(email, key, token, now, compteExistant.id);
          compte.accountsUpdated += 1;
        }
      }

      const zoneExistante = chercheZone.get(r.domain);
      if (!zoneExistante) {
        ajouteZone.run(r.domain, r.zoneId, compteExistant.id, now, now);
        compte.zonesAdded += 1;
      } else if (zoneExistante.zone_id !== (r.zoneId || zoneExistante.zone_id) || zoneExistante.account_ref !== compteExistant.id) {
        majZone.run(r.zoneId || zoneExistante.zone_id, compteExistant.id, now, zoneExistante.id);
        compte.zonesUpdated += 1;
      }

      n += 1;
      if (onProgress && n % 2000 === 0) onProgress(n, rows.length);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  db.prepare(
    `INSERT INTO cf_imports (at, source, rows_read, accounts_added, zones_added, zones_updated, skipped, report)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(now, source, report.rowsRead, compte.accountsAdded, compte.zonesAdded, compte.zonesUpdated, report.skipped, JSON.stringify(report));

  return { ...report, ...compte, at: now };
}

/**
 * L'adresse du compte Cloudflare d'un domaine.
 *
 * Les comptes du parc portent une adresse déduite du nom de domaine complet :
 * « 201eat.com@linkuma.co ». Vérifié auprès de l'API le 01/10/2026 sur quatre domaines
 * pris au hasard, quatre fois sur quatre.
 *
 * Sans elle, rien ne fonctionne : une clé globale présentée sans e-mail reçoit un
 * « 9106 Missing X-Auth-Email header », et c'est ce qui bloquait tout le module.
 */
export const deriveEmail = (domain, emailDomain = 'linkuma.co') => {
  const d = normalizeDomain(domain);
  return d && emailDomain ? `${d}@${emailDomain}` : '';
};

/**
 * Complète les comptes sans adresse, en la déduisant de leur domaine.
 *
 * Ne touche QUE les comptes dont l'adresse est vide : une adresse saisie à la main, ou
 * venue d'un export, n'est jamais remplacée par une déduction. Un compte qui porte
 * plusieurs domaines prend le premier par ordre alphabétique — à charge pour la
 * vérification de dire si l'accès passe.
 */
export function deriveMissingEmails(emailDomain = 'linkuma.co', { dryRun = false } = {}) {
  const db = getDb();
  const aCompleter = db.prepare(
    `SELECT a.id, a.account_id, MIN(z.domain) AS domain
     FROM cf_accounts a JOIN cf_zones z ON z.account_ref = a.id
     WHERE a.email = '' AND a.api_token = '' AND a.global_api_key <> ''
     GROUP BY a.id`,
  ).all();

  const prevus = aCompleter
    .map((c) => ({ id: c.id, accountId: c.account_id, domain: c.domain, email: deriveEmail(c.domain, emailDomain) }))
    .filter((c) => c.email);

  if (dryRun) return { candidates: prevus.length, updated: 0, samples: prevus.slice(0, 5) };

  const now = Date.now();
  const maj = db.prepare('UPDATE cf_accounts SET email = ?, updated_at = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const c of prevus) maj.run(c.email, now, c.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { candidates: prevus.length, updated: prevus.length, samples: prevus.slice(0, 5) };
}

/** Ce que la base contient aujourd'hui, pour l'afficher sans tout relire. */
export function cloudflareStats() {
  const db = getDb();
  const un = (sql, ...args) => db.prepare(sql).get(...args) ?? {};
  return {
    accounts: un('SELECT COUNT(*) AS n FROM cf_accounts').n ?? 0,
    accountsWithEmail: un("SELECT COUNT(*) AS n FROM cf_accounts WHERE email <> ''").n ?? 0,
    accountsWithToken: un("SELECT COUNT(*) AS n FROM cf_accounts WHERE api_token <> ''").n ?? 0,
    zones: un('SELECT COUNT(*) AS n FROM cf_zones').n ?? 0,
    zonesWithId: un("SELECT COUNT(*) AS n FROM cf_zones WHERE zone_id <> ''").n ?? 0,
    lastImport: db.prepare('SELECT at, source, rows_read, accounts_added, zones_added, skipped FROM cf_imports ORDER BY at DESC LIMIT 1').get() ?? null,
  };
}
