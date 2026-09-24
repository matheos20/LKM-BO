import { AppError } from '../errors.js';
import { CATEGORY_FILES, CATEGORY_LIST } from './phpScripts.js';

/**
 * Ajout de rubriques aux sites du parc.
 *
 * Une rubrique tient en trois pièces, et c'est la raison d'être de ce service : à la
 * main, il en manque toujours une.
 *
 *   1. le dossier `<slug>/index.php` qui la sert ;
 *   2. l'entrée dans `$categories` de `config.php` ;
 *   3. la ligne dans `wp_summary.json`, que lit la synchronisation WordPress.
 *
 * Deux principes tenus ici :
 *
 *   - VÉRIFIER AVANT D'ÉCRIRE. Le plan est une lecture seule qui dit, pièce par pièce,
 *     ce qui existe déjà et ce qui sera créé. L'agent le lit avant de décider.
 *   - LE PLUS FRAGILE EN DERNIER, PAR LE CHEMIN LE PLUS SÛR. Les dossiers et le JSON
 *     passent par un script serveur ; `config.php`, lui, emprunte le circuit de
 *     publication du back-office — reconstruit, validé, sauvegardé, contrôlé par
 *     `php -l`, relu après écriture et restauré tout seul en cas d'écart.
 *
 * L'ordre compte : dossiers d'abord, configuration ensuite. Un dossier sans entrée de
 * configuration ne dérange personne ; l'inverse afficherait au menu une rubrique qui
 * mène à une page inexistante.
 */

