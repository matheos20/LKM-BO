/**
 * Les opérations Cloudflare du back-office.
 *
 * Chacune valide ce qu'elle reçoit AVANT d'appeler l'API : une valeur refusée ici ne
 * consomme pas d'appel, n'entame pas le quota, et donne un message qu'un agent non
 * technique peut lire. Les opérations de masse passent toutes par `runBatch`, qui borne
 * le nombre d'appels simultanés et rend un résultat par domaine, réussite comme échec.
 *
 * Aucune de ces fonctions ne décide seule d'écrire sur un domaine : elles reçoivent la
 * zone et les accès, et l'appelant répond de ce qu'il demande.
 */
import { CloudflareError, cfPaginate, cfRequest, runBatch } from './cloudflareClient.js';

/** Les modes SSL que Cloudflare accepte, du plus ouvert au plus strict. */
export const SSL_MODES = ['off', 'flexible', 'full', 'strict'];

/** Les niveaux de sécurité de Cloudflare. */
export const SECURITY_LEVELS = ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'];

/** Les types d'enregistrement DNS que ce module sait poser. */
export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'];

const refus = (key, message) => {
  const e = new CloudflareError(message, { status: 400 });
  e.key = key;
  throw e;
};

const ID_RE = /^[0-9a-f]{32}$/i;
const assertZone = (zoneId) => {
  if (!ID_RE.test(String(zoneId ?? ''))) refus('errors.cf_zone_invalid', 'identifiant de zone invalide');
  return zoneId;
};

// ───────────────────────────── Lecture ─────────────────────────────

/** L'état d'une zone : nom, état, offre, serveurs de noms. */
export async function getZone(zoneId, creds, opts = {}) {
  const { result } = await cfRequest(`/zones/${assertZone(zoneId)}`, creds, opts);
  return {
    id: result.id,
    name: result.name,
    status: result.status,
    paused: Boolean(result.paused),
    plan: result.plan?.name ?? '',
    accountId: result.account?.id ?? '',
    accountName: result.account?.name ?? '',
    nameServers: result.name_servers ?? [],
  };
}

/** Retrouve une zone par son nom de domaine, quand l'export n'en donne pas l'identifiant. */
export async function findZoneByName(domain, creds, opts = {}) {
  const nom = String(domain ?? '').trim().toLowerCase();
  if (!nom) refus('errors.cf_domain_invalid', 'domaine vide');
  const { result } = await cfRequest(`/zones?name=${encodeURIComponent(nom)}`, creds, opts);
  const zones = Array.isArray(result) ? result : [];
  return zones.length ? { id: zones[0].id, name: zones[0].name, status: zones[0].status } : null;
}

/** Les réglages d'une zone, ramenés à un objet simple. */
export async function getSettings(zoneId, creds, opts = {}) {
  const { result } = await cfRequest(`/zones/${assertZone(zoneId)}/settings`, creds, opts);
  const out = {};
  for (const s of Array.isArray(result) ? result : []) out[s.id] = s.value;
  return out;
}

/** Les enregistrements DNS d'une zone. */
export async function listDnsRecords(zoneId, creds, opts = {}) {
  const records = await cfPaginate(`/zones/${assertZone(zoneId)}/dns_records`, creds, opts);
  return records.map((r) => ({
    id: r.id, type: r.type, name: r.name, content: r.content,
    ttl: r.ttl, proxied: Boolean(r.proxied), priority: r.priority,
  }));
}

// ───────────────────────── Réglages d'une zone ─────────────────────────

const patchSetting = (zoneId, nom, valeur, creds, opts) =>
  cfRequest(`/zones/${assertZone(zoneId)}/settings/${nom}`, creds, { ...opts, method: 'PATCH', body: { value: valeur } });

/**
 * Mode SSL/TLS.
 *
 * « off » laisse le trafic en clair entre le visiteur et Cloudflare : c'est un choix
 * lourd de conséquences, jamais une valeur par défaut. « flexible » chiffre seulement
 * la première moitié du trajet. « full » chiffre tout, « strict » exige en plus un
 * certificat valide à l'origine.
 */
export async function setSslMode(zoneId, mode, creds, opts = {}) {
  const m = String(mode ?? '').toLowerCase();
  if (!SSL_MODES.includes(m)) refus('errors.cf_ssl_mode', `mode SSL inconnu : ${m || '(vide)'}`);
  const { result } = await patchSetting(zoneId, 'ssl', m, creds, opts);
  return { setting: 'ssl', value: result?.value ?? m };
}

/** Redirection automatique de HTTP vers HTTPS. */
export async function setAlwaysUseHttps(zoneId, active, creds, opts = {}) {
  const v = active ? 'on' : 'off';
  const { result } = await patchSetting(zoneId, 'always_use_https', v, creds, opts);
  return { setting: 'always_use_https', value: result?.value ?? v };
}

