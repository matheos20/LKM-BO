import { AppError } from '../errors.js';
import { getThematique, listThematiques } from '../db/thematiques.js';
import { isValidDomain } from '../ssh/shell.js';
import { CATEGORY_DETAILS } from './phpScripts.js';
import { PRESSION_MAX, ServerLoad } from './serverLoad.js';
import { THEME_APPLY, THEME_BACKUPS, THEME_RESTORE } from './themeScripts.js';

/**
 * Le changement de thématique d'un site : analyser, poser, revenir.
 *
 * TROIS CHOSES SE PASSENT DANS CET ORDRE, et l'ordre est tout :
 *
 *   1. L'ANALYSE lit le site tel qu'il est — ses rubriques, leurs articles, la thématique
 *      qu'il porte déjà — et chiffre ce qu'un changement ferait. Elle n'écrit rien ;
 *   2. LA POSE sauvegarde d'abord, remue les dossiers ensuite, et n'écrit `config.php`
 *      qu'en dernier, par le circuit de publication du back-office ;
 *   3. SI `config.php` RÉSISTE, LA POSE EST ANNULÉE. C'est le point le plus important de
 *      ce service : un site dont les dossiers ont changé mais pas la configuration est
 *      dans un état que personne n'a voulu. La restauration est alors lancée seule, sans
 *      attendre qu'un agent s'en aperçoive.
 *
 * CE QU'UN CHANGEMENT DE THÉMATIQUE NE TOUCHE PAS : les textes du site. Mesuré le
 * 05/10/2026 sur 80 sites de vps-004 — treize sites d'une même thématique avaient treize
 * `meta_description` différentes, treize accroches différentes, treize titres différents.
 * Ces textes sont l'identité éditoriale de chaque site ; les réécrire d'après la
 * thématique les détruirait tous. L'analyse le dit, pour que l'agent sache qu'il restera
 * la page d'accueil à reprendre dans l'éditeur.
 */

/** Au-delà, on ne traite pas : une demande plus large est une erreur de manipulation. */
const MAX_DOMAINS = 150;
const TIMEOUT = 300000;

/** Ce que `validateConfig` accepte dans `config.php` — et non ce que la base peut stocker. */
const MAX_ICON = 16;
const MAX_DESCRIPTION = 300;

/** L'horodatage d'une sauvegarde : « 20261005-143000 ». */
const STAMP_RE = /^\d{8}-\d{6}$/;

/** L'horodatage du moment, dans la forme que le script serveur attend. */
export function stampMaintenant(date = new Date()) {
  const d = (n, l = 2) => String(n).padStart(l, '0');
  return `${date.getUTCFullYear()}${d(date.getUTCMonth() + 1)}${d(date.getUTCDate())}-${d(date.getUTCHours())}${d(date.getUTCMinutes())}${d(date.getUTCSeconds())}`;
}

/** La signature d'un jeu de rubriques : les adresses, triées, pour comparer deux menus. */
export const signature = (slugs) => [...new Set((slugs ?? []).map((s) => String(s)))].sort().join(',');

/**
 * Reconnaît la thématique d'un site à son jeu de rubriques.
 *
 * Mesuré sur 250 sites de vps-004 : 167 portaient EXACTEMENT le menu d'une thématique
 * connue. La correspondance est donc exacte, et non approchée : un site dont le menu a
 * été bricolé ne doit pas être étiqueté « SANTE » à 80 % — l'agent préférera savoir
 * qu'on ne le reconnaît pas.
 */
export function reconnaitre(slugs, thematiques) {
  const sig = signature(slugs);
  if (!sig) return null;
  return thematiques.find((t) => signature(t.rubriques.map((r) => r.slug)) === sig) ?? null;
}

/**
 * Ce qu'un changement ferait sur un site, calculé ici et non sur le serveur.
 *
 * Le script serveur refait ce calcul avant d'écrire : c'est lui qui fait foi au moment de
 * la pose. Celui-ci sert à MONTRER, et il est en JavaScript pour être éprouvé sans
 * serveur ni PHP.
 */
