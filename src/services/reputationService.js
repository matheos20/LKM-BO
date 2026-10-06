/**
 * La RÉPUTATION d'un domaine : ce que le navigateur du visiteur en pense.
 *
 * POURQUOI CE SERVICE EXISTE. Le 06/10/2026, `gkmtaxzone.com` affichait un avertissement
 * « site dangereux » dans le navigateur, pendant que la santé du parc annonçait « tous
 * les sites vérifiés répondent normalement ». Les deux disaient vrai : la sonde demande
 * la page au serveur et regarde ce qu'il rend, or ce site rend une page parfaite. Vérifié
 * le jour même sur ce domaine : certificat Google Trust Services valide jusqu'au
 * 09/11/2026, HTTP 200, 57 662 octets, aucun script étranger hormis la balise Cloudflare,
 * aucune iframe, aucun code obfusqué, aucune redirection JavaScript. LE SITE EST SAIN ;
 * c'est sa RÉPUTATION qui ne l'est pas, et une réputation ne se lit pas sur le serveur —
 * elle vit dans une base tenue par Google, que les navigateurs consultent avant d'ouvrir
 * la page.
 *
 * D'OÙ VIENT LE VERDICT. Du rapport de transparence de Google, qui est public et ne
 * demande aucune clé. Relevé le 06/10/2026, sur des références choisies exprès :
 *
 *     google.com, wikipedia.org, github.com        code 4, aucun drapeau
 *     example.com, yuki-nails-paris.fr             code 1, aucun drapeau
 *     un domaine inexistant                        code 6, aucun drapeau, date 0
 *     testsafebrowsing.appspot.com (bac d'essai)   code 3, TROIS drapeaux levés
 *     gkmtaxzone.com et www.gkmtaxzone.com         code 2, UN drapeau levé
 *
 * LA RÈGLE RETENUE NE LIT PAS LE CODE, ELLE LIT LES DRAPEAUX : un drapeau levé, le site
 * est signalé ; aucun, il ne l'est pas. Les codes 1 et 4 veulent tous deux dire « rien à
 * signaler » et le 6 « jamais visité » ; s'appuyer sur eux demanderait de deviner un
 * tableau que Google ne publie pas, alors que les drapeaux sont sans ambiguïté — et que
 * le seul domaine du parc qui en lève un est précisément celui que le navigateur refuse.
 *
 * CE SERVICE EST BÂTI SUR UNE ADRESSE QUE GOOGLE NE DOCUMENTE PAS, et il faut le savoir :
 * elle peut changer sans préavis. C'est pourquoi tout ce qui n'est pas une réponse
 * clairement lisible devient « non vérifié », JAMAIS « sain ». Un module de sécurité qui
 * rassure quand il n'a rien pu lire est pire que pas de module du tout. Le jour où une
 * clé Safe Browsing officielle sera disponible, seul `interroger()` changera.
 *
 * Mesuré le 06/10/2026 : 1,7 interrogation par seconde à une seule à la fois, 4,9 à six
 * en parallèle, aucune rebuffade sur quarante domaines. Le rythme retenu reste en deçà.
 */

/** L'adresse publique du rapport de transparence. */
const URL_STATUT = 'https://transparencyreport.google.com/transparencyreport/api/v3/safebrowsing/status?site=';

/**
 * Un navigateur ordinaire. Sans cet en-tête, la réponse n'est pas la même.
 */
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Combien d'interrogations à la fois. Mesuré : six passent ; trois laissent de la marge. */
export const PARALLELE_DEFAUT = 3;

/** Le temps laissé à une interrogation. Latence mesurée : 580 à 810 ms. */
export const DELAI = 12000;

/**
 * Combien de domaines au plus par lot.
 *
 * La santé du parc avance par lots de cinquante ; ce plafond n'est donc pas une limite
 * en pratique, c'est un garde-fou : il empêche qu'un appel mal formé lance cinq mille
 * requêtes vers Google d'un coup.
 */
export const MAX_PAR_LOT = 200;

/**
 * Combien de temps un verdict reste valable.
 *
 * Six heures : un signalement Safe Browsing ne va ni ne vient en quelques minutes, et
 * relire le même domaine à chaque analyse du parc multiplierait les requêtes sans rien
 * apprendre. Le cache vit en mémoire et meurt au redémarrage, ce qui suffit.
 */
