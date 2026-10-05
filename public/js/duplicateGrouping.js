/**
 * Le rapprochement des articles en doublon : identiques, puis seulement ressemblants.
 *
 * IL VIT DANS `public/js/` PARCE QUE C'EST LE NAVIGATEUR QUI L'EXECUTE. Une tournee ne
 * voit que ses propres sites, et deux articles jumeaux peuvent tomber dans deux lots
 * differents : c'est l'ecran, qui les recoit tous, qui les rapproche. Mesure sur 17 539
 * articles reels : 142 ms, ce qui ne se sent pas.
 *
 * Le service Node l'importe d'ici plutot que d'en garder une copie. Deux copies d'un
 * algorithme finissent toujours par diverger, et celle qui se tait est celle qui se
 * trompe.
 */
/**
 * Nombre de bits de différence en deçà duquel deux articles se ressemblent.
 *
 * Six, parce que la mesure le dit : un paragraphe ajouté à un texte de 588 mots donne 5,
 * et deux textes étrangers l'un à l'autre donnent 33. Entre les deux, il n'y a rien sur
 * ce parc — le seuil est donc confortable dans les deux sens.
 *
 * CE QU'IL ATTRAPE SELON LA LONGUEUR DU TEXTE, mesuré sur du vrai PHP le 05/10/2026 :
 *
 *     mots   1 mot changé   +5 mots   +30 mots   moitié réécrite   texte étranger
 *      100         1            8        12            21                33
 *      300         1            4         8            18                30
 *      600         2            3         5            13                36
 *     1200         0            0         2            17                28
 *
 * La sensibilité suit donc la PROPORTION du texte modifié, pas le nombre de mots : cinq
 * mots ajoutés à cent donnent 8 et ne sont pas signalés, les mêmes cinq mots ajoutés à
 * six cents donnent 3 et le sont. Les articles courts sont jugés plus sévèrement, ce qui
 * est le bon sens. Et un article dont la MOITIE a été réécrite n'est jamais signalé,
 * quelle que soit sa longueur : c'en est un autre, y compris pour un lecteur.
 */
export const SEUIL_PROCHE = 6;

/**
 * L'empreinte est découpée en HUIT tranches de huit bits, et ce n'est pas un détail.
 *
 * Comparer tous les articles deux à deux coûte n² : pour cent cinquante sites, soit près
 * de dix mille articles, cela ferait cinquante millions de comparaisons dans le
 * navigateur de l'agent. Avec huit tranches, deux empreintes qui diffèrent de six bits au
 * plus ont forcément deux tranches identiques — on ne compare donc que les articles qui
 * partagent au moins une tranche. La garantie vaut jusqu'à SEPT bits de différence ; le
 * seuil est à six, et reste donc complet.
 */
const TRANCHES = 8;

/**
 * Au-dela, le rapprochement ne se fait plus qu'a l'interieur de chaque site.
 *
 * MESURE SUR 17 539 ARTICLES REELS de vps-004, le 05/10/2026 :
 *
 *     articles   tout le lot   par site
 *        2 000       132 ms      14 ms
 *        5 000       741 ms      29 ms
 *       10 000     2 854 ms      76 ms
 *       17 539     8 576 ms     142 ms
 *
 * Le travail se fait dans le navigateur de l'agent : huit secondes de page figee ne sont
 * pas acceptables. Et ce qu'on perd est nul sur ce parc — les deux modes ont rendu
 * EXACTEMENT les memes groupes (7, 11 puis 33), parce qu'il n'y existe aucun article
 * seulement ressemblant. Ce qu'on perdrait ailleurs, ce sont les ressemblances ENTRE
 * sites ; les contenus identiques, eux, restent trouves partout : ils ne coutent qu'une
 * table.
 */
export const MAX_RAPPROCHEMENT_GLOBAL = 4000;

/**
 * Une tranche partagee par plus de tant d'articles est ignoree.
 *
 * Elle ne distingue rien, et la comparer deux a deux coute son carre.
 */
const PAQUET_MAX = 300;

/** Le nombre de bits à 1 d'un entier de 16 bits ou moins. */
function popcount(x) {
  let n = 0;
  let v = x;
  while (v) {
    n += v & 1;
    v >>>= 1;
  }
  return n;
}

