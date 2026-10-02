import { AppError } from '../errors.js';
import { isValidDomain, shq } from '../ssh/shell.js';

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
 * CE QUI SUIT EST UN FREIN, ET IL A ÉTÉ PAYÉ CHER.
 *
 * Le 02/10/2026, une mesure de 300 sites à dix sondes en parallèle a fait passer la
 * charge moyenne de vps-001 de 6 à 138 sur 8 cœurs : 1 276 connexions ouvertes,
 * 653 processus php-fpm, et de vrais visiteurs servis en 8,8 s au lieu de 2. La machine
 * est revenue d'elle-même en quatre minutes, sans dégât — mais la leçon est acquise.
 *
 * LA CAUSE N'EST PAS LE NOMBRE DE SONDES SIMULTANÉES, c'est le nombre de sites NOUVEAUX
 * touchés par minute. Chaque site a son propre pool php-fpm, endormi la plupart du
 * temps ; la première requête doit le réveiller, et ce réveil coûte bien plus que la page
 * elle-même. Réveiller 5 246 pools en 80 secondes revient à démarrer 5 246 interpréteurs
 * d'un coup.
 *
 * Le même travail étalé sur une demi-heure ne prend qu'une fraction de la machine. D'où
 * ces trois garde-fous, et non un seul :
 *
 *   1. peu de sondes à la fois (`PARALLELE_DEFAUT`) ;
 *   2. un débit visé (`SITES_PAR_SECONDE`) : un lot plus rapide attend avant de rendre ;
 *   3. un plafond de charge (`CHARGE_MAX`) : au-dessus, le lot patiente, et s'il patiente
 *      trop longtemps il renonce en le DISANT plutôt que d'ajouter à la peine.
 */
export const PARALLELE_DEFAUT = 2;

/** Le débit visé, par serveur. 3/s : les 5 246 sites d'une machine en une demi-heure. */
export const SITES_PAR_SECONDE = 3;

/**
 * Charge moyenne par cœur au-delà de laquelle on n'ajoute rien.
 *
 * Les machines du parc vivent entre 0,7 et 1,5 par cœur en temps normal (mesuré : 6 à 11
 * sur 8 cœurs). À 2 par cœur elles servent déjà mal ; une analyse n'a aucune raison
 * d'aggraver cela.
 */
export const CHARGE_MAX = 2;

/**
 * LA MARGE, ET POURQUOI LE PLAFOND NE PEUT PAS ÊTRE UN NOMBRE FIXE.
 *
 * Mesure du 02/10/2026 : au repos, vps-002 affiche déjà 1,78 par cœur et vps-001 entre
 * 0,75 et 1,4. Un plafond fixe à 2 serait franchi avant la première sonde sur l'une et
 * jamais atteint sur l'autre — il ne protégerait ni l'une ni l'autre.
 *
 * Le frein se cale donc sur ce que la machine fait D'HABITUDE : la première charge vue
 * sur un serveur devient sa référence, et l'analyse s'autorise cette référence plus la
 * marge ci-dessous. Une machine déjà à la peine est ménagée ; une machine tranquille
 * n'est pas bridée pour rien.
 */
export const MARGE_CHARGE = 0.75;

/** Combien de temps un lot accepte d'attendre que la machine se calme, en millisecondes. */
export const ATTENTE_MAX = 120000;

/**
 * Le temps laissé à une page.
 *
 * Quinze secondes, c'était trop : une sonde qui patiente immobilise le pool du site tout
 * ce temps, et le site était de toute façon à signaler. Huit secondes suffisent à trancher.
 */
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
});

/** Les états qui demandent un geste, du plus grave au plus bénin. */
export const ETATS_GRAVES = ['unreachable', 'no_answer', 'server_error', 'php_error', 'empty', 'missing', 'refused', 'slow', 'redirect', 'invalid'];

/** Un site sondé n'est « sain » que s'il n'a rien à signaler. */
export const estSain = (state) => state === 'ok';

