/**
 * Client de l'API Cloudflare.
 *
 * Trois exigences, et rien d'autre :
 *
 *   1. AUTHENTIFIER correctement. Cloudflare accepte deux voies. Un jeton d'API se
 *      présente seul, en « Bearer », avec une portée limitée : c'est la bonne. Une clé
 *      globale réclame EN PLUS l'e-mail du titulaire — mesuré sur l'API le 01/10/2026,
 *      elle répond « 9106 Missing X-Auth-Email header » sans lui — et donne un accès
 *      total au compte. L'export du parc ne porte que des clés globales, sans e-mail :
 *      d'où la vérification explicite ci-dessous, plutôt qu'un appel voué à l'échec.
 *
 *   2. NE JAMAIS LAISSER FUIR UN SECRET. Les clés ne sont ni journalisées, ni placées
 *      dans une adresse, ni recopiées dans un message d'erreur. `redact` les efface de
 *      tout ce qui pourrait être affiché.
 *
 *   3. RESPECTER LES LIMITES. Cloudflare autorise 1 200 appels par tranche de cinq
 *      minutes et par compte, et répond 429 au-delà. On attend le délai qu'il indique,
 *      on réessaie les erreurs passagères, et on abandonne sans insister sur celles qui
 *      ne passeront jamais — un mot de passe refusé ne devient pas bon en le répétant.
 */

const BASE = 'https://api.cloudflare.com/client/v4';

/** Efface de tout texte ce qui ressemble à un secret, avant affichage ou journal. */
export function redact(text) {
  return String(text ?? '')
    .replace(/\b[0-9a-f]{37}\b/gi, '«clé masquée»')
    .replace(/\bBearer\s+[A-Za-z0-9_.-]{20,}/gi, 'Bearer «jeton masqué»')
    .replace(/\b[A-Za-z0-9_-]{40}\b/g, '«jeton masqué»');
}

/** Une erreur venue de Cloudflare, porteuse de ce qu'il faut pour décider. */
export class CloudflareError extends Error {
  constructor(message, { status = 0, code = 0, retryable = false, errors = [] } = {}) {
    super(redact(message));
    this.name = 'CloudflareError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.errors = errors;
  }
}

/**
 * Les en-têtes d'authentification, ou une erreur disant ce qui manque.
 * Le jeton l'emporte sur la clé : portée limitée, révocation simple.
 */
export function authHeaders({ apiToken = '', globalApiKey = '', email = '' } = {}) {
  if (apiToken) return { Authorization: `Bearer ${apiToken}` };
  if (globalApiKey) {
    if (!email) {
      throw new CloudflareError('une clé globale exige l’e-mail du compte', { status: 0, code: 9106 });
    }
    return { 'X-Auth-Email': email, 'X-Auth-Key': globalApiKey };
  }
  throw new CloudflareError('aucun accès enregistré pour ce compte', { status: 0, code: 0 });
}

/** Ces codes ne s'arrangeront pas en réessayant : inutile d'insister. */
const DEFINITIFS = new Set([400, 401, 403, 404, 405, 409, 422]);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Un appel à l'API, avec ses reprises.
 *
 * @param {object} creds  { apiToken } ou { globalApiKey, email }
 * @param {object} opts   { method, body, timeout, retries, onRetry, fetchImpl }
 */