/**
 * Le nombre de bits qui diffèrent entre deux empreintes hexadécimales de 64 bits.
 *
 * Elles voyagent en hexadécimal parce que JSON ne sait pas porter un entier de 64 bits
 * sans l'abîmer : au-delà de 2^53, il arrondit en silence.
 */
export function distance(a, b) {
  if (!a || !b || a.length !== 16 || b.length !== 16) return 64;
  let d = 0;
  for (let i = 0; i < 16; i += 4) {
    d += popcount(parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16));
  }
  return d;
}

/** Les huit tranches d'une empreinte, chacune préfixée de son rang. */
const tranchesDe = (sim) => Array.from({ length: TRANCHES }, (_, i) => `${i}:${sim.slice(i * 2, i * 2 + 2)}`);

/** Une clé stable pour un article, serveur et site compris. */
export const cleArticle = (a) => `${a.server ?? ''}/${a.domain}/${a.path}`;

/**
 * Groupe les articles identiques, puis les articles seulement ressemblants.
 *
 * UN CONTENU IDENTIQUE N'EST REPRESENTE QU'UNE FOIS parmi les ressemblants. Si trois
 * articles partagent le même texte et qu'un quatrième leur ressemble, le groupe de
 * ressemblance en montre UN des trois, pas les trois : sans cela, un contenu publié
 * quatre-vingts fois produirait un groupe de quatre-vingt-une lignes qui dit une seule
 * chose.
 *
 * En revanche, un article déjà vu comme identique PEUT reparaître dans un groupe de
 * ressemblance, et c'est voulu : c'est lui qui fait le lien avec le quatrième. L'écarter
 * casserait le groupe sans rien apprendre.
 *
 * AUCUN GROUPE DE RESSEMBLANCE N'EST ECARTE, et la raison tient en une ligne : on ne
 * compare jamais deux articles de même contenu, donc un groupe de ressemblance porte
 * toujours au moins deux contenus DIFFERENTS — il dit donc toujours quelque chose que les
 * groupes d'identiques ne disent pas. Une version précédente jetait les groupes dont tous
 * les membres figuraient déjà parmi les identiques : deux articles republiés chacun de
 * leur côté, et dont les textes se ressemblent, disparaissaient alors de l'écran.
 */