export const DUREE_CACHE = 6 * 3600 * 1000;

/** Les états possibles, et ce qu'ils veulent dire pour l'agent. */
export const ETATS = Object.freeze({
  FLAGGED: 'flagged', // Google signale ce domaine : le navigateur affichera un avertissement.
  CLEAN: 'clean', // Google connaît ce domaine et n'a rien contre lui.
  UNKNOWN: 'unknown', // Google ne l'a jamais visité. Ce n'est ni bon ni mauvais signe.
  UNCHECKED: 'unchecked', // On n'a pas pu demander. On ne prétend rien.
});

/**
 * Le dépouillement de la réponse, séparé du reste pour être éprouvable sans réseau.
 *
 * La réponse est un tableau JSON précédé d'une garde anti-injection, de la forme
 * `[["sb.ssr",2,false,false,true,false,false,1790256475762,"gkmtaxzone.com",false]]`.
 * Rend `null` dès que quoi que ce soit ne ressemble pas à cela — l'appelant en fera un
 * « non vérifié », et surtout pas un « sain ».
 */
export function lireStatut(texte) {
  const brut = String(texte ?? '');
  const debut = brut.indexOf('[');
  if (debut < 0) return null;
  let data;
  try {
    data = JSON.parse(brut.slice(debut));
  } catch {
    return null;
  }
  const ligne = Array.isArray(data) ? data.find((l) => Array.isArray(l) && l[0] === 'sb.ssr') : null;
  if (!ligne || typeof ligne[1] !== 'number') return null;
  // Les trois drapeaux de catégorie. Leur ordre exact n'est pas publié ; ce qui compte,
  // et qui est vérifié, c'est qu'un domaine signalé en lève au moins un.
  const drapeaux = [ligne[2], ligne[3], ligne[4]];
  if (drapeaux.some((d) => typeof d !== 'boolean')) return null;
  const date = Number(ligne[7]);
  return {
    code: ligne[1],
    drapeaux: drapeaux.map(Boolean),
    // Quand Google a regardé ce domaine pour la dernière fois. 0 veut dire « jamais ».
    checkedAt: Number.isFinite(date) && date > 0 ? date : null,
  };
}

/**
 * Le verdict, à partir du dépouillement.
 *
 * UN SEUL DRAPEAU SUFFIT. Et un statut sans drapeau mais sans date de visite veut dire
 * que Google n'a jamais vu ce domaine : c'est « inconnu », pas « sain ». La nuance
 * compte, parce qu'un domaine inconnu peut parfaitement être signalé demain.
 */
export function verdict(statut) {
  if (!statut) return ETATS.UNCHECKED;
  if (statut.drapeaux.some(Boolean)) return ETATS.FLAGGED;
  return statut.checkedAt ? ETATS.CLEAN : ETATS.UNKNOWN;
}

/** Ce qu'on garde pour un domaine, cache compris. */
const resultat = (state, statut = null) => ({
  state,
  code: statut?.code ?? null,
  checkedAt: statut?.checkedAt ?? null,
});

export class ReputationService {
  /**
   * `fetch` est injectable pour que le service s'éprouve sans réseau, et `now` pour que
   * le cache s'éprouve sans attendre six heures.
   */
  constructor({ fetch: lecteur = globalThis.fetch, now = () => Date.now(), enabled = true } = {}) {
    this.fetch = lecteur;
    this.now = now;
    this.enabled = enabled;
    /** domaine → { resultat, expire } */
    this.cache = new Map();
  }