export function diff(actuelles, voulues) {
  const avant = (actuelles ?? []).map((r) => r.slug);
  const apres = (voulues ?? []).map((r) => r.slug);
  const created = apres.filter((s) => !avant.includes(s));
  const dropped = avant.filter((s) => !apres.includes(s));
  const kept = avant.filter((s) => apres.includes(s));
  // CE QUE LE CHANGEMENT REND INACCESSIBLE : les articles des rubriques qui quittent le
  // menu. Ils restent sur le disque, mais plus rien n'y mène depuis le site.
  const orphansBySlug = {};
  let orphans = 0;
  for (const r of actuelles ?? []) {
    if (!dropped.includes(r.slug)) continue;
    const n = Number(r.articles) || 0;
    if (n) orphansBySlug[r.slug] = n;
    orphans += n;
  }
  return { created, dropped, kept, orphans, orphansBySlug };
}

export class ThemeService {
  constructor(ssh, sites, load = new ServerLoad(ssh)) {
    this.ssh = ssh;
    this.sites = sites;
    this.load = load;
  }

  /** Les domaines d'une demande, nettoyés et bornés. */
  #domaines(domains) {
    const liste = [...new Set((Array.isArray(domains) ? domains : []).map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean))];
    const bons = liste.filter((d) => isValidDomain(d));
    if (!bons.length) throw new AppError('errors.theme_no_target', { status: 400 });
    if (bons.length > MAX_DOMAINS) throw new AppError('errors.translate_batch_too_big', { status: 400, vars: { max: MAX_DOMAINS } });
    return bons;
  }

  /** La thématique visée, menu compris. */
  async #thematique(id) {
    const them = await getThematique(id);
    if (!them) throw new AppError('errors.theme_unknown', { status: 404, vars: { id: String(id).slice(0, 12) } });
    if (!them.rubriques.length) throw new AppError('errors.theme_empty', { status: 400, vars: { domain: them.label } });
    return them;
  }

  /** Le menu tel qu'il partira dans `config.php`, aux bornes de ce fichier. */
  #menu(them) {
    return them.rubriques.map((r) => ({
      slug: r.slug,
      name: r.name,
      icon: String(r.icon ?? '').slice(0, MAX_ICON),
      description: String(r.description ?? '').slice(0, MAX_DESCRIPTION),
    }));
  }

  /**
   * L'ANALYSE PRÉALABLE. Lecture seule, de bout en bout.
   *
   * Elle rend, pour chaque site : ses rubriques actuelles avec leurs articles, la
   * thématique qu'elle y reconnaît, et — si une cible est donnée — ce que le changement
   * créerait, retirerait, et combien d'articles perdraient leur rubrique.
   */
  async analyze(serverId, domains, { thematiqueId = null } = {}) {
    const server = this.ssh.server(serverId);
    const liste = this.#domaines(domains);
    const cible = thematiqueId ? await this.#thematique(thematiqueId) : null;
    const connues = await listThematiques();

    const raw = await this.sites.runPhp(
      serverId,
      server.wwwRoot,
      CATEGORY_DETAILS,
      { LKM_ROOT: server.wwwRoot, LKM_B64: Buffer.from(JSON.stringify(liste), 'utf8').toString('base64') },
      { timeout: TIMEOUT },
    );

    const vus = new Map((raw.sites ?? []).map((s) => [s.domain, s]));
    const sites = liste.map((domain) => {
      const lu = vus.get(domain);
      // Un site qu'on n'a pas pu lire n'est pas un site sans rubrique : on le dit.
      if (!lu) return { domain, error: 'no_answer', current: [], detected: null, articles: 0 };
      if (lu.error) return { domain, error: lu.error, current: [], detected: null, articles: 0 };

      const current = (lu.items ?? []).map((i) => ({
        slug: i.slug,
        name: i.name,
        icon: i.icon ?? '',
        description: i.description ?? '',
        articles: Number(i.articles) || 0,
        dir: Boolean(i.dir),
      }));
      const reconnue = reconnaitre(current.map((c) => c.slug), connues);
      const base = {
        domain,
        error: null,
        name: lu.name ?? '',
        engine: Boolean(lu.engine),
        articles: Number(lu.articles) || 0,
        current,
        detected: reconnue ? { id: reconnue.id, key: reconnue.key, lang: reconnue.lang, label: reconnue.label } : null,
      };
      if (!cible) return base;
      // Déjà sur la thématique visée : l'agent doit le voir avant de lancer quoi que ce soit.
      const dejaLa = reconnue?.id === cible.id;
      return { ...base, ...diff(current, cible.rubriques), already: dejaLa };
    });

    return {
      target: cible ? { id: cible.id, key: cible.key, lang: cible.lang, label: cible.label, rubriques: this.#menu(cible) } : null,
      // Ce qui manque à la thématique visée : une rubrique sans icône laisserait un trou
      // visible sur le site, et l'agent doit le savoir avant de poser.
      incomplete: cible ? cible.rubriques.filter((r) => !r.icon || !r.description).map((r) => r.slug) : [],
      sites,
    };
  }

  /**
   * LA POSE. Sauvegarde, dossiers, puis `config.php` — et retour arrière s'il résiste.
   *
   * `allowOrphans` est une autorisation EXPLICITE, comme la case « Remplacer » des
   * redirections : sans elle, un site dont des articles perdraient leur rubrique est
   * laissé de côté et le dit. Personne ne doit rendre 84 articles inaccessibles par
   * inadvertance.
   */
  async apply(serverId, domains, thematiqueId, userId, { allowOrphans = false, ioCeiling = PRESSION_MAX, maxWait } = {}) {
    const server = this.ssh.server(serverId);
    const liste = this.#domaines(domains);
    const them = await this.#thematique(thematiqueId);
    const menu = this.#menu(them);

    // Une machine à genoux ne reçoit pas d'écriture de plus : le frein est celui que
    // partagent toutes les opérations de masse.
    const charge = await this.load.attendre(serverId, { pression: ioCeiling, attenteMax: maxWait });

    // On regarde d'abord ce qui arriverait, pour écarter ce qu'on ne doit pas toucher.
    const vu = await this.analyze(serverId, liste, { thematiqueId });
    const aFaire = [];
    const sites = [];
    for (const s of vu.sites) {
      if (s.error) { sites.push({ ...s, state: 'error' }); continue; }
      if (!s.engine) { sites.push({ ...s, state: 'error', error: 'engine' }); continue; }
      if (s.already) { sites.push({ ...s, state: 'already' }); continue; }
      if (s.orphans > 0 && !allowOrphans) { sites.push({ ...s, state: 'orphans' }); continue; }
      aFaire.push(s);
    }

    if (aFaire.length) {
      const stamp = stampMaintenant();
      const demande = Object.fromEntries(aFaire.map((s) => [s.domain, menu]));
      const pose = await this.sites.runPhp(
        serverId,
        server.wwwRoot,
        THEME_APPLY,
        {
          LKM_ROOT: server.wwwRoot,
          LKM_MODE: 'apply',
          LKM_STAMP: stamp,
          LKM_B64: Buffer.from(JSON.stringify(demande), 'utf8').toString('base64'),
        },
        { timeout: TIMEOUT },
      );

      const parDomaine = new Map((pose.sites ?? []).map((s) => [s.domain, s]));
      for (const s of aFaire) {
        const fait = parDomaine.get(s.domain);
        if (!fait || fait.error) {
          sites.push({ ...s, state: 'error', error: fait?.error ?? 'no_answer' });
          continue;
        }

        // config.php EN DERNIER, par le circuit de publication : sauvegardé, contrôlé par
        // « php -l », relu après écriture, et restauré tout seul en cas d'écart.
        try {
          const { stamp: configStamp } = await this.sites.setCategories(serverId, s.domain, menu, userId);
          sites.push({ ...s, ...this.#issue(fait), state: 'done', stamp: fait.stamp, configStamp });
        } catch (err) {
          // LE RETOUR ARRIÈRE. Les dossiers ont changé, la configuration non : le site
          // est dans un état que personne n'a voulu. On revient, sans attendre qu'un
          // agent s'en aperçoive.
          const retour = await this.restore(serverId, s.domain, fait.stamp, userId).catch((e) => ({ error: e.key ?? e.message }));
          sites.push({
            ...s,
            ...this.#issue(fait),
            state: 'rolled_back',
            error: err.key ?? err.message,
            rollback: retour?.error ? { ok: false, error: retour.error } : { ok: true },
          });
        }
      }
    }

    // L'ordre de la demande est conservé : l'agent retrouve sa liste.
    const rang = new Map(liste.map((d, i) => [d, i]));
    sites.sort((a, b) => (rang.get(a.domain) ?? 0) - (rang.get(b.domain) ?? 0));
    return { target: vu.target, incomplete: vu.incomplete, load: charge, sites };
  }

  /** Ce que le script a réellement fait, repris tel quel. */
  #issue(fait) {
    return {
      created: fait.created ?? [],
      dropped: fait.dropped ?? [],
      kept: fait.kept ?? [],
      orphans: Number(fait.orphans) || 0,
      orphansBySlug: fait.orphansBySlug ?? {},
      saved: fait.saved ?? [],
      done: fait.done ?? [],
      failed: fait.failed ?? [],
    };
  }

  /** Les sauvegardes de thématique disponibles, par site. Lecture seule. */
  async backups(serverId, domains) {
    const server = this.ssh.server(serverId);
    const liste = this.#domaines(domains);
    const raw = await this.sites.runPhp(
      serverId,
      server.wwwRoot,
      THEME_BACKUPS,
      { LKM_ROOT: server.wwwRoot, LKM_B64: Buffer.from(JSON.stringify(liste), 'utf8').toString('base64') },
      { timeout: TIMEOUT },
    );
    return { sites: raw.sites ?? [] };
  }

  /**
   * LA RESTAURATION. Remet un site dans l'état où la sauvegarde l'a trouvé.
   *
   * Un seul site à la fois, et c'est voulu : revenir en arrière est un geste qu'on fait
   * en regardant, pas en masse. Le script ne devine rien — tout vient du manifeste — et
   * il refuse une sauvegarde incomplète AVANT de toucher à quoi que ce soit.
   */
  async restore(serverId, domain, stamp, userId) {
    const server = this.ssh.server(serverId);
    const d = String(domain ?? '').trim().toLowerCase();
    const s = String(stamp ?? '').trim();
    if (!isValidDomain(d)) throw new AppError('errors.domain_invalid', { status: 400, vars: { domain: d.slice(0, 80) } });
    if (!STAMP_RE.test(s)) throw new AppError('errors.theme_backup_unknown', { status: 400, vars: { stamp: s.slice(0, 20) } });

    const raw = await this.sites.runPhp(
      serverId,
      server.wwwRoot,
      THEME_RESTORE,
      { LKM_ROOT: server.wwwRoot, LKM_DOMAIN: d, LKM_STAMP: s },
      { timeout: TIMEOUT },
    );
    if (raw?.error) {
      throw new AppError(`errors.theme_restore_${raw.error}`, { status: 400, vars: { domain: d, stamp: s, detail: String(raw.detail ?? '').slice(0, 200) } });
    }
    // Rien à invalider : `readSite` relit le serveur à chaque appel, il n'y a pas de
    // cache de configuration à périmer. Vérifié avant de l'écrire.
    void userId;
    return {
      domain: d,
      stamp: s,
      restored: raw?.restored ?? [],
      removed: raw?.removed ?? [],
      kept: raw?.kept ?? [],
      failed: raw?.failed ?? [],
      before: raw?.before ?? [],
      after: raw?.after ?? [],
    };
  }
}
