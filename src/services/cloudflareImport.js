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
import { insertMany, prepare, transaction } from '../db/mysql.js';
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
 *
 * LA FORME A CHANGÉ AVEC MYSQL, PAS LE RÉSULTAT.
 *
 * Sur SQLite, chaque ligne de l'export menait quatre requêtes — chercher le compte, le
 * créer ou le mettre à jour, chercher la zone, l'écrire — et c'était gratuit : le pilote
 * était synchrone, tout se passait dans le processus. Avec MySQL, chaque requête est un
 * aller-retour sur le réseau. Quatre fois 40 781 lignes font plus de 160 000 allers-
 * retours : l'import passerait de deux secondes à plusieurs minutes.
 *
 * On procède donc autrement : tout l'existant est lu en DEUX requêtes, la comparaison se
 * fait en mémoire, et seules les lignes réellement nouvelles ou modifiées repartent, par
 * paquets. Le compte rendu reste exact — il est calculé sur l'état lu — et `updated_at`
 * garde son sens : il dit « changé », pas « revu ».
 */
export async function importCsv(text, { source = '', onProgress = null } = {}) {
  const report = analyzeCsv(text);
  if (report.missingColumns.length) {
    const err = new Error(`colonnes absentes : ${report.missingColumns.join(', ')}`);
    err.key = 'errors.cf_csv_columns';
    throw err;
  }

  const { rows } = parseCsv(text);
  const now = maintenant();
  const compte = { accountsAdded: 0, accountsUpdated: 0, zonesAdded: 0, zonesUpdated: 0 };

  await transaction(async (tx) => {
    // Tout l'existant, en deux requêtes. 12 000 comptes et 38 000 zones tiennent sans
    // peine en mémoire ; 160 000 allers-retours ne tiendraient pas dans la patience
    // de l'agent.
    const comptes = new Map();
    for (const a of await tx.prepare('SELECT id, account_id, email, global_api_key, api_token FROM cf_accounts').all()) {
      // Noms de colonnes traduits une fois pour toutes : la comparaison plus bas se lit
      // mieux quand les deux côtés portent les mêmes noms.
      comptes.set(a.account_id, { id: a.id, email: a.email, key: a.global_api_key, token: a.api_token });
    }
    const zones = new Map();
    for (const z of await tx.prepare('SELECT id, domain, zone_id, account_ref, checked_at FROM cf_zones').all()) {
      zones.set(z.domain, z);
    }

    // ── Premier passage : ce que l'export dit des comptes et des domaines.
    //
    // La DERNIÈRE ligne gagne, comme avant : une valeur plus récente écrase la
    // précédente, et une valeur vide ne remplace jamais rien.
    const voulus = new Map(); // account_id → { email, key, token }
    const voulusZones = new Map(); // domaine → { accountId, zoneId }
    let n = 0;
    for (const row of rows) {
      const r = validateRow(row);
      if (!r.ok) continue;

      const dejaVu = voulus.get(r.accountId) ?? comptes.get(r.accountId);
      voulus.set(r.accountId, {
        email: r.email || dejaVu?.email || '',
        key: r.key || dejaVu?.key || '',
        token: r.token || dejaVu?.token || '',
      });
      voulusZones.set(r.domain, { accountId: r.accountId, zoneId: r.zoneId });

      n += 1;
      if (onProgress && n % 2000 === 0) onProgress(n, rows.length);
    }

    // ── Les comptes : on n'écrit que ce qui change.
    const aEcrireComptes = [];
    for (const [accountId, v] of voulus) {
      const avant = comptes.get(accountId);
      if (!avant) {
        compte.accountsAdded += 1;
        aEcrireComptes.push([accountId, v.email, v.key, v.token, now, now]);
      } else if (v.email !== avant.email || v.key !== avant.key || v.token !== avant.token) {
        compte.accountsUpdated += 1;
        aEcrireComptes.push([accountId, v.email, v.key, v.token, now, now]);
      }
    }
    await insertMany('cf_accounts', ['account_id', 'email', 'global_api_key', 'api_token', 'created_at', 'updated_at'], aEcrireComptes, {
      // La fusion « jamais remplacer par du vide » a déjà été faite au-dessus : ce qui
      // arrive ici est la valeur finale, et elle peut s'écrire telle quelle.
      onDuplicate: 'email = VALUES(email), global_api_key = VALUES(global_api_key), api_token = VALUES(api_token), updated_at = VALUES(updated_at)',
      via: tx,
    });

    // Les comptes créés ont reçu leur identifiant interne : il faut le relire pour
    // rattacher les zones. Une requête, pas une par compte.
    if (compte.accountsAdded) {
      for (const a of await tx.prepare('SELECT id, account_id FROM cf_accounts').all()) {
        if (!comptes.has(a.account_id)) comptes.set(a.account_id, { id: a.id, email: '', key: '', token: '' });
      }
    }

    // ── Les zones, maintenant que chaque compte a son identifiant.
    const aEcrireZones = [];
    for (const [domain, v] of voulusZones) {
      const ref = comptes.get(v.accountId)?.id;
      // Ne devrait pas arriver : le compte vient d'être écrit. Mieux vaut sauter la zone
      // que de poser une référence fausse, que la clé étrangère refuserait de toute façon.
      if (!ref) continue;
      const avant = zones.get(domain);

      // UN EXPORT NE CORRIGE PAS CE QUE L'API A CONFIRMÉ.
      //
      // « cf verify » interroge Cloudflare, retrouve la vraie zone d'un domaine et
      // inscrit la correction, puis pose checked_at. Un export est une photographie, et
      // la sienne peut être périmée : l'export du parc portait encore l'ancienne zone
      // d'un domaine déjà corrigé. Sans cette règle, chaque import défaisait la
      // vérification, et l'opération suivante repartait vers la mauvaise zone — purger
      // le cache d'un autre site, sans que rien ne le signale.
      //
      // C'est la même règle que pour l'adresse d'un compte : une valeur sûre n'est
      // jamais remplacée par une valeur qui l'est moins.
      const confirmee = Boolean(avant?.checked_at && avant.zone_id);
      const zoneId = confirmee ? avant.zone_id : v.zoneId || avant?.zone_id || '';
      if (!avant) {
        compte.zonesAdded += 1;
        aEcrireZones.push([domain, zoneId, ref, now, now]);
      } else if (zoneId !== avant.zone_id || ref !== avant.account_ref) {
        compte.zonesUpdated += 1;
        aEcrireZones.push([domain, zoneId, ref, now, now]);
      }
    }
    await insertMany('cf_zones', ['domain', 'zone_id', 'account_ref', 'created_at', 'updated_at'], aEcrireZones, {
      onDuplicate: 'zone_id = VALUES(zone_id), account_ref = VALUES(account_ref), updated_at = VALUES(updated_at)',
      via: tx,
    });

    // Le relevé de l'import entre dans la MÊME transaction : un import annulé ne doit
    // pas laisser derrière lui la trace d'un import réussi.
    await tx.prepare(
      `INSERT INTO cf_imports (at, source, rows_read, accounts_added, zones_added, zones_updated, skipped, report)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(now, String(source ?? '').slice(0, 190), report.rowsRead, compte.accountsAdded, compte.zonesAdded, compte.zonesUpdated, report.skipped, JSON.stringify(report));
  });

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
export async function deriveMissingEmails(emailDomain = 'linkuma.co', { dryRun = false } = {}) {
  // MAX(a.account_id) plutôt que a.account_id : avec ONLY_FULL_GROUP_BY, une colonne
  // qui n'est ni regroupée ni agrégée fait refuser la requête.
  const aCompleter = await prepare(
    `SELECT a.id, MAX(a.account_id) AS account_id, MIN(z.domain) AS domain
     FROM cf_accounts a JOIN cf_zones z ON z.account_ref = a.id
     WHERE a.email = '' AND a.api_token = '' AND a.global_api_key <> ''
     GROUP BY a.id`,
  ).all();

  const prevus = aCompleter
    .map((c) => ({ id: c.id, accountId: c.account_id, domain: c.domain, email: deriveEmail(c.domain, emailDomain) }))
    .filter((c) => c.email);

  if (dryRun) return { candidates: prevus.length, updated: 0, samples: prevus.slice(0, 5) };

  const now = Date.now();
  await transaction(async (tx) => {
    // Douze mille comptes à compléter, chacun avec SON adresse : une mise à jour par
    // compte ferait douze mille allers-retours. Un « CASE id WHEN … THEN … » traite
    // cinq cents comptes d'un coup, et la règle de l'adresse reste écrite en
    // JavaScript — un seul endroit où elle peut être lue et corrigée.
    const PAQUET = 500;
    for (let i = 0; i < prevus.length; i += PAQUET) {
      const lot = prevus.slice(i, i + PAQUET);
      const cas = lot.map(() => 'WHEN ? THEN ?').join(' ');
      const trous = lot.map(() => '?').join(', ');
      await tx.prepare(`UPDATE cf_accounts SET email = CASE id ${cas} END, updated_at = ? WHERE id IN (${trous})`).run(
        ...lot.flatMap((c) => [c.id, c.email]),
        now,
        ...lot.map((c) => c.id),
      );
    }
  });
  return { candidates: prevus.length, updated: prevus.length, samples: prevus.slice(0, 5) };
}

/** Ce que la base contient aujourd'hui, pour l'afficher sans tout relire. */
export async function cloudflareStats() {
  const un = async (sql) => Number((await prepare(sql).get())?.n ?? 0);
  const [accounts, accountsWithEmail, accountsWithToken, zones, zonesWithId, lastImport] = await Promise.all([
    un('SELECT COUNT(*) AS n FROM cf_accounts'),
    un("SELECT COUNT(*) AS n FROM cf_accounts WHERE email <> ''"),
    un("SELECT COUNT(*) AS n FROM cf_accounts WHERE api_token <> ''"),
    un('SELECT COUNT(*) AS n FROM cf_zones'),
    un("SELECT COUNT(*) AS n FROM cf_zones WHERE zone_id <> ''"),
    prepare('SELECT at, source, rows_read, accounts_added, zones_added, skipped FROM cf_imports ORDER BY at DESC LIMIT 1').get(),
  ]);
  return { accounts, accountsWithEmail, accountsWithToken, zones, zonesWithId, lastImport: lastImport ?? null };
}

/**
 * Lit une saisie libre de domaines, telle que l'agent la colle.
 *
 * Un domaine par ligne. Une ligne peut porter ses propres accès, séparés par des
 * points-virgules, pour un domaine que la base ne connaît pas encore :
 *
 *     exemple.com
 *     exemple.com;<account_id>;<clé globale>
 *     exemple.com;<account_id>;<clé globale>;<zone_id>
 *
 * Les virgules et les tabulations séparent aussi bien que les retours à la ligne : on
 * accepte ce qui vient d'un tableur comme ce qui vient d'une liste.
 *
 * @returns {{ entries: {domain, accountId, key, zoneId}[], invalid: {line, raw, reason}[] }}
 */
export function parseDomainInput(text) {
  const entries = [];
  const invalid = [];
  const vues = new Set();
  const lignes = String(text ?? '').split(/[\r\n,\t]+/);

  lignes.forEach((brut, i) => {
    const ligne = brut.trim();
    if (!ligne || ligne.startsWith('#')) return;

    const parts = ligne.split(';').map((p) => p.trim());
    const domain = normalizeDomain(parts[0]);
    if (!domain) {
      invalid.push({ line: i + 1, raw: parts[0].slice(0, 80), reason: 'errors.cf_domain_invalid' });
      return;
    }
    // Un doublon n'est pas une erreur : on l'ignore, et l'agent n'a rien à corriger.
    if (vues.has(domain)) return;
    vues.add(domain);

    const accountId = vide(parts[1]);
    const secret = vide(parts[2]);
    const zoneId = vide(parts[3]);
    entries.push({
      domain,
      accountId: ID_RE.test(accountId) ? accountId : '',
      key: GLOBAL_KEY_RE.test(secret) ? secret : '',
      token: !GLOBAL_KEY_RE.test(secret) && TOKEN_RE.test(secret) ? secret : '',
      zoneId: ID_RE.test(zoneId) ? zoneId : '',
    });
  });

  return { entries, invalid };
}