export class HealthService {
  constructor(ssh) {
    this.ssh = ssh;
    // Ce que chaque machine fait quand on ne lui demande rien. Rempli au premier lot, et
    // perdu au redémarrage — ce qui n'est pas grave : il sera remesuré.
    this.repos = new Map();
  }

  /**
   * Le plafond propre à une machine : son train de vie habituel, plus la marge.
   *
   * Tant qu'aucune référence n'a été prise, c'est `CHARGE_MAX` qui sert — la première
   * lecture de charge l'établira, et c'est elle qui comptera ensuite.
   */
  #plafond(serverId) {
    const repos = this.repos.get(serverId);
    return repos === undefined ? CHARGE_MAX : Math.min(4, repos + MARGE_CHARGE);
  }

  /**
   * La charge de la machine, ramenée au nombre de cœurs.
   *
   * Une charge de 8 ne veut rien dire seule : elle est confortable sur 16 cœurs et
   * critique sur 2. C'est le rapport qui compte, et c'est lui qui est rendu.
   */
  async charge(serverId) {
    const { stdout } = await this.ssh.exec(serverId, "awk '{print $1}' /proc/loadavg; nproc", { timeout: 30000 });
    const [load, cores] = String(stdout).trim().split(/\s+/);
    const coeurs = Number(cores) || 1;
    const valeur = Number(load) || 0;
    return { load: valeur, cores: coeurs, parCoeur: valeur / coeurs };
  }

  /**
   * Attend que la machine redescende sous le plafond, et renonce plutôt que d'insister.
   *
   * Renoncer n'est pas un échec de l'analyse : c'est un résultat. L'écran affiche « le
   * serveur était trop chargé », l'agent recommence plus tard, et aucun site n'a été
   * déclaré en panne à tort.
   */
  async #attendre(serverId, { plafond, attenteMax }) {
    const debut = Date.now();
    let vue = await this.charge(serverId);
    // La toute première lecture sur un serveur fait référence : c'est son état au repos,
    // avant que nos sondes n'y aient rien ajouté.
    if (!this.repos.has(serverId)) {
      this.repos.set(serverId, vue.parCoeur);
      plafond = Math.min(4, vue.parCoeur + MARGE_CHARGE);
    }
    while (vue.parCoeur > plafond) {
      if (Date.now() - debut >= attenteMax) {
        throw new AppError('errors.health_server_busy', {
          status: 503,
          vars: { server: this.ssh.server(serverId).label ?? serverId, load: vue.load.toFixed(2), cores: String(vue.cores) },
        });
      }
      await new Promise((r) => setTimeout(r, 5000));
      vue = await this.charge(serverId);
    }
    return vue;
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

    if (sondables.length) {
      charge = await this.#attendre(serverId, { plafond: loadCeiling ?? this.#plafond(serverId), attenteMax: maxWait });

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

      const vus = new Map(lignes.filter((l) => l.domain !== TEMOIN).map((l) => [l.domain, l]));
      for (const domain of sondables) {
        const row = vus.get(domain);
        const retouche = retouches.get(domain) ?? { modifiedAt: null, modifiedFile: null };
        // Une sonde dont la ligne manque n'est pas un site sain : elle est dite perdue.
        if (!row) sites.push({ ...VIDE, ...retouche, domain, state: 'no_answer' });
        else sites.push({ ...row, ...retouche, scheme: protocole(row), state: verdict(row, { slow, minBytes }) });
      }

      // LE FREIN. Un lot trop rapide attend : c'est le débit qui protège la machine, et
      // non le nombre de sondes simultanées.
      const reste = Math.ceil((sondables.length / Math.max(0.1, rate)) * 1000) - (Date.now() - debut);
      if (reste > 0) await new Promise((r) => setTimeout(r, Math.min(reste, 120000)));
    }

    return { sites, summary: resume(sites), load: charge };
  }
}

/** Le compte par état, pour que l'écran n'ait pas à le refaire. */
export function resume(sites) {
  const par = {};
  for (const s of sites ?? []) par[s.state] = (par[s.state] ?? 0) + 1;
  const total = (sites ?? []).length;
  const ok = par.ok ?? 0;
  return { total, ok, problems: total - ok, byState: par };
}
