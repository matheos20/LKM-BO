import { AppError } from '../errors.js';
import { isValidDomain, shq } from '../ssh/shell.js';
import { PRESSION_MAX, ServerLoad } from './serverLoad.js';

/**
 * Scanner 404 : quelles adresses sont mortes, sur quels sites.
 *
 * L'agent arrive avec une liste d'adresses — celles que la Search Console lui signale, ou
 * celles d'un ancien plan de site — et une sélection de domaines. Chaque adresse est
 * demandée sur chaque domaine, depuis le serveur lui-même, et rien n'est modifié.
 *
 * CE QUI REND CE SCAN MOINS SIMPLE QU'IL N'Y PARAÎT, mesuré le 05/10/2026 sur vps-004 :
 *
 *   - une adresse en « .php » qui n'existe pas rend bien 404 (16 à 17 ko : la page
 *     d'erreur habillée du site, ou 162 octets pour les rares sites sans `404.php`) ;
 *   - MAIS UNE ADRESSE SANS EXTENSION REND 200, avec la page d'accueil. Vérifié sur onze
 *     sites de deux serveurs : `/lkm-absent-sans-extension` renvoie 40 à 64 ko — la taille
 *     de l'accueil — et le titre de l'accueil. La page n'existe pas, et pourtant le
 *     serveur affirme que tout va bien. C'est un « faux 404 », et c'est le pire cas : ni
 *     le visiteur ni Google ne voient d'erreur, mais personne ne trouve la page cherchée ;
 *   - le lien canonique ne permet PAS de le démasquer : le moteur y recopie le chemin
 *     demandé. `/lkm-absent-sans-extension` se déclare canonique de lui-même. Ce qui
 *     distingue, c'est le TITRE : celui de l'accueil quand la page est absente, celui de
 *     la page quand elle existe, « page not found » sur un vrai 404.
 *
 * D'où la mécanique : l'accueil de chaque domaine est sondé en premier, son titre sert de
 * référence, et toute adresse qui rend 200 avec ce même titre est un faux 404.
 *
 * LE FREIN est celui de `serverLoad.js`, partagé avec la santé du parc. Il se compte en
 * DOMAINES et non en requêtes : mesuré, une adresse de plus sur un domaine déjà visité
 * coûte 0,029 s contre 0,050 s pour un domaine neuf sur une machine saine, et 0,004 s
 * contre 4,4 s sur une machine saturée. C'est le premier contact avec un site qui coûte.
 */

export const PORT_DEFAUT = 8080;

/** Peu de sondes à la fois : c'est le frein de `serverLoad.js` qui commande. */
export const PARALLELE_DEFAUT = 3;

/** Le débit visé, compté en DOMAINES par seconde — voir l'explication ci-dessus. */
export const DOMAINES_PAR_SECONDE = 3;

/** Le temps laissé à une adresse. Au-delà, le site était de toute façon à signaler. */
export const DELAI_SONDE = 8;

/** Combien d'adresses l'agent peut tester d'un coup. */
export const MAX_CHEMINS = 50;

/**
 * Une adresse acceptable.
 *
 * Le refus des blancs et des guillemets n'est pas cosmétique : ce chemin part dans une URL
 * composée par un shell. Il arrive en paramètre, donc rien ne peut s'en échapper, mais une
 * adresse qui contient un saut de ligne n'est de toute façon pas une adresse.
 */
export function cheminValide(c) {
  const v = String(c ?? '');
  if (!v.startsWith('/') || v.length > 1024) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000- \u007f"'\\]/.test(v);
}

/**
 * Ce que l'agent a collé, ramené à des chemins.
 *
 * IL COLLE CE QU'IL A SOUS LA MAIN, et ce qu'il a sous la main vient de la Search Console :
 * des adresses complètes. Seule la partie après le domaine nous intéresse — c'est la
 * sélection de domaines qui décide où tester. Un chemin nu passe tel quel.
 */