  /**
   * Une interrogation. Rend le statut, ou `null` si la réponse n'est pas lisible.
   *
   * DEUX FAÇONS D'ÉCHOUER, ET ELLES NE SE SOIGNENT PAS PAREIL :
   *
   *   - un REFUS (statut HTTP autre que 200) est délibéré. Insister ferait prendre notre
   *     adresse pour un robot : on s'arrête, et sans réessayer ;
   *   - un à-coup RÉSEAU est fortuit. Mesuré le 06/10/2026 : le tout premier appel sortant
   *     d'un processus a mis 2,3 s là où les suivants en mettent 0,4, et un essai sur
   *     quatre a échoué à froid. Laisser un tel à-coup faire taire le module aurait rendu
   *     « non vérifié » un domaine que trois passages d'affilée ont signalé.
   */
  async interroger(domain) {
    let r;
    try {
      r = await this.fetch(URL_STATUT + encodeURIComponent(domain), {
        headers: { 'user-agent': AGENT, accept: '*/*' },
        signal: AbortSignal.timeout(DELAI),
      });
    } catch (cause) {
      const e = new Error(`réseau : ${cause?.message ?? cause}`);
      e.reseau = true;
      throw e;
    }
    if (!r || r.status !== 200) {
      // Un refus n'est pas un verdict : on le fait remonter pour arrêter le lot, plutôt
      // que de marquer ce domaine « non vérifié » et de continuer à cogner.
      const e = new Error(`statut HTTP ${r?.status ?? '?'}`);
      e.rebuffade = true;
      throw e;
    }
    return lireStatut(await r.text());
  }

  /** La même, avec UN second essai quand c'est le réseau qui a bronché, et pas Google. */
  async interrogerAvecReprise(domain) {
    try {
      return await this.interroger(domain);
    } catch (e) {
      if (!e?.reseau) throw e;
      return this.interroger(domain);
    }
  }

  /**
   * La réputation d'une liste de domaines.
   *
   * TROIS PROMESSES, et elles sont tenues dans cet ordre :
   *
   *   1. un domaine dont la réponse n'a pas pu être lue est « non vérifié ». Jamais
   *      « sain » — c'est la seule règle qui rende ce module digne de confiance ;
   *   2. à la première rebuffade (refus, coupure, machine sans accès sortant) le lot
   *      s'arrête net. Insister ferait prendre notre adresse pour un robot, et les
   *      domaines restants sont rendus « non vérifiés », pas oubliés ;
   *   3. rien n'est demandé deux fois en six heures.
   *
   * Rend toujours une entrée par domaine demandé, et `interrupted` pour que l'écran
   * puisse le dire au lieu de le taire.
   */
  async check(domains, { parallel = PARALLELE_DEFAUT, max = MAX_PAR_LOT } = {}) {
    const voulus = [...new Set((Array.isArray(domains) ? domains : []).map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean))];
    const out = new Map();
    if (!voulus.length) return { results: out, interrupted: false, checked: 0 };

    if (!this.enabled || typeof this.fetch !== 'function') {
      for (const d of voulus) out.set(d, resultat(ETATS.UNCHECKED));
      return { results: out, interrupted: false, checked: 0, off: true };
    }

    const maintenant = this.now();
    const aDemander = [];
    for (const d of voulus) {
      const garde = this.cache.get(d);
      if (garde && garde.expire > maintenant) out.set(d, garde.resultat);
      else aDemander.push(d);
    }

    // Le garde-fou : au-delà, les domaines en trop sont rendus « non vérifiés » et le
    // lot est dit incomplet. Mieux vaut un trou avoué qu'une avalanche de requêtes.
    const traites = aDemander.slice(0, max);
    const laisses = aDemander.slice(max);

    let arret = false;
    let faits = 0;
    for (let i = 0; i < traites.length && !arret; i += parallel) {
      const tranche = traites.slice(i, i + parallel);
      const reponses = await Promise.all(
        tranche.map(async (d) => {
          try {
            return { d, statut: await this.interrogerAvecReprise(d) };
          } catch (e) {
            return { d, rebuffade: true, pourquoi: String(e?.message ?? e) };
          }
        }),
      );
      for (const r of reponses) {
        if (r.rebuffade) {
          arret = true;
          out.set(r.d, resultat(ETATS.UNCHECKED));
          continue;
        }
        const etat = verdict(r.statut);
        const res = resultat(etat, r.statut);
        out.set(r.d, res);
        faits++;
        // Un « non vérifié » ne se met pas en cache : il ne dit rien, et le garder
        // empêcherait de réessayer tout à l'heure.
        if (etat !== ETATS.UNCHECKED) this.cache.set(r.d, { resultat: res, expire: this.now() + DUREE_CACHE });
      }
    }

    for (const d of [...laisses, ...traites]) if (!out.has(d)) out.set(d, resultat(ETATS.UNCHECKED));
    return { results: out, interrupted: arret || laisses.length > 0, checked: faits };
  }
}
