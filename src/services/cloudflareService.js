/**
 * Le module Cloudflare vu par l'application : la base d'un côté, l'API de l'autre.
 *
 * C'est ici que les accès sont assemblés, et nulle part ailleurs. Une clé ne quitte
 * jamais ce fichier : les routes reçoivent des résultats, jamais des secrets, et rien
 * de ce qui est rendu au navigateur ne contient de quoi se faire passer pour le
 * titulaire d'un compte.
 */
import { config } from '../config.js';
import { prepare } from '../db/mysql.js';
import { parseDomainInput } from './cloudflareImport.js';
import { AppError } from '../errors.js';
import { redact } from './cloudflareClient.js';
import {
  createDnsRecord, deleteDnsRecord, findZoneByName, getSettings, getZone, listDnsRecords,
  purgeCache, purgeMany, setAlwaysUseHttps, setAlwaysUseHttpsMany, setAutoMinify,
  setBrowserCacheTtl, setDevelopmentMode, setSecurityLevel, setSslMode, setSslModeMany,
  updateDnsRecord,
} from './cloudflareOps.js';

/**
 * Borne une valeur venue de l'API à la taille de sa colonne.
 *
 * Depuis que la base refuse les valeurs trop longues au lieu de les tronquer, ce qui
 * arrive de l'extérieur doit être taillé avant d'entrer. Ici, perdre la fin d'un libellé
 * d'offre n'a aucune conséquence — contrairement à un nom de domaine, qui n'est jamais
 * tronqué puisqu'il sert de clé.
 */
const borne = (v, max) => String(v ?? '').slice(0, max);

/** Les réglages que l'écran sait montrer et changer, dans cet ordre. */
export const EXPOSED_SETTINGS = [
  'ssl', 'always_use_https', 'development_mode', 'security_level',
  'browser_cache_ttl', 'minify', 'min_tls_version', 'http3', 'brotli', 'websockets',
];

export class CloudflareService {
  /** Une zone et ses accès, prêts à servir. Lève si quelque chose manque. */
  async #cible(domain) {
    const nom = String(domain ?? '').trim().toLowerCase();
    const ligne = await prepare(
      `SELECT z.domain, z.zone_id, a.account_id, a.email, a.global_api_key, a.api_token
       FROM cf_zones z JOIN cf_accounts a ON a.id = z.account_ref WHERE z.domain = ?`,
    ).get(nom);

    if (!ligne) throw new AppError('errors.cf_unknown_domain', { status: 404, vars: { domain: nom } });
    if (!ligne.api_token && !ligne.global_api_key) throw new AppError('errors.cf_no_access', { status: 400, vars: { domain: nom } });
    if (!ligne.api_token && !ligne.email) throw new AppError('errors.cf_no_email', { status: 400, vars: { domain: nom } });