export function normalizePaths(brut, { max = MAX_CHEMINS } = {}) {
  const vus = new Set();
  const chemins = [];
  const refuses = [];
  for (const ligne of String(brut ?? '').split(/[\r\n,;]+/)) {
    const t = ligne.trim();
    if (!t) continue;
    let chemin = t;
    const complet = /^https?:\/\/[^/]+(\/.*)?$/i.exec(t);
    if (complet) chemin = complet[1] ?? '/';
    else if (!chemin.startsWith('/')) chemin = `/${chemin}`;
    // Le fragment ne voyage jamais jusqu'au serveur : le garder ferait tester une adresse
    // qui n'existe pas telle quelle.
    chemin = chemin.replace(/#.*$/, '');
    if (!cheminValide(chemin)) {
      refuses.push(t.slice(0, 120));
      continue;
    }
    if (vus.has(chemin) || chemins.length >= max) continue;
    vus.add(chemin);
    chemins.push(chemin);
  }
  return { paths: chemins, rejected: refuses };
}

/**
 * Le dépouillement, en un passage et sans garder la page en mémoire.
 *
 * Le titre est ce qui démasque un faux 404 ; il est donc lu, tronqué, et débarrassé de ses
 * tabulations — c'est une tabulation qui sépare les champs.
 */
export const AWK = [
  'index($0, "@@LKM@@") == 1 { m = $0; next }',
  '{ l = tolower($0)',
  '  if (l ~ /fatal error|parse error|uncaught (exception|error)|call to undefined|database error/) e++',
  '  if (titre == "" && match(l, /<title>[^<]*/)) titre = substr(l, RSTART + 7, RLENGTH - 7) }',
  'END { if (m == "") m = "@@LKM@@\\t000\\t0\\t0\\t"',
  '      sub(/^@@LKM@@\\t/, "", m)',
  '      gsub(/[\\t\\r]/, " ", titre)',
  '      print d "\\t" p "\\t" m "\\t" (e + 0) "\\t" substr(titre, 1, 160) }',
].join('\n');

const FORMAT = '\\n@@LKM@@\\t%{http_code}\\t%{time_total}\\t%{size_download}\\t%{redirect_url}\\n';

/**
 * La commande envoyée au serveur.
 *
 * Le domaine arrive en `"$1"` et le chemin en `"$2"` : ni l'un ni l'autre n'est recopié
 * dans le texte de la commande. C'est ce qui ferme l'injection, et non la seule validation
 * en amont — les deux sont faites quand même.
 */
export function probeCommand(pairs, { port = PORT_DEFAUT, parallel = PARALLELE_DEFAUT, timeout = DELAI_SONDE } = {}) {
  const sonde =
    `curl -s --max-time ${timeout} -H "Host: $1" "http://127.0.0.1:${port}$2" -w "${FORMAT}" 2>/dev/null` +
    ' | awk -v d="$1" -v p="$2" "$LKM_AWK"';
  const plat = pairs.flatMap(({ domain, path }) => [domain, path]);
  return [
    `export LKM_AWK=${shq(AWK)}`,
    `printf '%s\\n' ${plat.map(shq).join(' ')} | xargs -P ${parallel} -n 2 bash -c ${shq(sonde)} _`,
  ].join('\n');
}

/** Une ligne par adresse sondée. */
export function parseProbe(stdout) {
  const out = [];
  for (const brut of String(stdout ?? '').split('\n')) {
    const p = brut.replace(/\r/g, '').split('\t');
    if (p.length < 7) continue;
    const [domain, path, code, time, bytes, redirect, errors, title] = p;
    if (!domain || !path) continue;
    out.push({
      domain,
      path,
      code: Number(code) || 0,
      time: Number(time) || 0,
      bytes: Number(bytes) || 0,
      redirect: redirect || null,
      phpErrors: Number(errors) || 0,
      title: (title ?? '').trim() || null,
    });
  }
  return out;
}

/**
 * LES AUTRES NOMS DE LA PAGE D'ACCUEIL.
 *
 * `/index.php` EST l'accueil : nginx le sert pour `/`. Il a donc légitimement le titre de
 * l'accueil, et la règle du faux 404 le condamnait — vérifié sur cinq sites de vps-004, il
 * ressortait « page absente » alors qu'il va parfaitement bien. Demander `/index.php`,
 * c'est vouloir l'accueil ; demander `/ancien-catalogue/produit-retire` et le recevoir,
 * non.
 */
const ACCUEIL = new Set(['/', '/index.php']);

/**
 * Le verdict d'une adresse, et le seul endroit où il se décide.
 *
 * `accueil` est ce que la page d'accueil du MÊME domaine a rendu : c'est la référence qui
 * permet de distinguer une page absente d'une page servie. Sans elle, un faux 404 passe
 * pour une adresse en bon état.
 */
export function verdict(row, accueil = null) {
  if (!row.code) return 'unreachable';
  if (row.code >= 500) return 'server_error';
  if (row.code === 404 || row.code === 410) return 'missing';
  if (row.code >= 400) return 'refused';
  // Déjà redirigée : c'est une bonne nouvelle, et il ne faut surtout pas en proposer une
  // seconde par-dessus.
  if (row.code >= 300) return 'redirect';
  if (row.phpErrors > 0) return 'php_error';
  // LE FAUX 404. La page d'accueil a été servie à la place de l'adresse demandée : le
  // serveur répond 200, et pourtant la page n'existe pas. Le titre le prouve.
  if (!ACCUEIL.has(row.path) && accueil?.title && row.title && row.title === accueil.title) return 'soft_missing';
  return 'ok';
}

/** Les états, du plus urgent au plus anodin : c'est l'ordre d'affichage. */
export const ORDRE = ['missing', 'soft_missing', 'server_error', 'php_error', 'unreachable', 'no_answer', 'refused', 'redirect', 'ok'];

/** Ce qui mérite une redirection 301 : une adresse morte, d'une façon ou d'une autre. */
export const A_REDIRIGER = ['missing', 'soft_missing'];

/** Une adresse sur laquelle on n'a rien pu mesurer. */
const VIDE = Object.freeze({ code: 0, time: 0, bytes: 0, redirect: null, phpErrors: 0, title: null });

export class UrlCheckService {
  constructor(ssh, load = new ServerLoad(ssh)) {
    this.ssh = ssh;
    this.load = load;
  }

  /**
   * Teste des adresses sur des domaines. Lecture seule, de bout en bout.
   *
   * L'ACCUEIL DE CHAQUE DOMAINE EST SONDÉ EN PREMIER, et ce n'est pas un gaspillage :
   * c'est lui qui donne la référence permettant de démasquer un faux 404, et il ne coûte
   * presque rien puisque c'est de toute façon la première visite au site. Son résultat est
   * rendu avec les autres quand l'agent l'a demandé, et tenu à part sinon.
   */
  async check(
    serverId,
    domains,
    paths,
    { port, parallel = PARALLELE_DEFAUT, rate = DOMAINES_PAR_SECONDE, loadCeiling = null, ioCeiling = PRESSION_MAX, maxWait } = {},
  ) {
    const server = this.ssh.server(serverId);
    const sites = [...new Set((Array.isArray(domains) ? domains : []).map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean))];
    const sondables = sites.filter((d) => isValidDomain(d));
    const demandes = [...new Set((Array.isArray(paths) ? paths : []).filter((p) => cheminValide(p)))].slice(0, MAX_CHEMINS);

    if (!sondables.length) throw new AppError('errors.health_no_target', { status: 400 });
    if (!demandes.length) throw new AppError('errors.urls_none', { status: 400 });

    const charge = await this.load.attendre(serverId, { plafond: loadCeiling, pression: ioCeiling, attenteMax: maxWait });
    const debut = Date.now();

    // L'accueil d'abord, puis les adresses demandées. L'ordre dans la liste n'engage rien —
    // `xargs` les répartit — mais l'accueil doit être DANS le même lot pour servir de
    // référence sans une seconde visite au serveur.
    const veutAccueil = demandes.includes('/');
    const aSonder = [];
    for (const domain of sondables) {
      aSonder.push({ domain, path: '/' });
      for (const path of demandes) if (path !== '/') aSonder.push({ domain, path });
    }

    const utilise = port ?? server.httpPort ?? PORT_DEFAUT;
    const limite = Math.min(600000, 60000 + Math.ceil((aSonder.length / parallel) * DELAI_SONDE * 1000));
    const { stdout } = await this.ssh.exec(serverId, probeCommand(aSonder, { port: utilise, parallel }), { timeout: limite });
    const lignes = parseProbe(stdout);

    // Les accueils, mis de côté : ils sont la référence de leur domaine.
    const accueils = new Map();
    for (const l of lignes) if (l.path === '/') accueils.set(l.domain, l);

    // AUCUN ACCUEIL N'A RÉPONDU : c'est la sonde qui est en panne, pas les adresses. Mieux
    // vaut le dire que déclarer mortes des pages qui vont bien.
    if (!accueils.size) {
      throw new AppError('errors.health_probe_unreachable', {
        status: 502,
        vars: { server: server.label ?? serverId, port: String(utilise) },
      });
    }

    const vues = new Map(lignes.map((l) => [`${l.domain}\t${l.path}`, l]));
    const urls = [];
    for (const domain of sondables) {
      const accueil = accueils.get(domain) ?? null;
      for (const path of demandes) {
        if (path === '/' && !veutAccueil) continue;
        const row = vues.get(`${domain}\t${path}`);
        if (!row) urls.push({ ...VIDE, domain, path, state: 'no_answer' });
        else urls.push({ ...row, state: verdict(row, accueil) });
      }
    }

    // LE FREIN, compté en domaines : c'est le premier contact avec un site qui coûte, pas
    // l'adresse suivante sur le même site.
    const reste = Math.ceil((sondables.length / Math.max(0.1, rate)) * 1000) - (Date.now() - debut);
    if (reste > 0) await new Promise((r) => setTimeout(r, Math.min(reste, 120000)));

    return { urls, summary: resume(urls), load: charge };
  }
}

/** Le compte par état, et ce qui pourrait être redirigé. */
export function resume(urls) {
  const par = {};
  for (const u of urls ?? []) par[u.state] = (par[u.state] ?? 0) + 1;
  const total = (urls ?? []).length;
  const morts = A_REDIRIGER.reduce((n, etat) => n + (par[etat] ?? 0), 0);
  return {
    total,
    ok: par.ok ?? 0,
    missing: morts,
    // Les sites distincts touchés : « 12 adresses mortes » ne dit pas la même chose selon
    // qu'elles sont sur un site ou sur douze.
    domains: new Set((urls ?? []).map((u) => u.domain)).size,
    byState: par,
  };
}