const MAX_DOMAINS = 150;
/** Lire les rubriques de tout un parc n'aurait pas de sens : on travaille sur un échantillon. */
const MAX_LIST = 60;
/** Une adresse de rubrique telle que le moteur du site la sert. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,60}$/;
const MAX_CATEGORIES = 12;
const TIMEOUT = 180000;

/** Nom de rubrique → adresse : « Vie quotidienne » donne « /vie-quotidienne/ ». */
export function slugify(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[’']/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Nettoie ce que l'écran envoie : noms vides, doublons de slug, limites. */
export function normalizeRequest(request) {
  const out = {};
  for (const [rawDomain, rubriques] of Object.entries(request ?? {})) {
    const domain = String(rawDomain ?? '').trim().toLowerCase();
    if (!domain || !Array.isArray(rubriques)) continue;
    const vues = new Set();
    const liste = [];
    for (const r of rubriques) {
      const name = String(r?.name ?? '').trim().slice(0, 120);
      // Une clé déjà valide passe telle quelle : elle vient d'une rubrique lue sur le
      // serveur, et la re-slugifier la ferait rater sa cible. « Finance &amp; real
      // estate » vit sous « finance-real-estate » ; slugify(nom) donnerait
      // « finance-amp-real-estate », qui ne désigne rien.
      const fourni = String(r?.slug ?? '').trim();
      const slug = SLUG.test(fourni) ? fourni : slugify(fourni || name);
      if (!name || !slug || vues.has(slug) || liste.length >= MAX_CATEGORIES) continue;
      vues.add(slug);
      liste.push({ slug, name });
    }
    if (liste.length) out[domain] = liste;
  }
  return out;
}

export class CategoryService {
  constructor(ssh, sites) {
    this.ssh = ssh;
    this.sites = sites;
  }

  /**
   * Les rubriques en place sur des sites donnés — lecture seule.
   *
   * C'est ce qui permet à l'agent de supprimer une rubrique qu'il n'a pas créée :
   * il la choisit dans la liste au lieu d'en deviner le nom exact.
   */
  async existing(serverId, domains) {
    const server = this.ssh.server(serverId);
    const liste = [
      ...new Set(
        (Array.isArray(domains) ? domains : [])
          .map((d) => String(d ?? '').trim().toLowerCase())
          .filter((d) => /^[a-z0-9][a-z0-9.-]{1,252}$/.test(d)),
      ),
    ];
    if (!liste.length) throw new AppError('errors.category_none', { status: 400 });

    const echantillon = liste.slice(0, MAX_LIST);
    const raw = await this.sites.runPhp(
      serverId,
      server.wwwRoot,
      CATEGORY_LIST,
      { LKM_ROOT: server.wwwRoot, LKM_B64: Buffer.from(JSON.stringify(echantillon), 'utf8').toString('base64') },
      { timeout: TIMEOUT },
    );

    const sites = (raw.sites ?? []).map((s) => ({ domain: s.domain, error: s.error ?? null, items: s.items ?? [] }));

    // L'union : une rubrique vue sur plusieurs sites ne se coche qu'une fois, et
    // l'agent voit du même coup combien de sites et combien d'articles elle engage.
    const union = new Map();
    for (const site of sites) {
      for (const it of site.items) {
        const vu = union.get(it.slug) ?? { slug: it.slug, name: it.name, sites: 0, articles: 0 };
        vu.sites += 1;
        vu.articles += it.articles;
        union.set(it.slug, vu);
      }
    }

    return {
      scanned: echantillon.length,
      total: liste.length,
      sites,
      union: [...union.values()].sort((a, b) => b.sites - a.sites || a.slug.localeCompare(b.slug)),
    };
  }

  /** Lecture seule : ce qui existe déjà, ce qui serait créé ou retiré. */
  plan(serverId, request, { operation = 'add' } = {}) {
    return this.#run(serverId, request, 'scan', operation);
  }

  /**
   * Écriture. Les dossiers et `wp_summary.json` d'abord, par le script serveur ;
   * puis `config.php` de chaque site, un par un, par le circuit de publication.
   */
  async apply(serverId, request, userId, { operation = 'add' } = {}) {
    const demande = normalizeRequest(request);
    return operation === 'remove' ? this.#remove(serverId, demande, userId) : this.#add(serverId, demande, userId);
  }

  /** Création : dossiers et résumé d'abord, entrée de menu ensuite. */
  async #add(serverId, demande, userId) {
    const out = await this.#run(serverId, demande, 'apply', 'add');
    for (const site of out.sites) {
      if (site.error) continue;
      // Ne sont déclarées que les rubriques dont le dossier existe : une entrée de
      // configuration sans dossier mènerait le visiteur sur une page inexistante.
      const aDeclarer = site.items.filter((it) => it.dir && !it.config);
      if (!aDeclarer.length) continue;
      try {
        const res = await this.sites.addCategories(serverId, site.domain, aDeclarer, userId);
        site.stamp = res.stamp;
        for (const it of site.items) {
          if (res.added.includes(it.slug)) {
            it.config = true;
            it.done.push('config');
          }
        }
      } catch (err) {
        site.configError = err.key ?? err.message;
        for (const it of aDeclarer) it.failed.push('config');
      }
    }
    return out;
  }

  /**
   * Suppression : l'ordre inverse de la création.
   *
   * L'entrée de menu part EN PREMIER. Une rubrique encore au menu dont la page a
   * disparu donne un lien mort, visible de tous ; l'inverse — une page que plus rien
   * n'annonce — ne dérange personne le temps de la seconde écriture.
   */
  async #remove(serverId, demande, userId) {
    const prevu = await this.#run(serverId, demande, 'scan', 'remove');
    const retires = new Map();

    for (const site of prevu.sites) {
      if (site.error) continue;
      const slugs = site.items.filter((it) => it.config).map((it) => it.slug);
      if (!slugs.length) continue;
      try {
        const res = await this.sites.removeCategories(serverId, site.domain, slugs, userId);
        retires.set(site.domain, { stamp: res.stamp, slugs: res.removed });
      } catch (err) {
        retires.set(site.domain, { error: err.key ?? err.message, slugs: [] });
      }
    }

    const out = await this.#run(serverId, demande, 'apply', 'remove');
    for (const site of out.sites) {
      const fait = retires.get(site.domain);
      if (!fait) continue;
      site.stamp = fait.stamp ?? null;
      site.configError = fait.error ?? null;
      for (const it of site.items) {
        if (fait.slugs.includes(it.slug)) it.done.push('config');
        else if (fait.error) it.failed.push('config');
      }
    }
    return out;
  }

  async #run(serverId, request, mode, operation = 'add') {
    const server = this.ssh.server(serverId);
    const demande = normalizeRequest(request);
    const domaines = Object.keys(demande);
    if (!domaines.length) throw new AppError('errors.category_none', { status: 400 });
    if (domaines.length > MAX_DOMAINS) throw new AppError('errors.translate_batch_too_big', { status: 400, vars: { max: MAX_DOMAINS } });

    const raw = await this.sites.runPhp(
      serverId,
      server.wwwRoot,
      CATEGORY_FILES,
      {
        LKM_ROOT: server.wwwRoot,
        LKM_MODE: mode,
        LKM_OP: operation === 'remove' ? 'remove' : 'add',
        LKM_B64: Buffer.from(JSON.stringify(demande), 'utf8').toString('base64'),
      },
      { timeout: TIMEOUT },
    );

    return {
      mode,
      operation,
      sites: (raw.sites ?? []).map((site) => ({
        domain: site.domain,
        error: site.error ?? null,
        // Un site sans wp_summary.json n'est pas un problème : le fichier ne sert
        // qu'à la synchronisation WordPress, la rubrique fonctionne sans lui.
        summary: Boolean(site.summary),
        jsonFailed: Boolean(site.jsonFailed),
        items: site.items ?? [],
      })),
    };
  }
}
