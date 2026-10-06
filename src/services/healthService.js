import { AppError } from '../errors.js';
import { isValidDomain, shq } from '../ssh/shell.js';
import { ETATS as REPUTATION, ReputationService } from './reputationService.js';
import { ATTENTE_MAX, CHARGE_MAX, MARGE_CHARGE, PRESSION_MAX, ServerLoad } from './serverLoad.js';

/**
 * Santé du parc : un site répond-il, et répond-il correctement ?
 *
 * LA SONDE PART DU SERVEUR, PAS D'ICI, et ce choix vient de quatre mesures faites le
 * 02/10/2026 sur le parc :
 *
 *   1. nginx n'écoute ni sur 80 ni sur 443, mais sur le port 8080, en clair. Ce qui
 *      termine le TLS est en amont — vérifié depuis l'extérieur, les certificats de
 *      `routesvirtuelles.fr`, `vigilcd.org` et `0707a.net` sont émis par Google Trust
 *      Services, c'est-à-dire par Cloudflare. IL N'Y A DONC AUCUN CERTIFICAT À
 *      SURVEILLER sur les machines : Cloudflare les renouvelle seul, et un domaine qui
 *      perdrait le sien serait de toute façon vu comme injoignable par la sonde ;
 *   2. interroger les sites depuis l'extérieur aurait traversé Cloudflare — donc mesuré
 *      le cache plutôt que le site, avec 28 177 requêtes sortantes à la clé. Et la
 *      machine où cette application doit être déployée a ses ports sortants bloqués :
 *      la sonde externe n'y fonctionnerait pas du tout ;
 *   3. les journaux d'nginx auraient donné le même renseignement pour rien — ils
 *      racontent ce que de VRAIS visiteurs ont obtenu. Mais ils appartiennent à
 *      `www-data:adm`, le compte SSH vit dans `tech` et `editors`, et il n'a pas de
 *      sudo : illisibles. À reconsidérer si l'administrateur accorde un jour le groupe
 *      `adm` — ce serait un signal gratuit et plus fidèle que n'importe quelle sonde ;
 *   4. le vhost partagé déduit la racine du site de l'en-tête `Host`. Un domaine
 *      inconnu reçoit le 404 d'nginx lui-même. C'est ce qui permet de distinguer un
 *      site absent d'un site en panne, sans rien lire sur le disque.
 *
 * RIEN N'EST ÉCRIT. La sonde fait une requête GET sur la page d'accueil, comme un
 * visiteur, et ne touche à aucun fichier. Le droit exigé est celui d'analyse.
 */

/** Le port où nginx écoute sur les machines du parc. Mesuré : 8080 sur les cinq. */
export const PORT_DEFAUT = 8080;

/**
 * LE FREIN VIT DANS `serverLoad.js`, et il est partagé.
 *
 * Il y est expliqué, avec les mesures qui l'ont imposé — notamment l'analyse de 300 sites
 * qui a fait passer vps-001 de 6 à 138 de charge moyenne le 02/10/2026. Deux barrières :
 * la charge par cœur, calée sur ce que la machine fait d'habitude, et la pression disque,
 * qui est la vraie contrainte de ce parc.
 *
 * Ne restent ici que les réglages propres à CETTE analyse : combien de sondes à la fois,
 * et à quel rythme.
 */
export const PARALLELE_DEFAUT = 2;

/** Le débit visé, par serveur. 3/s : les 5 246 sites d'une machine en une demi-heure. */
export const SITES_PAR_SECONDE = 3;

// Les seuils du frein restent lisibles depuis ici : c'est par cette analyse qu'on arrive
// à eux, et les renvoyer évite d'avoir à savoir dans quel fichier ils ont été rangés.
export { ATTENTE_MAX, CHARGE_MAX, MARGE_CHARGE, PRESSION_MAX } from './serverLoad.js';

export const DELAI_SONDE = 8;

/**
 * Au-delà, la page est jugée lente.
 *
 * Trois secondes étaient trop peu : sur une machine qui tourne à 1,8 par cœur, une page
 * saine met parfois quatre secondes, et c'est la machine qu'il faut incriminer, pas le
 * site. Deux sites sur 150 étaient signalés à tort. Cinq secondes laissent passer la
 * lenteur ambiante et retiennent la lenteur anormale.
 */
export const SEUIL_LENT = 5;

/**
 * En dessous, la page est jugée vide. Les pages saines mesurées pèsent 45 à 66 ko ;
 * 1 000 octets ne peuvent pas porter une page de ce moteur.
 */
export const SEUIL_VIDE = 1000;