/**
 * Mode développement : Cloudflare cesse de servir le cache pendant trois heures.
 * Il s'éteint tout seul — d'où l'horodatage rendu, pour pouvoir le dire.
 */
export async function setDevelopmentMode(zoneId, active, creds, opts = {}) {
  const v = active ? 'on' : 'off';
  const { result } = await patchSetting(zoneId, 'development_mode', v, creds, opts);
  return { setting: 'development_mode', value: result?.value ?? v, expiresOn: result?.time_remaining ?? null };
}

/** Niveau de sécurité, de « off » à « under_attack ». */
export async function setSecurityLevel(zoneId, level, creds, opts = {}) {
  const l = String(level ?? '').toLowerCase();
  if (!SECURITY_LEVELS.includes(l)) refus('errors.cf_security_level', `niveau de sécurité inconnu : ${l || '(vide)'}`);
  const { result } = await patchSetting(zoneId, 'security_level', l, creds, opts);
  return { setting: 'security_level', value: result?.value ?? l };
}

/**
 * Minification automatique.
 *
 * Cloudflare a retiré la minification du JavaScript en août 2024 : ne reste que le CSS
 * et le HTML. On envoie les trois clés que l'API attend encore, avec `js` toujours à
 * l'arrêt, plutôt que de promettre un effet qui n'existe plus.
 */
export async function setAutoMinify(zoneId, { css = false, html = false } = {}, creds, opts = {}) {
  const valeur = { css: css ? 'on' : 'off', html: html ? 'on' : 'off', js: 'off' };
  const { result } = await patchSetting(zoneId, 'minify', valeur, creds, opts);
  return { setting: 'minify', value: result?.value ?? valeur };
}

/** Mise en cache du navigateur, en secondes. */
export async function setBrowserCacheTtl(zoneId, seconds, creds, opts = {}) {
  const n = Number(seconds);
  // Les paliers acceptés par Cloudflare ; 0 signifie « respecter l'en-tête d'origine ».
  const PALIERS = [0, 30, 60, 120, 300, 1200, 1800, 3600, 7200, 10800, 14400, 18000, 28800, 43200, 57600, 72000, 86400, 172800, 259200, 345600, 432000, 691200, 1382400, 2073600, 2678400, 5356800, 16070400, 31536000];
  if (!PALIERS.includes(n)) refus('errors.cf_cache_ttl', `durée non acceptée par Cloudflare : ${seconds}`);
  const { result } = await patchSetting(zoneId, 'browser_cache_ttl', n, creds, opts);
  return { setting: 'browser_cache_ttl', value: result?.value ?? n };
}

// ───────────────────────────── Cache ─────────────────────────────

/**
 * Purge du cache d'une zone.
 *
 * Tout purger d'un coup fait repartir le site de zéro : une pointe de charge sur
 * l'origine, et des visiteurs plus lents quelques minutes. Purger des adresses précises
 * est presque toujours préférable, et c'est pourquoi les deux chemins existent ici.
 * Cloudflare accepte trente adresses par appel ; au-delà, on découpe.
 */
export async function purgeCache(zoneId, { everything = false, files = [], tags = [], prefixes = [] } = {}, creds, opts = {}) {
  assertZone(zoneId);
  if (everything) {
    await cfRequest(`/zones/${zoneId}/purge_cache`, creds, { ...opts, method: 'POST', body: { purge_everything: true } });
    return { purged: 'everything', count: null };
  }

  const urls = files.map((f) => String(f).trim()).filter(Boolean);
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u)) refus('errors.cf_purge_url', `une adresse à purger doit être complète : ${u.slice(0, 80)}`);
  }
  if (!urls.length && !tags.length && !prefixes.length) refus('errors.cf_purge_empty', 'rien à purger : aucune adresse, étiquette ni préfixe');

  let envoyes = 0;
  for (let i = 0; i < urls.length; i += 30) {
    await cfRequest(`/zones/${zoneId}/purge_cache`, creds, { ...opts, method: 'POST', body: { files: urls.slice(i, i + 30) } });
    envoyes += Math.min(30, urls.length - i);
  }
  if (tags.length) await cfRequest(`/zones/${zoneId}/purge_cache`, creds, { ...opts, method: 'POST', body: { tags } });
  if (prefixes.length) await cfRequest(`/zones/${zoneId}/purge_cache`, creds, { ...opts, method: 'POST', body: { prefixes } });
  return { purged: 'selection', count: envoyes + tags.length + prefixes.length };
}

// ───────────────────────────── DNS ─────────────────────────────

