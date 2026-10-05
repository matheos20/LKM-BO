import { t } from './i18n.js';
import { fmtDate, fmtNum, folderButton, h, icon } from './ui.js';
import { grouper } from './duplicateGrouping.js';

/**
 * Action « Articles en doublon ».
 *
 * ELLE NE DEMANDE RIEN : l'agent choisit ses sites et lance. Les réglages — ce qui compte
 * comme « identique », ce qui compte comme « ressemblant », à partir de combien de mots
 * un texte est comparable — sont mesurés et vivent dans `src/services/duplicateService.js`
 * avec les mesures qui les justifient. Un écran qui demanderait un seuil à quelqu'un qui
 * ne peut pas le choisir ne fait que déplacer la difficulté.
 *
 * LA MISE EN PAGE EST CELLE D'UN TERMINAL, comme demandé : chasse fixe pour les chemins,
 * colonnes alignées, un bloc par groupe, et rien d'autre. Ce que l'agent lit, ce sont des
 * chemins de fichiers — c'est la seule police où un tiret de trop se voit.
 *
 * CE QUE LA MESURE DIT DE CE PARC, pour que l'écran n'ait pas l'air en panne quand il ne
 * trouve rien : sur 17 539 articles de 240 sites, 33 groupes de contenus identiques et
 * AUCUN article seulement ressemblant. Les doublons réels suivent presque tous le même
 * motif — le même article republié sous « -2 », « -3 ».
 */

/** Ce qui s'affiche en tête d'un groupe, et la couleur qui va avec. */
const TEINTES = {
  exact: 'bg-red-100 text-red-700',
  near: 'bg-amber-100 text-amber-800',
};

const state = {
  sites: [],
  groupes: [],
  /** « all » : les ressemblances ont été cherchées partout. « site » : dans chaque site. */
  portee: 'all',
  /** Ne montrer que les groupes qui s'étendent sur plusieurs sites. */
  croisesSeuls: false,
  charge: null,
};

const articles = () => state.sites.flatMap((s) => s.articles ?? []);
const croise = (g) => new Set(g.members.map((m) => m.domain)).size > 1;
const visibles = () => (state.croisesSeuls ? state.groupes.filter(croise) : state.groupes);

export const duplicateAction = {
  key: 'duplicates',
  icon: 'copy',
  labelKey: 'actions.duplicates',
  hintKey: 'duplicates.explain',
  startLabelKey: 'duplicates.scan',
  // Soixante sites par lot : la lecture ne passe pas par le serveur web et ne réveille
  // aucun moteur de site. Mesuré : 246 articles par seconde.
  batch: 60,
  onChange: null,

  reset() {
    state.sites = [];
    state.groupes = [];
    state.portee = 'all';
    state.charge = null;
  },

  jobKind: 'duplicates.scan',
  jobParams: () => ({}),

  absorb(server, out) {
    for (const s of out?.sites ?? []) state.sites.push({ ...s, server, articles: (s.articles ?? []).map((a) => ({ ...a, server })) });
    if (out?.load && (!state.charge || out.load.io > state.charge.io)) state.charge = { ...out.load, server };
    regrouper();
  },

  stats() {
    const concernes = new Set(state.groupes.flatMap((g) => g.members.map((m) => `${m.server}/${m.domain}/${m.path}`)));
    const touches = new Set(state.groupes.flatMap((g) => g.members.map((m) => m.domain)));
    return [
      ['duplicates.stat_articles', fmtNum(articles().length), 'text-ink'],
      ['duplicates.stat_groups', fmtNum(state.groupes.length), state.groupes.length ? 'text-red-600' : 'text-accent-700'],
      ['duplicates.stat_affected', fmtNum(concernes.size), concernes.size ? 'text-red-600' : 'text-ink-300'],
      ['duplicates.stat_sites', fmtNum(touches.size), 'text-ink-500'],
    ];
  },

  ready: () => state.sites.length > 0,

  emptyState: () => h('p', { class: 'card px-4 py-6 text-center text-sm text-ink-500' }, t('duplicates.nothing')),

  results({ permissions = [], openFiles = null } = {}) {
    if (!state.sites.length) return null;
    const liste = visibles();
    return h(
      'div',
      { class: 'space-y-4' },
      noteLecture(),
      state.groupes.length ? barre() : rienTrouve(),
      ...liste.map((g) => groupe(g, { permissions, openFiles })),
      state.groupes.length && !liste.length
        ? h('p', { class: 'card px-4 py-6 text-center text-sm text-ink-500' }, t('duplicates.no_cross'))
        : null,
    );
  },
};

/**
 * Le regroupement se refait à chaque lot absorbé.
 *
 * C'est voulu : deux articles jumeaux peuvent vivre dans deux lots différents, et l'agent
 * voit son tableau se compléter au fur et à mesure plutôt qu'à la toute fin. Mesuré sur
 * 17 539 articles réels : 142 ms par passage, ce qui ne se sent pas.
 */
function regrouper() {
  state.groupes = grouper(articles());
  state.portee = state.groupes.nearScope ?? 'all';
}