/**
 * Un domaine, et rien d'autre : c'est ce qui partira dans un en-tête `Host`.
 *
 * C'est la règle déjà employée partout ailleurs (`DOMAIN_RE`), et non une seconde écrite
 * pour l'occasion : deux règles qui se veulent identiques finissent par diverger.
 */
const sondable = (d) => isValidDomain(d);

/**
 * Le domaine témoin, envoyé AVANT les autres dans chaque lot.
 *
 * Il n'existe pas et ne doit pas exister : nginx doit lui répondre 404. S'il ne répond
 * rien, c'est la sonde qui est en panne — mauvais port, nginx arrêté — et non les sites.
 * Sans ce témoin, un changement de port ferait déclarer 28 177 sites hors service, et
 * l'agent passerait sa journée à chercher une panne qui n'existe pas.
 */
export const TEMOIN = 'lkm-sonde-sans-site.invalid';

/**
 * Le dépouillement de la réponse, en UN passage et sans garder la page en mémoire.
 *
 * Les signatures cherchées sont celles qu'une page saine ne peut pas contenir par
 * accident. « Warning: » et « Notice: » en sont volontairement absents : ces mots
 * s'écrivent dans un article sans que rien n'aille mal, et un faux signalement coûte
 * plus cher qu'un oubli. Sur 400 sites mesurés, aucune signature forte n'est ressortie.
 */
export const AWK = [
  'index($0, "@@LKM@@") == 1 { m = $0; next }',
  '{ l = tolower($0)',
  '  if (l ~ /fatal error|parse error|uncaught (exception|error)|call to undefined|database error/) e++',
  // L'ADRESSE QUE LE SITE SE DONNE À LUI-MÊME, lue au passage et sans seconde requête :
  // elle est dans la page que la sonde télécharge déjà. C'est elle qui dit si le site se
  // présente en http ou en https — la sonde, qui interroge le port 8080 en clair, ne
  // pourrait pas le deviner. Mesuré sur 100 sites : tous déclarent « https://<domaine>/ ».
  '  if (can == "" && match(l, /rel="?canonical"?[^>]*href="[^"]+"/)) {',
  '    s = substr(l, RSTART, RLENGTH)',
  '    if (match(s, /href="[^"]+"/)) can = substr(s, RSTART + 6, RLENGTH - 7)',
  '  } }',
  'END { if (m == "") m = "@@LKM@@\\t000\\t0\\t0\\t"',
  '      sub(/^@@LKM@@\\t/, "", m)',
  '      print d "\\t" m "\\t" (e + 0) "\\t" can }',
].join('\n');

/**
 * La seconde commande : la dernière retouche du site, LUE SUR LE DISQUE.
 *
 * Elle ne réveille aucun pool php-fpm — c'est de la lecture de répertoires, et rien de
 * plus. Mesuré le 02/10/2026 : 40 sites en 2 s, soit ~4,4 min pour les 5 246 sites d'une
 * machine, contre une demi-heure pour la sonde HTTP. Elle tourne donc même pour les sites
 * qui ne répondent pas — c'est justement là qu'on veut savoir quand ils ont été touchés.
 *
 * LE mtime DU DOSSIER NE SUFFIT PAS, et la liste des domaines ne donne que celui-là :
 * mesuré, 21 sites sur 40 avaient plus d'un jour d'écart entre la date du dossier et celle
 * de son contenu. Un article modifié ne touche pas le dossier qui le contient.
 *
 * Les chemins commençant par un point sont écartés : `.lkm-backups` est notre propre
 * comptabilité, et nginx refuse de les servir de toute façon.
 */
export function touchCommand(root, domains, { parallel = 8 } = {}) {
  const lecture = [
    'p="$LKM_ROOT/$1/public_html"',
    // `find -L` : sur ce parc, un site sur trois est un lien symbolique vers /data/www.
    'r=$(find -L "$p" -name ".*" -prune -o -type f -printf "%T@\\t%P\\n" 2>/dev/null | sort -rn | head -1)',
    'printf "%s\\t%s\\n" "$1" "$r"',
  ].join('; ');
  return [
    `export LKM_ROOT=${shq(root)}`,
    `printf '%s\\n' ${domains.map(shq).join(' ')} | xargs -P ${parallel} -n 1 bash -c ${shq(lecture)} _`,
  ].join('\n');
}

