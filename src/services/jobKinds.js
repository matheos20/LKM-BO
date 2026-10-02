/**
 * Ce qu'une tournée sait faire.
 *
 * Un traitement de masse, c'est toujours la même chose : une liste de cibles, découpée
 * en lots, et un appel par lot. Ce qui change d'un traitement à l'autre tient en trois
 * lignes — le droit exigé, la taille du lot, et l'appel lui-même. Le reste (figer la
 * liste, avancer, enregistrer, reprendre, raconter) appartient au moteur, et ne se
 * réécrit pas à chaque fois.
 *
 * AJOUTER UN TRAITEMENT, c'est ajouter une entrée ici. Rien d'autre.
 *
 * `run` reçoit un lot et rend ce que l'écran devra absorber. Le format n'engage que
 * l'écran qui l'a demandé : le moteur l'enregistre tel quel, sans le comprendre.
 */

/**
 * Les traitements PAR SERVEUR : le lot ne mélange jamais deux machines, parce que
 * chaque appel s'adresse à une session SSH précise.
 */
const parServeur = (kind, { permission, batch = 100, appel }) => [kind, { kind, permission, batch, perServer: true, run: appel }];

/**
 * La part d'une demande qui concerne ce lot.
 *
 * Un domaine absent de la demande est simplement ignoré : la liste des cibles et la
 * demande sont figées ensemble au départ, mais mieux vaut traiter ce qu'on a que
 * refuser le lot entier pour une entrée manquante.
 */
const part = (request, domains) => {
  const tout = request ?? {};
  return Object.fromEntries(domains.filter((d) => tout[d] !== undefined).map((d) => [d, tout[d]]));
};

export function buildJobKinds({ translation, categories, redirects, cloudflare }) {
  return Object.fromEntries([
    // ── Analyse : rien n'est modifié sur les sites.
    parServeur('translate.scan', {
      permission: 'bulk.read',
      appel: ({ serverId, domains, params }) => translation.scan(serverId, domains, { minScore: params.minScore }),
    }),
    parServeur('templates.scan', {
      permission: 'bulk.read',
      appel: ({ serverId, domains }) => translation.templates(serverId, domains),
    }),
    // Ces deux-là portent une demande PAR DOMAINE : l'agent peut coller un tableau où
    // chaque site a ses propres rubriques. L'écran envoie donc sa demande entière une
    // fois, et le lot n'en prend que sa part — recopier la demande dans chaque lot la
    // ferait transiter cent fois.
    parServeur('categories.plan', {
      permission: 'bulk.read',
      appel: ({ serverId, domains, params }) =>
        categories.plan(serverId, part(params.request, domains), { operation: params.operation }),
    }),
    parServeur('redirects.plan', {
      permission: 'bulk.read',
      appel: ({ serverId, domains, params }) =>
        redirects.plan(serverId, part(params.request, domains), { operation: params.operation ?? 'add', format: params.format }),
    }),

    // ── Cloudflare : ni serveur ni SSH, seulement l'API. Les lots sont plus gros,
    //    l'opération étant déjà menée en parallèle par le service.

    // REMPLACER LES CLÉS GLOBALES PAR DES JETONS. 38 195 comptes, un appel chacun :
    // c'est exactement ce pour quoi les tournées existent. Les lots restent petits —
    // créer un jeton écrit chez Cloudflare, et on avance prudemment.
    ['cloudflare.token', {
      kind: 'cloudflare.token',
      // Remplacer un accès est une écriture, et des plus sensibles.
      permission: 'cloudflare.write',
      batch: 20,
      perServer: false,
      run: async ({ domains, params }) => {
        const faits = [];
        for (const domain of domains) {
          try {
            faits.push({ domain, ...(await cloudflare.convertToToken(domain, params)) });
          } catch (err) {
            // Un compte qui résiste ne doit pas arrêter la tournée : il est noté, et on
            // passe au suivant. Sa clé globale est intacte — rien n'a été effacé.
            faits.push({ domain, error: String(err.key ?? err.message).slice(0, 200) });
          }
        }
        return { tokens: faits };
      },
    }],
    ['cloudflare.bulk', {
      kind: 'cloudflare.bulk',
      // Purger relève du droit de purge ; changer un réglage, de celui d'écriture.
      permission: ({ params }) => (params.op === 'purge' ? 'cloudflare.purge' : 'cloudflare.write'),
      batch: 200,
      perServer: false,
      run: ({ domains, params }) => cloudflare.bulk(params.op, domains, params.options ?? {}),
    }],
  ]);
}

/** Le droit exigé par un traitement, qui peut dépendre de ses options. */
export const permissionOf = (kind, params = {}) =>
  (typeof kind.permission === 'function' ? kind.permission({ params }) : kind.permission);