/** Ce qui n'a PAS été regardé, dit avant les résultats. */
function noteLecture() {
  const sansCorps = state.sites.reduce((a, s) => a + (s.noBody ?? 0), 0);
  const courts = state.sites.reduce((a, s) => a + (s.tooShort ?? 0), 0);
  const erreurs = state.sites.filter((s) => s.error).length;
  if (!sansCorps && !courts && !erreurs && state.portee === 'all') return null;
  return h(
    'p',
    { class: 'flex items-start gap-2 rounded-lg bg-ink-50 px-4 py-3 text-sm text-ink-500' },
    icon('alert', 'size-4 shrink-0 mt-0.5'),
    h(
      'span',
      {},
      sansCorps || courts || erreurs
        ? t('duplicates.skipped', { body: fmtNum(sansCorps), short: fmtNum(courts), errors: fmtNum(erreurs) })
        : null,
      // Au-dela d'un certain nombre d'articles, les ressemblances ne sont cherchees qu'a
      // l'interieur de chaque site. Le taire laisserait croire a une recherche complete.
      state.portee === 'site' ? h('span', { class: 'mt-0.5 block' }, t('duplicates.near_per_site')) : null,
    ),
  );
}

function rienTrouve() {
  return h(
    'p',
    { class: 'flex items-center gap-2 rounded-lg bg-accent-50 px-4 py-3 text-sm font-medium text-accent-700' },
    icon('check'),
    t('duplicates.none', { count: fmtNum(articles().length) }),
  );
}

/** La seule commande de l'écran : tout voir, ou seulement ce qui s'étend sur plusieurs sites. */
function barre() {
  const croises = state.groupes.filter(croise).length;
  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3' },
    h(
      'p',
      { class: 'flex-1 text-sm text-ink-500' },
      t('duplicates.found', { groups: fmtNum(state.groupes.length), cross: fmtNum(croises) }),
    ),
    croises
      ? h(
          'label',
          { class: 'flex cursor-pointer items-center gap-2 text-sm text-ink-500' },
          h('input', {
            type: 'checkbox',
            class: 'size-4 rounded border-ink-200 text-accent-600',
            checked: state.croisesSeuls,
            onchange: (e) => {
              state.croisesSeuls = e.target.checked;
              duplicateAction.onChange?.();
            },
          }),
          t('duplicates.cross_only'),
        )
      : null,
  );
}

/** Un groupe : son en-tête, puis ses articles, en colonnes alignées. */
function groupe(g, { permissions, openFiles }) {
  const domaines = [...new Set(g.members.map((m) => m.domain))];
  const multiSite = domaines.length > 1;
  return h(
    'section',
    { class: 'card overflow-hidden' },
    h(
      'header',
      { class: 'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ink-100 px-4 py-2.5' },
      h('span', { class: `rounded-md px-2 py-0.5 text-xs font-semibold ${TEINTES[g.kind]}` }, t(`duplicates.kind_${g.kind}`)),
      g.kind === 'near' ? h('span', { class: 'font-mono text-xs text-ink-400' }, t('duplicates.distance', { n: String(g.distance) })) : null,
      h('span', { class: 'text-sm font-medium text-ink' }, t('duplicates.members', { count: fmtNum(g.members.length) })),
      multiSite
        ? h('span', { class: 'rounded-md bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800' }, t('duplicates.cross', { count: fmtNum(domaines.length) }))
        : null,
      h('span', { class: 'flex-1' }),
      h('span', { class: 'font-mono text-xs text-ink-400' }, t('duplicates.words', { count: fmtNum(g.members[0]?.words ?? 0) })),
    ),
    // Le titre, une fois : il est le meme pour tout le groupe quand les contenus le sont.
    g.members[0]?.title
      ? h('p', { class: 'truncate border-b border-ink-50 px-4 py-2 text-sm text-ink' }, g.members[0].title)
      : null,
    h(
      'ul',
      { class: 'divide-y divide-ink-50' },
      g.members.map((m) =>
        h(
          'li',
          { class: 'flex items-start gap-3 px-4 py-2' },
          h(
            'span',
            { class: 'min-w-0 flex-1' },
            h(
              'a',
              { href: `https://${m.domain}/${m.path.replace(/\.php$/, '')}`, target: '_blank', rel: 'noopener', class: 'font-mono text-xs text-accent-700 hover:underline' },
              m.domain,
            ),
            h('span', { class: 'mt-0.5 block truncate font-mono text-[0.7rem] text-ink-400', title: m.path }, m.path),
          ),
          h('span', { class: 'shrink-0 whitespace-nowrap text-xs text-ink-400' }, m.mtime ? fmtDate(m.mtime * 1000) : '—'),
          // Le gestionnaire de fichiers s'ouvre sur le site : c'est de la que l'agent
          // supprimera ou corrigera le doublon.
          folderButton(permissions, openFiles && (() => openFiles({ server: m.server, domain: m.domain })), { compact: true }),
        ),
      ),
    ),
  );
}