/** Une ligne par site : le fichier le plus récemment modifié, et quand. */
export function parseTouch(stdout) {
  const out = new Map();
  for (const brut of String(stdout ?? '').split('\n')) {
    const p = brut.replace(/\r/g, '').split('\t');
    if (!p[0]) continue;
    const [domain, mtime, chemin] = p;
    const quand = Number(mtime);
    out.set(domain, {
      // Un horodatage absolu, en millisecondes : les serveurs vivent en UTC et l'agent
      // trois heures devant. C'est l'écran qui traduira, pas le serveur.
      modifiedAt: Number.isFinite(quand) && quand > 0 ? Math.round(quand * 1000) : null,
      modifiedFile: chemin || null,
    });
  }
  return out;
}

/** Le format que curl ajoute APRÈS la page, précédé d'un saut de ligne à lui. */
const FORMAT = '\\n@@LKM@@\\t%{http_code}\\t%{time_total}\\t%{size_download}\\t%{redirect_url}\\n';

/**
 * La commande envoyée au serveur.
 *
 * Le domaine arrive à la sonde EN PARAMÈTRE (`"$1"`), jamais recopié dans le texte de la
 * commande : c'est ce qui ferme l'injection, et non la seule validation en amont. Les
 * deux sont faites quand même.
 */
export function probeCommand(domains, { port = PORT_DEFAUT, parallel = PARALLELE_DEFAUT, timeout = DELAI_SONDE } = {}) {
  const sonde =
    `curl -s --max-time ${timeout} -H "Host: $1" "http://127.0.0.1:${port}/" -w "${FORMAT}" 2>/dev/null` +
    ' | awk -v d="$1" "$LKM_AWK"';
  return [
    `export LKM_AWK=${shq(AWK)}`,
    `printf '%s\\n' ${domains.map(shq).join(' ')} | xargs -P ${parallel} -n 1 bash -c ${shq(sonde)} _`,
  ].join('\n');
}

/** Une ligne de sortie par site, dans l'ordre où les sondes ont fini. */
export function parseProbe(stdout) {
  const out = [];
  for (const brut of String(stdout ?? '').split('\n')) {
    const p = brut.replace(/\r/g, '').split('\t');
    if (p.length < 6) continue;
    const [domain, code, time, bytes, redirect, errors, canonical] = p;
    if (!domain) continue;
    out.push({
      domain,
      code: Number(code) || 0,
      time: Number(time) || 0,
      bytes: Number(bytes) || 0,
      redirect: redirect || null,
      phpErrors: Number(errors) || 0,
      canonical: canonical || null,
    });
  }
  return out;
}

/**
 * Un renvoi vers le MÊME site n'est pas une anomalie.
 *
 * Mesuré : `imagedor.com` rend 301 vers `https://www.imagedor.com/`, et c'est voulu — le
 * parc tient une liste de domaines canoniques en « www ». Signaler ces sites aurait noyé
 * les vraies pannes sous des centaines de lignes parfaitement normales.
 */
