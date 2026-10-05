import { AppError } from '../errors.js';
import { isValidDomain } from '../ssh/shell.js';
import { ARTICLE_FINGERPRINTS, DOSSIERS_EXCLUS, MOTS_MINIMUM } from './duplicateScripts.js';
import { PRESSION_MAX, ServerLoad } from './serverLoad.js';

/**
 * Articles en doublon : identiques, ou seulement ressemblants.
 *
 * TOUT SE JOUE SUR LES EMPREINTES, et elles sont calculées sur le serveur, là où les
 * fichiers sont. Mesuré le 05/10/2026 sur vps-004 : 3 867 articles, 40 Mo lus en 14,8 s,
 * soit 262 articles par seconde — un site médian de 64 articles en un quart de seconde.
 * Les fichiers sont LUS comme du texte, jamais exécutés, et rien n'est écrit.
 *
 * DEUX MESURES, PARCE QUE « IDENTIQUE » ET « SIMILAIRE » NE SE COMPTENT PAS PAREIL :
 *
 *   - l'empreinte `md5` du texte nu groupe les contenus identiques à la mise en forme
 *     près. C'est exact, et c'est une simple table ;
 *   - l'empreinte de proximité (simhash, 64 bits) se compare par le nombre de bits qui
 *     diffèrent. Éprouvée sur un texte de 588 mots : un mot changé donne 1, cinq mots 4,
 *     un paragraphe ajouté 5, et un texte sans rapport 33. D'où le seuil par défaut.
 *
 * CE QUI EST TROUVE SUR LE PARC, pour que personne n'attende autre chose : sur 3 867
 * articles de 60 sites, 13 groupes d'articles identiques — tous DANS UN MEME SITE,
 * 28 articles au total — et aucun couple ressemblant, même à distance 10. Les articles de
 * ce parc sont réellement distincts les uns des autres ; le module ne criera donc pas au
 * loup, et ce qu'il signale mérite d'être regardé.
 */

const MAX_DOMAINS = 150;
const TIMEOUT = 600000;

// LE RAPPROCHEMENT VIT DANS `public/js/duplicateGrouping.js`, et il est importe d'ici
// plutot que recopie : c'est le NAVIGATEUR qui l'execute, parce qu'une tournee ne voit
// que ses propres sites et que deux articles jumeaux peuvent tomber dans deux lots. Le
// reexporter permet de l'eprouver cote Node, sans navigateur.
export { MAX_RAPPROCHEMENT_GLOBAL, SEUIL_PROCHE, cleArticle, distance, grouper, resume } from '../../public/js/duplicateGrouping.js';

export class DuplicateService {
  constructor(ssh, sites, load = new ServerLoad(ssh)) {
    this.ssh = ssh;
    this.sites = sites;
    this.load = load;
  }

  /**
   * Relève l'empreinte des articles d'un ou plusieurs sites. Lecture seule.
   *
   * Le groupement n'est PAS fait ici : un lot ne voit que ses sites, et deux articles
   * jumeaux peuvent vivre dans deux lots différents. C'est l'écran, qui les reçoit tous,
   * qui les rapproche — et c'est aussi pourquoi `grouper` est écrit en JavaScript pur,
   * éprouvable sans serveur.
   */
  async scan(serverId, domains, { minWords = MOTS_MINIMUM, ioCeiling = PRESSION_MAX, maxWait } = {}) {
    const server = this.ssh.server(serverId);
    const voulus = [...new Set((Array.isArray(domains) ? domains : []).map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean))];
    const liste = voulus.filter((d) => isValidDomain(d));
    if (!liste.length) throw new AppError('errors.dup_no_target', { status: 400 });
    if (liste.length > MAX_DOMAINS) throw new AppError('errors.translate_batch_too_big', { status: 400, vars: { max: MAX_DOMAINS } });

    // Lire quarante mégaoctets sur une machine qui attend déjà son disque ne ferait
    // qu'ajouter à la peine : le frein est celui que partagent toutes les analyses.
    const charge = await this.load.attendre(serverId, { pression: ioCeiling, attenteMax: maxWait });

    const raw = await this.sites.runPhp(
      serverId,
      server.wwwRoot,
      ARTICLE_FINGERPRINTS,
      {
        LKM_ROOT: server.wwwRoot,
        LKM_B64: Buffer.from(JSON.stringify(liste), 'utf8').toString('base64'),
        LKM_SKIP: Buffer.from(JSON.stringify(DOSSIERS_EXCLUS), 'utf8').toString('base64'),
        LKM_MIN_WORDS: String(Number(minWords) || MOTS_MINIMUM),
      },
      { timeout: TIMEOUT },
    );

    const vus = new Map((raw.sites ?? []).map((s) => [s.domain, s]));
    const sites = liste.map((domain) => {
      const lu = vus.get(domain);
      if (!lu) return { domain, error: 'no_answer', total: 0, articles: [] };
      if (lu.error) return { domain, error: lu.error, total: 0, articles: [] };
      return {
        domain,
        error: null,
        total: Number(lu.total) || 0,
        bytes: Number(lu.bytes) || 0,
        // Ce qui n'a pas pu etre compare, et pourquoi : l'agent doit savoir ce que
        // l'analyse n'a PAS regarde.
        noBody: Number(lu.noBody) || 0,
        tooShort: Number(lu.tooShort) || 0,
        unreadable: Number(lu.unreadable) || 0,
        articles: (lu.articles ?? []).map((a) => ({ ...a, domain })),
      };
    });

    return { sites, load: charge };
  }
}