    return {
      domain: ligne.domain,
      zoneId: ligne.zone_id,
      accountId: ligne.account_id,
      creds: ligne.api_token ? { apiToken: ligne.api_token } : { globalApiKey: ligne.global_api_key, email: ligne.email },
    };
  }

  /** Comme `#cible`, mais retrouve l'identifiant de zone s'il manque ou s'il est faux. */
  async #cibleSure(domain) {
    const cible = await this.#cible(domain);
    if (cible.zoneId) return cible;
    const trouvee = await findZoneByName(cible.domain, cible.creds);
    if (!trouvee?.id) throw new AppError('errors.cf_zone_not_found', { status: 404, vars: { domain: cible.domain } });
    await prepare('UPDATE cf_zones SET zone_id = ?, updated_at = ? WHERE domain = ?').run(trouvee.id, Date.now(), cible.domain);
    return { ...cible, zoneId: trouvee.id };
  }

  /** Plusieurs cibles d'un coup : ce qui est prêt, et ce qui ne l'est pas, avec le motif. */
  async targets(domains) {
    const pretes = [];
    const skipped = [];
    for (const d of domains ?? []) {
      try {
        const c = await this.#cible(d);
        if (!c.zoneId) { skipped.push({ domain: c.domain, reason: 'errors.cf_zone_unknown' }); continue; }
        pretes.push(c);
      } catch (err) {
        skipped.push({ domain: String(d).toLowerCase(), reason: err.key ?? 'errors.cf_no_access' });
      }
    }
    return { targets: pretes, skipped };
  }

  // ───────────────────────────── Lecture ─────────────────────────────

  /** L'inventaire, filtré et paginé : c'est la liste que l'écran affiche. */
  async list({ search = '', status = '', page = 1, perPage = 50 } = {}) {
    const ou = [];
    const args = [];
    const q = String(search ?? '').trim().toLowerCase();
    // Les jokers de LIKE sont neutralisés : un agent qui tape « % » cherche un
    // pourcentage dans un nom de domaine, il ne demande pas les 38 000 lignes.
    // MySQL refuse ESCAPE '\\' : le caractère d'échappement est donc « ! ».
    if (q) { ou.push("z.domain LIKE ? ESCAPE '!'"); args.push(`%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`); }
    if (status === 'ready') ou.push("z.zone_id <> '' AND (a.api_token <> '' OR a.email <> '')");
    if (status === 'blocked') ou.push("(z.zone_id = '' OR (a.api_token = '' AND a.email = ''))");
    const where = ou.length ? `WHERE ${ou.join(' AND ')}` : '';

    const taille = Math.min(200, Math.max(1, Number(perPage) || 50));
    const numero = Math.max(1, Number(page) || 1);
    const total = Number((await prepare(`SELECT COUNT(*) AS total FROM cf_zones z JOIN cf_accounts a ON a.id = z.account_ref ${where}`).get(...args)).total);

    // LIMIT et OFFSET sont écrits dans le texte, pas liés : MySQL refuse un paramètre à
    // cette place. Les deux valeurs sont passées par Number() juste au-dessus — un
    // nombre ne peut rien injecter.
    const lignes = await prepare(
      `SELECT z.domain, z.zone_id, z.status, z.plan, z.ssl_mode, z.always_https, z.checked_at,
              a.account_id, a.email, a.api_token, a.global_api_key, a.last_error
       FROM cf_zones z JOIN cf_accounts a ON a.id = z.account_ref
       ${where} ORDER BY z.domain LIMIT ${taille} OFFSET ${(numero - 1) * taille}`,
    ).all(...args);

    return {
      total,
      page: numero,
      perPage: taille,
      pages: Math.max(1, Math.ceil(total / taille)),
      // AUCUNE CLÉ NE SORT D'ICI : on dit seulement s'il y en a une, et de quelle sorte.
      // Les identifiants de compte et de zone, eux, ne sont pas des secrets — ce sont
      // des références que l'agent recopie dans d'autres outils.
      zones: lignes.map((l) => ({
        domain: l.domain,
        zoneId: l.zone_id || null,
        accountId: l.account_id,
        email: l.email || null,
        auth: l.api_token ? 'token' : l.global_api_key ? 'key' : 'none',
        ready: Boolean(l.zone_id && (l.api_token || l.email)),
        status: l.status || null,
        plan: l.plan || null,
        sslMode: l.ssl_mode || null,
        alwaysHttps: l.always_https == null ? null : Boolean(l.always_https),
        checkedAt: l.checked_at ?? null,
        lastError: l.last_error ? redact(l.last_error) : null,
      })),
    };
  }

  /**
   * Retrouve une LISTE de domaines d'un coup.
   *
   * L'agent a ses listes ailleurs — un tableur, un courriel, une autre console — et
   * chercher cinquante domaines un par un dans un champ de recherche n'a pas de sens.
   * Il les colle, et il obtient ceux qui existent, plus ceux qui manquent à l'appel :
   * un domaine absent de la réponse doit se voir, sinon on croit avoir tout traité.
   *
   * La requête est découpée en paquets : une liste collée peut compter des milliers de
   * lignes, et un ordre SQL n'accepte pas un nombre illimité de paramètres.
   */
  async lookup(domains) {
    const { entries, invalid } = parseDomainInput(Array.isArray(domains) ? domains.join('\n') : String(domains ?? ''));
    const demandes = entries.map((e) => e.domain);
    if (!demandes.length) return { zones: [], missing: [], invalid, requested: 0 };

    const trouvees = new Map();
    const PAQUET = 400;
    for (let i = 0; i < demandes.length; i += PAQUET) {
      const lot = demandes.slice(i, i + PAQUET);
      const trous = lot.map(() => '?').join(',');
      const lignes = await prepare(
        `SELECT z.domain, z.zone_id, z.status, z.plan, z.ssl_mode, z.always_https, z.checked_at,
                a.account_id, a.email, a.api_token, a.global_api_key, a.last_error
         FROM cf_zones z JOIN cf_accounts a ON a.id = z.account_ref
         WHERE z.domain IN (${trous})`,
      ).all(...lot);
      for (const l of lignes) trouvees.set(l.domain, l);
    }

    // L'ordre de la saisie est conservé : l'agent retrouve sa liste telle qu'il l'a
    // collée, et peut la comparer ligne à ligne.
    const zones = [];
    const missing = [];
    for (const d of demandes) {
      const l = trouvees.get(d);
      if (!l) { missing.push(d); continue; }
      zones.push({
        domain: l.domain,
        zoneId: l.zone_id || null,
        accountId: l.account_id,
        email: l.email || null,
        auth: l.api_token ? 'token' : l.global_api_key ? 'key' : 'none',
        ready: Boolean(l.zone_id && (l.api_token || l.email)),
        status: l.status || null,
        plan: l.plan || null,
        sslMode: l.ssl_mode || null,
        alwaysHttps: l.always_https == null ? null : Boolean(l.always_https),
        checkedAt: l.checked_at ?? null,
        lastError: l.last_error ? redact(l.last_error) : null,
      });
    }
    return { zones, missing, invalid, requested: demandes.length + invalid.length };
  }

  async stats() {
    const un = async (sql) => Number((await prepare(sql).get())?.n ?? 0);
    // Les six comptages partent ENSEMBLE : ils ne dépendent pas les uns des autres, et
    // le groupe de connexions sait les mener de front. Six attentes à la file
    // multiplieraient par six le temps d'affichage de l'écran.
    const [accounts, zones, ready, withoutZone, withoutEmail, lastImport] = await Promise.all([
      un('SELECT COUNT(*) AS n FROM cf_accounts'),
      un('SELECT COUNT(*) AS n FROM cf_zones'),
      un("SELECT COUNT(*) AS n FROM cf_zones z JOIN cf_accounts a ON a.id = z.account_ref WHERE z.zone_id <> '' AND (a.api_token <> '' OR a.email <> '')"),
      un("SELECT COUNT(*) AS n FROM cf_zones WHERE zone_id = ''"),
      un("SELECT COUNT(*) AS n FROM cf_accounts WHERE email = '' AND api_token = ''"),
      prepare('SELECT at, source, rows_read, zones_added, skipped FROM cf_imports ORDER BY at DESC LIMIT 1').get(),
    ]);
    return {
      accounts,
      zones,
      ready,
      withoutZone,
      withoutEmail,
      lastImport: lastImport ?? null,
      emailDomain: config.cloudflare.emailDomain,
    };
  }

  /** Le détail d'un domaine : l'état de la zone, ses réglages, son DNS. */
  async detail(domain) {
    const cible = await this.#cibleSure(domain);
    const [zone, settings, dns] = await Promise.all([
      getZone(cible.zoneId, cible.creds),
      getSettings(cible.zoneId, cible.creds),
      listDnsRecords(cible.zoneId, cible.creds).catch(() => []),
    ]);

    // Ce qu'on vient d'apprendre est gardé, pour que la liste le montre sans rappeler l'API.
    //
    // Ces valeurs viennent de l'EXTÉRIEUR : rien ne garantit qu'un libellé d'offre ou
    // une liste de serveurs de noms tiendra dans sa colonne. Depuis que la base est en
    // mode strict, une valeur trop longue fait échouer la requête au lieu d'être
    // tronquée — et faire échouer l'affichage d'une zone parce que Cloudflare a rallongé
    // un libellé serait absurde. On borne donc ici, où le sens est connu.
    await prepare(
      `UPDATE cf_zones SET status = ?, plan = ?, name_servers = ?, ssl_mode = ?, always_https = ?, checked_at = ?, updated_at = ? WHERE domain = ?`,
    ).run(
      borne(zone.status, 30),
      borne(zone.plan, 60),
      borne((zone.nameServers ?? []).join(' '), 400),
      borne(settings.ssl, 20),
      settings.always_use_https === 'on' ? 1 : 0,
      Date.now(),
      Date.now(),
      cible.domain,
    );

    const exposes = {};
    for (const k of EXPOSED_SETTINGS) if (settings[k] !== undefined) exposes[k] = settings[k];
    return { domain: cible.domain, zone, settings: exposes, dns };
  }

  // ───────────────────────────── Écriture ─────────────────────────────

  /** Change un réglage d'une zone. Le nom du réglage est contrôlé, pas interprété. */
  async updateSetting(domain, setting, value) {
    const cible = await this.#cibleSure(domain);
    const creds = cible.creds;
    switch (setting) {
      case 'ssl': return setSslMode(cible.zoneId, value, creds);
      case 'always_use_https': return setAlwaysUseHttps(cible.zoneId, value === true || value === 'on', creds);
      case 'development_mode': return setDevelopmentMode(cible.zoneId, value === true || value === 'on', creds);
      case 'security_level': return setSecurityLevel(cible.zoneId, value, creds);
      case 'browser_cache_ttl': return setBrowserCacheTtl(cible.zoneId, value, creds);
      case 'minify': return setAutoMinify(cible.zoneId, value ?? {}, creds);
      default: throw new AppError('errors.cf_unknown_setting', { status: 400, vars: { setting: String(setting).slice(0, 40) } });
    }
  }

  purge(domain, options) {
    return this.#cibleSure(domain).then((c) => purgeCache(c.zoneId, options, c.creds));
  }

  async dnsCreate(domain, record) {
    const c = await this.#cibleSure(domain);
    return createDnsRecord(c.zoneId, record, c.creds);
  }

  async dnsUpdate(domain, recordId, record) {
    const c = await this.#cibleSure(domain);
    return updateDnsRecord(c.zoneId, recordId, record, c.creds);
  }

  async dnsDelete(domain, recordId) {
    const c = await this.#cibleSure(domain);
    return deleteDnsRecord(c.zoneId, recordId, c.creds);
  }

  /**
   * Les accès d'un domaine, CLÉ COMPRISE.
   *
   * Cloudflare masque lui-même sa clé globale derrière un bouton : elle ouvre le compte
   * entier, et la voir doit être un geste conscient. Cette méthode n'est donc appelée
   * que par une route qui exige le droit d'écriture et qui journalise la demande — on
   * saura toujours qui a révélé quelle clé, et quand.
   */
  async credentials(domain) {
    const nom = String(domain ?? '').trim().toLowerCase();
    const l = await prepare(
      `SELECT z.domain, z.zone_id, a.account_id, a.email, a.global_api_key, a.api_token
       FROM cf_zones z JOIN cf_accounts a ON a.id = z.account_ref WHERE z.domain = ?`,
    ).get(nom);
    if (!l) throw new AppError('errors.cf_unknown_domain', { status: 404, vars: { domain: nom } });
    return {
      domain: l.domain,
      accountId: l.account_id,
      zoneId: l.zone_id || null,
      email: l.email || null,
      globalApiKey: l.global_api_key || null,
      apiToken: l.api_token || null,
    };
  }

  // ─────────────────────── Opérations de masse ───────────────────────

  /**
   * Purge le cache de plusieurs domaines, saisis librement.
   *
   * Une ligne peut porter ses propres accès : c'est ce qui permet de purger un domaine
   * que la base ne connaît pas encore, sans l'importer d'abord. Quand la ligne n'en
   * porte pas, on prend ceux de la base.
   *
   * Les accès fournis à la volée ne sont PAS enregistrés : une purge est un geste de
   * passage, pas une déclaration de domaine. L'import reste la porte d'entrée.
   */
  async purgeFromInput(text, { everything = true, files = [] } = {}) {
    const { entries, invalid } = parseDomainInput(text);
    const cibles = [];
    const skipped = invalid.map((i) => ({ domain: i.raw, reason: i.reason, ok: false }));

    for (const e of entries) {
      // Les accès collés avec le domaine l'emportent : l'agent sait ce qu'il fait.
      if (e.accountId && (e.key || e.token) && e.zoneId) {
        cibles.push({ domain: e.domain, zoneId: e.zoneId, creds: e.token ? { apiToken: e.token } : { globalApiKey: e.key, email: `${e.domain}@${config.cloudflare.emailDomain}` } });
        continue;
      }
      try {
        const c = await this.#cibleSure(e.domain);
        cibles.push(c);
      } catch (err) {
        skipped.push({ domain: e.domain, reason: err.key ?? 'errors.cf_no_access', ok: false });
      }
    }

    const out = cibles.length
      ? await purgeMany(cibles, everything ? { everything: true } : { files }, { concurrency: config.cloudflare.concurrency })
      : { total: 0, succeeded: 0, failed: 0, results: [] };

    return { ...out, skipped, requested: entries.length + invalid.length };
  }

  /**
   * Une opération sur plusieurs domaines.
   *
   * Les domaines inutilisables sont écartés ICI, avant tout appel : ils n'entament pas
   * le quota et figurent dans le relevé avec leur motif. L'appelant obtient le sort de
   * chaque domaine, réussite comme échec.
   */
  async bulk(kind, domains, options = {}) {
    const { targets, skipped } = await this.targets(domains);
    const batch = { concurrency: config.cloudflare.concurrency };

    let out;
    if (!targets.length) out = { total: 0, succeeded: 0, failed: 0, results: [] };
    else if (kind === 'purge') out = await purgeMany(targets, options, batch);
    else if (kind === 'ssl') out = await setSslModeMany(targets, options.mode, batch);
    else if (kind === 'https') out = await setAlwaysUseHttpsMany(targets, options.enabled === true, batch);
    else throw new AppError('errors.cf_unknown_bulk', { status: 400, vars: { kind: String(kind).slice(0, 40) } });

    return {
      ...out,
      skipped: skipped.map((s) => ({ ...s, ok: false })),
      requested: (domains ?? []).length,
    };
  }
}