export async function cfRequest(path, creds, {
  method = 'GET', body = null, timeout = 20000, retries = 3, onRetry = null, fetchImpl = fetch,
  // Le calcul de l'attente est remplaçable : un test ne doit pas patienter pour de vrai,
  // et une opération de masse peut vouloir être plus patiente qu'un appel isolé.
  backoff = (essai, indiqueMs) => (indiqueMs > 0 ? indiqueMs : Math.min(30000, 1000 * 2 ** essai)),
} = {}) {
  const headers = { 'Content-Type': 'application/json', ...authHeaders(creds) };
  const url = path.startsWith('http') ? path : `${BASE}${path}`;

  let derniere = null;
  for (let essai = 0; essai <= retries; essai += 1) {
    const controleur = new AbortController();
    const minuteur = setTimeout(() => controleur.abort(), timeout);
    try {
      const reponse = await fetchImpl(url, {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
        signal: controleur.signal,
      });
      const texte = await reponse.text();
      let corps = {};
      try { corps = texte ? JSON.parse(texte) : {}; } catch { corps = { raw: texte.slice(0, 400) }; }

      if (reponse.ok && corps.success !== false) {
        return { result: corps.result, resultInfo: corps.result_info ?? null, status: reponse.status };
      }

      const errs = Array.isArray(corps.errors) ? corps.errors : [];
      const premier = errs[0] ?? {};
      const message = premier.message || corps.raw || `réponse ${reponse.status}`;
      const retryable = reponse.status === 429 || (reponse.status >= 500 && reponse.status < 600);
      derniere = new CloudflareError(message, { status: reponse.status, code: premier.code ?? 0, retryable, errors: errs });

      if (!retryable || DEFINITIFS.has(reponse.status) || essai === retries) throw derniere;

      // 429 : Cloudflare dit souvent combien de temps attendre. On l'écoute plutôt que
      // de deviner ; sinon, on double l'attente à chaque essai.
      const indique = Number(reponse.headers.get('retry-after'));
      const attente = backoff(essai, Number.isFinite(indique) && indique > 0 ? indique * 1000 : 0);
      onRetry?.({ attempt: essai + 1, waitMs: attente, status: reponse.status });
      await dormir(attente);
    } catch (err) {
      if (err instanceof CloudflareError) {
        if (!err.retryable || essai === retries) throw err;
        derniere = err;
      } else {
        // Coupure réseau ou délai dépassé : cela peut passer au coup suivant.
        const passager = err.name === 'AbortError' || err.name === 'TypeError' || /fetch|network|ECONN|ETIMEDOUT|ENOTFOUND/i.test(err.message);
        derniere = new CloudflareError(err.name === 'AbortError' ? `délai de ${timeout} ms dépassé` : err.message, { status: 0, retryable: passager });
        if (!passager || essai === retries) throw derniere;
        const attente = backoff(essai, 0);
        onRetry?.({ attempt: essai + 1, waitMs: attente, status: 0 });
        await dormir(attente);
      }
    } finally {
      clearTimeout(minuteur);
    }
  }
  throw derniere ?? new CloudflareError('échec sans réponse');
}

/**
 * Parcourt une collection paginée jusqu'au bout.
 * Cloudflare rend 50 éléments par défaut, 1 000 au plus.
 */
export async function cfPaginate(path, creds, options = {}) {
  const { perPage = 100, max = 10000, ...reste } = options;
  const tout = [];
  for (let page = 1; ; page += 1) {
    const joint = path.includes('?') ? '&' : '?';
    const { result, resultInfo } = await cfRequest(`${path}${joint}page=${page}&per_page=${perPage}`, creds, reste);
    const lot = Array.isArray(result) ? result : [];
    tout.push(...lot);
    const total = resultInfo?.total_pages ?? 1;
    if (page >= total || !lot.length || tout.length >= max) break;
  }
  return tout;
}

/**
 * Exécute un lot d'opérations avec un nombre d'appels simultanés BORNÉ.
 *
 * Purger quarante mille domaines d'un coup saturerait la machine et ferait pleuvoir les
 * 429. Chaque résultat est rendu, réussite comme échec, dans l'ordre d'entrée : une
 * opération de masse doit pouvoir se relire en entier.
 */
export async function runBatch(items, worker, { concurrency = 6, onItem = null } = {}) {
  const sorties = new Array(items.length);
  let curseur = 0;
  const travailleur = async () => {
    for (;;) {
      const i = curseur;
      curseur += 1;
      if (i >= items.length) return;
      const item = items[i];
      try {
        sorties[i] = { item, ok: true, result: await worker(item, i) };
      } catch (err) {
        sorties[i] = { item, ok: false, error: redact(err.message), code: err.code ?? 0, status: err.status ?? 0 };
      }
      onItem?.(sorties[i], i + 1, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, travailleur));
  return sorties;
}