export function renvoiInterne(domain, redirect) {
  if (!redirect) return false;
  const m = /^https?:\/\/([^/:?#]+)/i.exec(String(redirect));
  if (!m) return false;
  const hote = m[1].toLowerCase().replace(/^www\./, '');
  return hote === String(domain ?? '').toLowerCase().replace(/^www\./, '');
}

/**
 * HTTP OU HTTPS : ce que le site se donne pour adresse.
 *
 * Attention à ce que cela veut dire, et à ce que cela ne veut pas dire. La sonde parle au
 * serveur en clair sur le port 8080 ; elle ne peut donc PAS mesurer ce qu'obtient un
 * visiteur — c'est Cloudflare qui termine le TLS, en amont, pour tout le parc. Ce qui est
 * rendu ici, c'est le protocole que le site écrit dans ses propres liens, et c'est
 * précisément ce qui compte pour les moteurs de recherche : un site qui se déclare en
 * « http:// » envoie ses visiteurs sur une version non sécurisée de lui-même.
 *
 * Deux sources, dans cet ordre : l'adresse canonique de la page, et à défaut la
 * destination d'une redirection — un site canonique en « www » redirige avant de servir
 * une page, il n'y a donc pas d'adresse canonique à lire.
 */
export function protocole(row) {
  const url = row?.canonical || row?.redirect || '';
  const m = /^(https?):\/\//i.exec(String(url));
  return m ? m[1].toLowerCase() : null;
}

/**
 * Le verdict, et le seul endroit où il se décide.
 *
 * L'ordre compte : une page qui rend 500 est en panne même si elle est lente, et un
 * 404 ne dit rien de sa taille. Chaque état a son libellé dans les six langues.
 */
export function verdict(row, { slow = SEUIL_LENT, minBytes = SEUIL_VIDE } = {}) {
  if (!row.code) return 'unreachable';
  if (row.code >= 500) return 'server_error';
  if (row.code === 404) return 'missing';
  if (row.code >= 400) return 'refused';
  // Le passage en « www » ou en https est le comportement attendu du parc, pas un défaut.
  if (row.code >= 300) return renvoiInterne(row.domain, row.redirect) ? 'ok' : 'redirect';
  if (row.phpErrors > 0) return 'php_error';
  if (row.bytes < minBytes) return 'empty';
  if (row.time > slow) return 'slow';
  return 'ok';
}

/**
 * Un site sur lequel on n'a rien pu mesurer.
 *
 * Écrit une seule fois : trois endroits construisaient cet objet à la main, et le jour où
 * un champ s'ajoute, l'un des trois l'oublie — l'écran lit alors `undefined` sans que rien
 * ne le signale.
 */
const VIDE = Object.freeze({
  code: 0,
  time: 0,
  bytes: 0,
  redirect: null,
  phpErrors: 0,
  canonical: null,
  scheme: null,
  modifiedAt: null,
  modifiedFile: null,
  // La réputation est un AXE À PART, et non un état de plus. Un site peut répondre
  // parfaitement et être refusé par le navigateur du visiteur : c'est exactement ce qui
  // est arrivé à `gkmtaxzone.com` le 06/10/2026. Les mélanger aurait forcé à choisir
  // lequel des deux renseignements taire.
  reputation: null,
});

/**
 * Un site signalé est un site à regarder, quel que soit son état par ailleurs.
 *
 * C'est la règle qui répare le défaut constaté : la sonde disait « en ligne », l'écran
 * disait « 0 à regarder », et le navigateur refusait d'ouvrir la page.
 */
export const estSignale = (site) => site?.reputation?.state === REPUTATION.FLAGGED;

/** Les états qui demandent un geste, du plus grave au plus bénin. */
export const ETATS_GRAVES = ['unreachable', 'no_answer', 'server_error', 'php_error', 'empty', 'missing', 'refused', 'slow', 'redirect', 'invalid'];

/** Un site sondé n'est « sain » que s'il n'a rien à signaler. */
export const estSain = (state) => state === 'ok';

export class HealthService {
  /**
   * `load` est le frein, et il se PARTAGE avec les autres analyses de masse : c'est lui
   * qui retient en mémoire le train de vie de chaque machine. Deux services qui auraient
   * chacun le leur apprendraient deux fois la même chose, et la première analyse de la
   * journée se tromperait de référence.
   */
  constructor(ssh, load = new ServerLoad(ssh), reputation = new ReputationService()) {
    this.ssh = ssh;
    this.load = load;
    // La réputation ne touche AUCUNE machine du parc : elle se lit chez Google. Elle est
    // injectée pour que la santé s'éprouve sans réseau.
    this.reputation = reputation;
  }

  /** L'état d'une machine : charge par cœur et pression disque. */
  charge(serverId) {
    return this.load.lire(serverId);
  }

  /**
   * Sonde une liste de sites sur un serveur. Lecture seule, de bout en bout.
   *
   * TROIS CHOSES SE PASSENT AVANT LA PREMIÈRE SONDE, et chacune évite une façon de se
   * tromper :
   *
   *   - la charge est lue : si la machine souffre déjà, le lot patiente ;
   *   - le témoin ouvre le lot. S'il ne répond pas, le lot est refusé TOUT ENTIER —
   *     mieux vaut dire « je n'ai pas pu mesurer » que « tout est en panne » ;
   *   - un nom qui n'est pas un domaine est écarté sans être sondé.
   *
   * Et une après la dernière : si le lot est allé plus vite que le débit visé, il attend
   * la différence. C'est ce qui étale le réveil des pools php-fpm au lieu de le concentrer.
   */
  async scan(
    serverId,
    domains,
    {
      port,
      parallel = PARALLELE_DEFAUT,
      slow = SEUIL_LENT,
      minBytes = SEUIL_VIDE,
      rate = SITES_PAR_SECONDE,
      loadCeiling = null,
      ioCeiling = PRESSION_MAX,
      maxWait = ATTENTE_MAX,
    } = {},
  ) {
    const server = this.ssh.server(serverId);
    const voulus = [...new Set((Array.isArray(domains) ? domains : []).map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean))];
    if (!voulus.length) throw new AppError('errors.health_no_target', { status: 400 });

    const sondables = voulus.filter((d) => sondable(d));
    const refuses = voulus.filter((d) => !sondable(d));
    const sites = refuses.map((domain) => ({ ...VIDE, domain, state: 'invalid' }));
    let charge = null;
    // Vrai dès qu'un verdict de réputation manque à l'appel : l'écran doit pouvoir le
    // dire plutôt que de laisser croire que tout a été vérifié.
    let reputationIncomplete = false;

    if (sondables.length) {
      charge = await this.load.attendre(serverId, { plafond: loadCeiling, pression: ioCeiling, attenteMax: maxWait });

      const debut = Date.now();
      const utilise = port ?? server.httpPort ?? PORT_DEFAUT;
      const cmd = probeCommand([TEMOIN, ...sondables], { port: utilise, parallel });
      // Le temps laissé au lot : ce que les sondes peuvent prendre au pire, plus une marge.
      const limite = Math.min(600000, 60000 + Math.ceil((sondables.length / parallel) * DELAI_SONDE * 1000));
      const { stdout } = await this.ssh.exec(serverId, cmd, { timeout: limite });
      const lignes = parseProbe(stdout);

      const temoin = lignes.find((l) => l.domain === TEMOIN);
      if (!temoin || !temoin.code) {
        throw new AppError('errors.health_probe_unreachable', {
          status: 502,
          vars: { server: server.label ?? serverId, port: String(utilise) },
        });
      }

      // LA DERNIÈRE RETOUCHE, lue sur le disque. Cette seconde commande ne réveille aucun
      // pool php-fpm : elle coûte ~4,4 min pour 5 246 sites, contre une demi-heure pour la
      // sonde. Elle tourne donc pour TOUS les sites du lot, y compris ceux qui n'ont pas
      // répondu — c'est justement là que la question « depuis quand ? » se pose.
      // Un échec de cette lecture ne doit pas emporter l'analyse : la santé du site est le
      // renseignement principal, la date est un supplément.
      let retouches = new Map();
      try {
        const brut = await this.ssh.exec(serverId, touchCommand(server.wwwRoot, sondables), { timeout: 180000 });
        retouches = parseTouch(brut.stdout);
      } catch {
        retouches = new Map();
      }

      // LA RÉPUTATION, lue chez Google et non sur la machine. Ce que la sonde ne peut pas
      // voir : un site qui répond parfaitement peut être refusé par le navigateur du
      // visiteur. Aucun serveur du parc n'est sollicité, et un échec ne doit pas emporter
      // l'analyse — la santé du site reste le renseignement principal.
      let reputations = new Map();
      try {
        const vu = await this.reputation.check(sondables);
        reputations = vu.results;
        reputationIncomplete = vu.interrupted === true;
      } catch {
        reputations = new Map();
        reputationIncomplete = true;
      }

      const vus = new Map(lignes.filter((l) => l.domain !== TEMOIN).map((l) => [l.domain, l]));
      for (const domain of sondables) {
        const row = vus.get(domain);
        const retouche = retouches.get(domain) ?? { modifiedAt: null, modifiedFile: null };
        // Faute de verdict, « non vérifié » — et surtout pas l'absence de verdict, qui se
        // lirait comme un blanc-seing.
        const reputation = reputations.get(domain) ?? { state: REPUTATION.UNCHECKED, code: null, checkedAt: null };
        // Une sonde dont la ligne manque n'est pas un site sain : elle est dite perdue.
        if (!row) sites.push({ ...VIDE, ...retouche, reputation, domain, state: 'no_answer' });
        else sites.push({ ...row, ...retouche, reputation, scheme: protocole(row), state: verdict(row, { slow, minBytes }) });
      }

      // LE FREIN. Un lot trop rapide attend : c'est le débit qui protège la machine, et
      // non le nombre de sondes simultanées.
      const reste = Math.ceil((sondables.length / Math.max(0.1, rate)) * 1000) - (Date.now() - debut);
      if (reste > 0) await new Promise((r) => setTimeout(r, Math.min(reste, 120000)));
    }

    return { sites, summary: resume(sites), load: charge, reputationIncomplete };
  }
}

/** Le compte par état, pour que l'écran n'ait pas à le refaire. */
export function resume(sites) {
  const par = {};
  for (const s of sites ?? []) par[s.state] = (par[s.state] ?? 0) + 1;
  const total = (sites ?? []).length;
  const ok = par.ok ?? 0;
  const signales = (sites ?? []).filter(estSignale).length;
  // « À regarder » compte les sites signalés, MÊME s'ils répondent parfaitement. Sans
  // cela l'écran afficherait « 0 à regarder » sur un site que le navigateur refuse — le
  // défaut exact qui a motivé cette mesure.
  const sains = (sites ?? []).filter((s) => s.state === 'ok' && !estSignale(s)).length;
  return { total, ok, flagged: signales, problems: total - sains, byState: par };
}
