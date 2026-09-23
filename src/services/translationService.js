import { AppError } from '../errors.js';
import { SCAN_LANG } from './phpScripts.js';
import { LANGS, dictionaryLookup, machineTranslate, normalizeLang, pickProvider } from './langTools.js';

/**
 * Traduction des pages d'accueil du parc.
 *
 * Le besoin : sur un parc de plusieurs milliers de sites, quelques pour cent des pages
 * d'accueil gardent un texte dans la langue du modèle d'origine — un slogan français sur
 * un site anglais, une question de FAQ oubliée. Trouver ces textes à la main est
 * impossible ; les corriger par une ligne de commande n'est pas un travail d'agent.
 *
 * Ce service fournit donc deux gestes, et deux seulement :
 *   - ANALYSER un lot de domaines (lecture seule, aucune écriture) ;
 *   - APPLIQUER des remplacements de texte choisis, par le circuit de publication
 *     existant : sauvegarde horodatée, contrôle de syntaxe, relecture après écriture.
 *
 * La traduction proposée vient du dictionnaire du parc, et d'un service automatique si
 * l'un est configuré (DeepL, Claude, Google, LibreTranslate). À défaut, l'agent saisit lui-même
 * le texte : l'interface reste utilisable sans aucun service extérieur.
 */

/** Au-delà, la ligne de commande et la mémoire de PHP deviennent un sujet. */
const MAX_BATCH = 150;
const MAX_CHANGES = 80;
const SCAN_TIMEOUT = 180000;

export class TranslationService {
  constructor(ssh, sites, settings = {}) {
    this.ssh = ssh;
    this.sites = sites;
    /** Premier service configuré, ou `null` : DeepL, Google, LibreTranslate. */
    this.provider = pickProvider(settings);
  }

  get machineAvailable() {
    return Boolean(this.provider);
  }

  get providerName() {
    return this.provider?.name ?? null;
  }

  /**
   * Analyse un lot de domaines : rien n'est écrit, rien n'est modifié.
   * Le découpage en lots est décidé par l'appelant, qui affiche ainsi sa progression.
   */
  async scan(serverId, domains, { minScore = 2 } = {}) {
    const server = this.ssh.server(serverId);
    const list = (Array.isArray(domains) ? domains : []).map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean);
    if (!list.length) throw new AppError('errors.translate_no_domain', { status: 400 });
    if (list.length > MAX_BATCH) throw new AppError('errors.translate_batch_too_big', { status: 400, vars: { max: MAX_BATCH } });

    const raw = await this.sites.runPhp(
      serverId,
      server.wwwRoot,
      SCAN_LANG,
      {
        LKM_ROOT: server.wwwRoot,
        LKM_MIN: String(Math.min(6, Math.max(1, Number(minScore) || 2))),
        LKM_B64: Buffer.from(JSON.stringify(list), 'utf8').toString('base64'),
      },
      { timeout: SCAN_TIMEOUT },
    );

    return { sites: (raw.sites ?? []).map((site) => this.#decorate(site)) };
  }

  /**
   * Ajoute à chaque texte repéré la traduction connue, et retrouve dans les libellés
   * courts ceux que le dictionnaire reconnaît dans une autre langue que celle du site.
   */
  #decorate(site) {
    if (site.error) return { domain: site.domain, error: site.error, items: [] };
    const lang = normalizeLang(site.lang) ?? 'FR';

    const items = (site.items ?? []).map((item) => ({
      path: item.path,
      text: item.text,
      lang: normalizeLang(item.lang),
      score: item.score,
      // Écart avec la langue suivante et longueur du texte : de quoi dire à l'agent
      // si le constat est net ou s'il demande un coup d'œil.
      gap: item.gap,
      words: item.words,
      // Repéré au second tour, sur une langue déjà prise en faute ailleurs dans la page :
      // la preuve est plus faible, l'agent doit y jeter un œil.
      weak: Boolean(item.weak),
      suggestion: dictionaryLookup(item.text, lang),
      source: 'detected',
    }));

    // Deux mots ne suffisent pas à trahir une langue : « Nos articles » passe entre les
    // mailles de l'analyse statistique. Le dictionnaire, lui, les reconnaît sans hésiter.
    for (const label of site.labels ?? []) {
      const suggestion = dictionaryLookup(label.text, lang);
      if (suggestion) items.push({ path: label.path, text: label.text, lang: null, score: 0, suggestion, source: 'dictionary' });
    }

    return {
      domain: site.domain,
      lang,
      langSource: site.source ?? 'default',
      hint: site.hint ?? '',
      texts: site.texts ?? 0,
      items,
    };
  }

  /** Traduction automatique d'une liste de textes, si un service est configuré. */
  async translate(texts, { from, to }) {
    if (!this.machineAvailable) throw new AppError('errors.translate_unavailable', { status: 503 });
    const target = normalizeLang(to);
    if (!target) throw new AppError('errors.translate_lang_unknown', { status: 400, vars: { lang: String(to).slice(0, 12) } });
    const list = (Array.isArray(texts) ? texts : []).slice(0, MAX_CHANGES).map((v) => String(v ?? ''));
    try {
      const out = await machineTranslate(list, { from: normalizeLang(from), to: target, provider: this.provider });
      return { translations: out ?? [], provider: this.providerName };
    } catch (err) {
      throw new AppError('errors.translate_failed', { status: 502, detail: String(err.message).slice(0, 300) });
    }
  }

  /**
   * Applique les traductions retenues : une publication ordinaire du site, avec
   * sauvegarde et vérification. Un texte modifié entre-temps sur le serveur est laissé
   * de côté plutôt qu'écrasé, et signalé à l'agent.
   */
  async apply(serverId, domain, changes, userId) {
    const list = (Array.isArray(changes) ? changes : []).slice(0, MAX_CHANGES);
    if (!list.length) throw new AppError('errors.translate_nothing', { status: 400 });
    return this.sites.applyTextChanges(serverId, domain, list, userId);
  }
}

export { LANGS };