/** Vérifie un enregistrement avant de l'envoyer, pour ne pas gâcher un appel. */
export function validateDnsRecord({ type, name, content, ttl = 1, proxied = false, priority } = {}) {
  const t = String(type ?? '').toUpperCase();
  if (!DNS_TYPES.includes(t)) refus('errors.cf_dns_type', `type d’enregistrement inconnu : ${type ?? '(vide)'}`);
  const n = String(name ?? '').trim();
  if (!n) refus('errors.cf_dns_name', 'le nom de l’enregistrement est obligatoire');
  const c = String(content ?? '').trim();
  if (!c) refus('errors.cf_dns_content', 'la valeur de l’enregistrement est obligatoire');

  if (t === 'A' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(c)) refus('errors.cf_dns_ipv4', `un enregistrement A attend une adresse IPv4 : ${c}`);
  if (t === 'A' && c.split('.').some((o) => Number(o) > 255)) refus('errors.cf_dns_ipv4', `adresse IPv4 hors limites : ${c}`);
  if (t === 'AAAA' && !/^[0-9a-f:]+$/i.test(c)) refus('errors.cf_dns_ipv6', `un enregistrement AAAA attend une adresse IPv6 : ${c}`);
  if (t === 'MX' && !Number.isFinite(Number(priority))) refus('errors.cf_dns_priority', 'un enregistrement MX exige une priorité');

  // 1 veut dire « automatique ». Sinon, Cloudflare borne entre 60 s et un jour.
  const d = Number(ttl);
  if (d !== 1 && (!Number.isFinite(d) || d < 60 || d > 86400)) refus('errors.cf_dns_ttl', `durée de vie hors limites : ${ttl}`);
  // Seuls A, AAAA et CNAME peuvent passer par le relais de Cloudflare.
  const relais = proxied && ['A', 'AAAA', 'CNAME'].includes(t);

  const record = { type: t, name: n, content: c, ttl: d, proxied: relais };
  if (t === 'MX') record.priority = Number(priority);
  return record;
}

export async function createDnsRecord(zoneId, record, creds, opts = {}) {
  const corps = validateDnsRecord(record);
  const { result } = await cfRequest(`/zones/${assertZone(zoneId)}/dns_records`, creds, { ...opts, method: 'POST', body: corps });
  return { id: result?.id, ...corps };
}

export async function updateDnsRecord(zoneId, recordId, record, creds, opts = {}) {
  if (!recordId) refus('errors.cf_dns_record', 'identifiant d’enregistrement absent');
  const corps = validateDnsRecord(record);
  const { result } = await cfRequest(`/zones/${assertZone(zoneId)}/dns_records/${recordId}`, creds, { ...opts, method: 'PUT', body: corps });
  return { id: result?.id ?? recordId, ...corps };
}

export async function deleteDnsRecord(zoneId, recordId, creds, opts = {}) {
  if (!recordId) refus('errors.cf_dns_record', 'identifiant d’enregistrement absent');
  await cfRequest(`/zones/${assertZone(zoneId)}/dns_records/${recordId}`, creds, { ...opts, method: 'DELETE' });
  return { deleted: recordId };
}

// ─────────────────────── Opérations de masse ───────────────────────

/**
 * Applique une opération à plusieurs domaines.
 *
 * `targets` : [{ domain, zoneId, creds }]. Chaque entrée porte ses propres accès, car
 * dans ce parc presque chaque domaine a son compte Cloudflare. Rien n'est interrompu
 * par un échec : on va au bout, et on rend le détail de chacun.
 */
export async function applyToMany(targets, operation, { concurrency = 6, onItem = null } = {}) {
  const sorties = await runBatch(targets, (cible) => operation(cible), { concurrency, onItem });
  const ok = sorties.filter((s) => s.ok);
  return {
    total: sorties.length,
    succeeded: ok.length,
    failed: sorties.length - ok.length,
    results: sorties.map((s) => ({
      domain: s.item?.domain ?? '',
      ok: s.ok,
      ...(s.ok ? { result: s.result } : { error: s.error, status: s.status, code: s.code }),
    })),
  };
}

// Les raccourcis de masse. `batch.request` passe aux appels : c'est par là qu'un test
// injecte son API simulée, et qu'un appelant règle délais et reprises.
const sansRequest = ({ request, ...reste }) => { void request; return reste; };

/** Purge le cache de plusieurs domaines à la fois. */
export const purgeMany = (targets, options = {}, batch = {}) =>
  applyToMany(targets, ({ zoneId, creds }) => purgeCache(zoneId, options, creds, batch.request ?? {}), sansRequest(batch));

/** Change le mode SSL de plusieurs domaines à la fois. */
export const setSslModeMany = (targets, mode, batch = {}) =>
  applyToMany(targets, ({ zoneId, creds }) => setSslMode(zoneId, mode, creds, batch.request ?? {}), sansRequest(batch));

/** Active ou coupe la redirection HTTPS sur plusieurs domaines à la fois. */
export const setAlwaysUseHttpsMany = (targets, active, batch = {}) =>
  applyToMany(targets, ({ zoneId, creds }) => setAlwaysUseHttps(zoneId, active, creds, batch.request ?? {}), sansRequest(batch));
