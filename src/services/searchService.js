/**
 * Recherche globale : « où est ce domaine ? », « à quoi correspond cette adresse ? ».
 *
 * L'agent a une chose en main — un nom de domaine, ou l'adresse complète d'un article
 * copiée depuis son navigateur — et veut savoir sur quel serveur il tombe, sans ouvrir
 * les cinq VPS l'un après l'autre.
 *
 * Tout se passe ici plutôt que dans le navigateur : le parc compte près de 29 000
 * domaines, et les télécharger pour chercher dedans n'aurait pas de sens. Les listes
 * sont déjà en cache côté serveur, la recherche les parcourt.
 *
 * Ce qui est cherché, dans cet ordre :
 *
 *   1. le domaine EXACT — c'est le cas courant, et il doit primer sur toute
 *      ressemblance : taper « biozenz.fr » ne doit pas proposer « biozenz.fr.old » ;
 *   2. l'ARTICLE, quand l'adresse portait un chemin. Il est cherché par son adresse
 *      publique (permalinks.php) puis par son fichier, car une partie du parc n'a pas
 *      de permalinks ;
 *   3. les domaines QUI RESSEMBLENT, pour rattraper une faute de frappe.
 */

const DOMAINE = /^[a-z0-9][a-z0-9.-]{1,252}$/;
const MAX_CANDIDATS = 20;

/**
 * Ce que l'agent a collé, ramené à un domaine et un chemin.
 *
 * On accepte l'adresse entière, avec ou sans protocole, avec ou sans « www. », avec ses
 * paramètres — c'est ce qui sort d'une barre d'adresse, et le lui reprocher serait
 * lui demander de faire le travail de la machine.
 */
export function parseQuery(raw) {
  const brut = String(raw ?? '').trim();
  if (!brut) return { domain: '', path: '' };

  const sansProtocole = brut.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  // Un « / » sépare l'hôte du chemin ; sans « / », tout est l'hôte.
  const coupe = sansProtocole.indexOf('/');
  const hote = (coupe === -1 ? sansProtocole : sansProtocole.slice(0, coupe)).trim();
  const apres = coupe === -1 ? '' : sansProtocole.slice(coupe);

  const domain = hote
    .toLowerCase()
    .replace(/^www\./, '')
    // Un port ou des identifiants collés par le navigateur ne font pas partie du nom.
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '');

  const path = apres
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .trim();

  return { domain, path: path && path !== '/' ? path : '' };
}

/** Les formes sous lesquelles un même article peut être désigné. */
export function pathVariants(path) {
  const p = String(path ?? '').replace(/^\/+/, '');
  if (!p) return [];
  const sansPhp = p.replace(/\.php$/i, '');
  const dernier = p.split('/').pop() ?? '';
  return [...new Set([p, `/${p}`, sansPhp, `/${sansPhp}`, `${sansPhp}.php`, `/${sansPhp}.php`, dernier, dernier.replace(/\.php$/i, '')])].filter(Boolean);
}

/** Compare deux adresses sans se laisser arrêter par un « / » ou un « .php » de plus. */
const memeAdresse = (a, b) => {
  const net = (v) =>
    String(v ?? '')
      .toLowerCase()
      .replace(/^\/+|\/+$/g, '')
      .replace(/\.php$/i, '');
  return net(a) !== '' && net(a) === net(b);
};

export class SearchService {
  constructor(ssh, domains, sites) {
    this.ssh = ssh;
    this.domains = domains;
    this.sites = sites;
  }

  /**
   * @param {string} raw ce que l'agent a tapé ou collé
   * @param {object[]} visibles les serveurs auxquels ce compte a accès
   */
  async find(raw, visibles) {
    const { domain, path } = parseQuery(raw);
    const connectes = visibles.filter((s) => this.ssh.isConnected(s.id));
    const horsLigne = visibles.filter((s) => !this.ssh.isConnected(s.id)).map((s) => ({ id: s.id, label: s.label }));
    const base = { query: String(raw ?? '').trim(), domain, path, offline: horsLigne };

    if (!domain || !DOMAINE.test(domain)) return { ...base, kind: 'invalid', candidates: [] };

    // Les listes déjà en cache : aucune commande SSH n'est lancée pour chercher.
    const listes = await Promise.allSettled(connectes.map((s) => this.domains.list(s.id, {})));

    let exact = null;
    const proches = [];
    listes.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const server = connectes[i];
      for (const item of r.value.items) {
        if (item.name === domain) exact ??= { domain: item.name, server: server.id, serverLabel: server.label, status: item.status };
        else if (proches.length < MAX_CANDIDATS && item.name.includes(domain)) {
          proches.push({ domain: item.name, server: server.id, serverLabel: server.label, status: item.status });
        }
      }
    });

    if (!exact) {
      return { ...base, kind: proches.length ? 'near' : 'unknown', candidates: proches.slice(0, MAX_CANDIDATS) };
    }

    // Sans chemin, la question s'arrête au domaine.
    if (!path) return { ...base, kind: 'domain', site: exact, candidates: proches.slice(0, 5) };

    // Avec un chemin, on va chercher l'article. Une lecture du site suffit : elle est
    // déjà ce que fait l'éditeur en s'ouvrant.
    try {
      const articles = await this.sites.listArticles(exact.server, exact.domain);
      const article =
        articles.find((a) => memeAdresse(a.url, path)) ??
        articles.find((a) => memeAdresse(a.file, path)) ??
        articles.find((a) => pathVariants(path).some((v) => memeAdresse(a.file, v) || memeAdresse(a.url, v))) ??
        null;
      return { ...base, kind: article ? 'article' : 'article_missing', site: exact, article, articleCount: articles.length, candidates: [] };
    } catch (err) {
      // Le domaine est trouvé : c'est déjà la moitié de la réponse, et la dire vaut
      // mieux que de tout perdre parce que la lecture du site a échoué.
      return { ...base, kind: 'domain', site: exact, candidates: [], articleError: err.key ?? err.message };
    }
  }
}
