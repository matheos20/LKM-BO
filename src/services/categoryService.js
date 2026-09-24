import { AppError } from '../errors.js';
import { CATEGORY_FILES } from './phpScripts.js';

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
      const slug = slugify(r?.slug || name);
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

  /** Lecture seule : ce qui existe déjà, ce qui serait créé. */
  plan(serverId, request) {
    return this.#run(serverId, request, 'scan');
  }

  /**
   * Écriture. Les dossiers et `wp_summary.json` d'abord, par le script serveur ;
   * puis `config.php` de chaque site, un par un, par le circuit de publication.
   */
  async apply(serverId, request, userId) {
    const demande = normalizeRequest(request);
    const out = await this.#run(serverId, demande, 'apply');

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

  async #run(serverId, request, mode) {
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
        LKM_B64: Buffer.from(JSON.stringify(demande), 'utf8').toString('base64'),
      },
      { timeout: TIMEOUT },
    );

    return {
      mode,
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