export function grouper(articles, { seuil = SEUIL_PROCHE, maxGlobal = MAX_RAPPROCHEMENT_GLOBAL } = {}) {
  const liste = (articles ?? []).filter((a) => a && a.md5);

  // ── Les identiques : une simple table, et c'est fini.
  const parMd5 = new Map();
  for (const a of liste) {
    if (!parMd5.has(a.md5)) parMd5.set(a.md5, []);
    parMd5.get(a.md5).push(a);
  }
  const exact = [...parMd5.values()]
    .filter((g) => g.length > 1)
    .map((membres) => ({ kind: 'exact', distance: 0, members: membres }));

  // On ne compare qu'UN representant par contenu : un article publie quatre-vingts fois
  // ne doit pas produire un groupe de ressemblance de quatre-vingt-une lignes.
  const candidats = [];
  const deja = new Set();
  for (const a of liste) {
    if (!a.sim) continue;
    if (deja.has(a.md5)) continue;
    deja.add(a.md5);
    candidats.push(a);
  }

  // ── Les ressemblants.
  //
  // AU-DELA D'UN CERTAIN NOMBRE, ON NE RAPPROCHE PLUS QU'A L'INTERIEUR DE CHAQUE SITE.
  // Mesure : 5 000 articles se rapprochent en 368 ms, mais 20 000 en 7,1 s — et cela se
  // passe dans le navigateur de l'agent. Un site compte une soixantaine d'articles : les
  // rapprocher entre eux est instantane, quel que soit le nombre de sites. Ce qu'on perd,
  // ce sont les ressemblances ENTRE sites, et l'ecran le dit au lieu de le taire. Les
  // contenus identiques, eux, restent trouves partout : ils ne coutent qu'une table.
  const global = candidats.length <= maxGlobal;
  // `push` et non une recopie du tableau a chaque insertion : la version precedente
  // etait quadratique dans le nombre d'articles d'un site, et soixante mille articles
  // demandaient seize secondes la ou il en faut moins d'une.
  const parDomaine = new Map();
  if (!global) {
    for (const a of candidats) {
      const l = parDomaine.get(a.domain);
      if (l) l.push(a);
      else parDomaine.set(a.domain, [a]);
    }
  }
  const lots = global ? [candidats] : [...parDomaine.values()];

  const paires = new Map();
  for (const lot of lots) {
    const parTranche = new Map();
    for (const a of lot) {
      for (const t of tranchesDe(a.sim)) {
        if (!parTranche.has(t)) parTranche.set(t, []);
        parTranche.get(t).push(a);
      }
    }
    for (const groupe of parTranche.values()) {
      // Une tranche que tout le monde partage n'apprend rien et coute n².
      if (groupe.length < 2 || groupe.length > PAQUET_MAX) continue;
      for (let i = 0; i < groupe.length; i++) {
        for (let j = i + 1; j < groupe.length; j++) {
          const [x, y] = [groupe[i], groupe[j]];
          if (x.md5 === y.md5) continue;
          const cle = [cleArticle(x), cleArticle(y)].sort().join('|');
          if (paires.has(cle)) continue;
          const d = distance(x.sim, y.sim);
          if (d <= seuil) paires.set(cle, { a: x, b: y, d });
        }
      }
    }
  }

  // Les paires se rassemblent en familles : A ressemble a B, B a C, donc A, B et C vont
  // ensemble. L'agent veut voir une famille, pas une liste de couples.
  const famille = new Map();
  const racine = (k) => {
    let r = k;
    while (famille.get(r) !== r) r = famille.get(r);
    return r;
  };
  for (const { a, b } of paires.values()) {
    for (const k of [cleArticle(a), cleArticle(b)]) if (!famille.has(k)) famille.set(k, k);
    const [ra, rb] = [racine(cleArticle(a)), racine(cleArticle(b))];
    if (ra !== rb) famille.set(ra, rb);
  }

  const parRacine = new Map();
  const parCle = new Map(candidats.map((a) => [cleArticle(a), a]));
  for (const k of famille.keys()) {
    const r = racine(k);
    if (!parRacine.has(r)) parRacine.set(r, []);
    parRacine.get(r).push(parCle.get(k));
  }

  const proche = [...parRacine.values()]
    .filter((membres) => membres.length > 1)
    .map((membres) => {
      // La distance annoncee est la plus grande du groupe : c'est la plus prudente.
      let max = 0;
      for (let i = 0; i < membres.length; i++) {
        for (let j = i + 1; j < membres.length; j++) max = Math.max(max, distance(membres[i].sim, membres[j].sim));
      }
      return { kind: 'near', distance: max, members: membres };
    });

  const rang = (g) => -g.members.length;
  const groupes = [...exact.sort((a, b) => rang(a) - rang(b)), ...proche.sort((a, b) => rang(a) - rang(b))];
  // L'ecran doit pouvoir dire que les ressemblances entre sites n'ont pas ete cherchees.
  groupes.nearScope = global ? 'all' : 'site';
  return groupes;
}

/** Ce que l'écran affiche en haut : des comptes, calculés une fois. */
export function resume(groupes, articles) {
  const exact = groupes.filter((g) => g.kind === 'exact');
  const proche = groupes.filter((g) => g.kind === 'near');
  const concernes = new Set(groupes.flatMap((g) => g.members.map(cleArticle)));
  const sites = new Set(groupes.flatMap((g) => g.members.map((m) => m.domain)));
  // Un groupe qui s'etend sur plusieurs sites ne se traite pas comme un groupe interne :
  // le second est une erreur de publication, le premier une question de strategie.
  const croises = groupes.filter((g) => new Set(g.members.map((m) => m.domain)).size > 1);
  return {
    articles: (articles ?? []).length,
    groups: groupes.length,
    exact: exact.length,
    near: proche.length,
    crossSite: croises.length,
    affected: concernes.size,
    sites: sites.size,
  };
}

