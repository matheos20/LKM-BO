import { api } from './api.js';
import { t } from './i18n.js';
import { fmtNum, h, icon, peutAppliquerEnMasse, stepTitle, toast, toastError } from './ui.js';

/**
 * Action « Changer de thématique ».
 *
 * UNE THÉMATIQUE EST UN SUJET ET SON MENU : « SANTÉ » donne ACTU, BIEN-ÊTRE, GROSSESSE,
 * MALADIE, MINCEUR, PROFESSIONNELS, SANTÉ, SENIORS. Changer la thématique d'un site, c'est
 * remplacer ce menu — ni plus, ni moins.
 *
 * L'ÉCRAN SUIT TROIS TEMPS, et l'ordre protège l'agent :
 *
 *   1. LA THÉMATIQUE à poser, choisie dans la liste venue de la base, avec son menu sous
 *      les yeux ;
 *   2. LES SITES, par le sélecteur habituel de l'écran ;
 *   3. L'ANALYSE, puis la pose — et jamais l'inverse. L'analyse ne touche à rien et dit,
 *      site par site, ce qui serait créé, ce qui serait retiré, et COMBIEN D'ARTICLES
 *      PERDRAIENT LEUR RUBRIQUE.
 *
 * CE DERNIER CHIFFRE EST LE CŒUR DE L'ÉCRAN. Mesuré sur douze sites tirés au hasard :
 * passer à SPORT aurait rendu 688 articles inaccessibles depuis le menu. Les fichiers
 * restent sur le disque, mais plus rien n'y mène. Un site concerné n'est donc pas touché
 * tant que l'agent ne l'a pas explicitement autorisé — même règle que la case
 * « Remplacer » des redirections.
 *
 * CE QUE LE CHANGEMENT NE TOUCHE PAS : les textes du site. Mesuré sur 80 sites, treize
 * sites d'une même thématique avaient treize accroches différentes : ces textes sont
 * l'identité éditoriale de chaque site. L'écran le dit, pour que l'agent sache qu'il
 * restera la page d'accueil à reprendre dans l'éditeur.
 *
 * Mise en page volontairement sobre, à la manière d'un terminal : chasse fixe pour les
 * adresses et les rubriques, alignement en colonnes, aucune fioriture.
 */

/** Les états d'un site après la pose, du plus urgent au plus anodin. */
const ORDRE = ['error', 'rolled_back', 'orphans', 'done', 'already'];

/** Classes écrites en entier : Tailwind lit ce fichier pour produire sa feuille. */
const TEINTES = {
  error: 'bg-red-100 text-red-700',
  locked: 'bg-amber-100 text-amber-800',
  rolled_back: 'bg-red-100 text-red-700',
  orphans: 'bg-amber-100 text-amber-800',
  done: 'bg-accent-50 text-accent-700',
  already: 'bg-ink-100 text-ink-500',
};

const state = {
  /** Les thématiques venues de la base, chargées une fois. */
  liste: [],
  stats: null,
  langue: '',
  thematiqueId: null,
  /** L'analyse : ce que la tournée a rapporté. */
  sites: [],
  cible: null,
  incomplete: [],
  /** L'autorisation explicite de rendre des articles inaccessibles. */
  autoriseOrphelins: false,
  /** Ce qui a été posé, par site, et la sauvegarde qui permet d'y revenir. */
  poses: new Map(),
  /** Les sauvegardes connues, par site. */
  sauvegardes: new Map(),
  occupe: false,
};

const choisie = () => state.liste.find((x) => x.id === state.thematiqueId) ?? null;
const langues = () => [...new Set(state.liste.map((x) => x.lang))].sort();
const visibles = () => state.liste.filter((x) => !state.langue || x.lang === state.langue);
const analyses = () => state.sites.filter((s) => !s.error);
const orphelins = () => analyses().reduce((a, s) => a + (s.orphans ?? 0), 0);
const aChanger = () => analyses().filter((s) => !s.already);

export const themeAction = {
  key: 'themes',
  icon: 'palette',
  labelKey: 'actions.themes',
  hintKey: 'themes.explain',
  startLabelKey: 'themes.analyze',
  batch: 40,
  onChange: null,

  reset() {
    state.sites = [];
    state.cible = null;
    state.incomplete = [];
    state.poses.clear();
    state.sauvegardes.clear();
  },

  /** La liste des thématiques vit en base : on va la chercher une fois, au premier usage. */
  async before() {
    if (state.liste.length) return;
    try {
      const out = await api('/api/thematiques');
      state.liste = out.thematiques ?? [];
      state.stats = out.stats ?? null;
      if (!state.thematiqueId && state.liste.length) state.thematiqueId = state.liste[0].id;
    } catch (err) {
      toastError(err);
    }
  },

  form({ step = 1 } = {}) {
    return h(
      'div',
      { class: 'card p-5' },
      stepTitle(step, t('themes.step_what'), t('themes.step_what_hint')),
      state.liste.length ? selecteur() : h('p', { class: 'text-sm text-ink-400' }, t('themes.loading')),
      apercu(),
    );
  },

  canRun: () => Boolean(state.thematiqueId),

  jobKind: 'theme.analyze',
  jobParams: () => ({ thematiqueId: state.thematiqueId }),

  absorb(server, out) {
    if (out?.target) state.cible = out.target;
    if (out?.incomplete) state.incomplete = out.incomplete;
    for (const s of out?.sites ?? []) state.sites.push({ ...s, server });
  },

  stats() {
    const n = orphelins();
    return [
      ['themes.stat_sites', fmtNum(state.sites.length), 'text-ink'],
      ['themes.stat_tochange', fmtNum(aChanger().length), 'text-accent-700'],
      ['themes.stat_already', fmtNum(analyses().filter((s) => s.already).length), 'text-ink-300'],
      ['themes.stat_orphans', fmtNum(n), n ? 'text-red-600' : 'text-ink-300'],
    ];
  },

  ready: () => state.sites.length > 0,

  emptyState: () => h('p', { class: 'card px-4 py-6 text-center text-sm text-ink-500' }, t('themes.nothing')),

  results({ permissions = [] } = {}) {
    if (!state.sites.length) return null;
    return h(
      'div',
      { class: 'space-y-4' },
      state.incomplete.length ? avertissementIncomplete() : null,
      noteTextes(),
      barre(permissions),
      tableau(permissions),
    );
  },
};

/** Le choix de la thématique : la langue d'abord, le sujet ensuite. */
function selecteur() {
  const parLangue = h(
    'select',
    {
      class: 'input sm:w-36',
      'aria-label': t('themes.lang'),
      onchange: (e) => {
        state.langue = e.target.value;
        const premiere = visibles()[0];
        if (premiere && !visibles().some((x) => x.id === state.thematiqueId)) state.thematiqueId = premiere.id;
        themeAction.onChange?.();
      },
    },
    h('option', { value: '', selected: state.langue === '' }, t('themes.all_langs')),
    langues().map((l) => h('option', { value: l, selected: l === state.langue }, l)),
  );

  const parSujet = h(
    'select',
    {
      class: 'input sm:w-80',
      'aria-label': t('themes.choose'),
      onchange: (e) => {
        state.thematiqueId = Number(e.target.value) || null;
        themeAction.onChange?.();
      },
    },
    visibles().map((x) =>
      h('option', { value: String(x.id), selected: x.id === state.thematiqueId }, `${x.label} · ${x.lang} · ${x.rubriques.length}`),
    ),
  );

  return h('div', { class: 'flex flex-wrap items-center gap-3' }, parLangue, parSujet);
}

/** Le menu de la thématique choisie, tel qu'il sera posé. */
function apercu() {
  const x = choisie();
  if (!x) return null;
  const creux = x.rubriques.filter((r) => !r.icon || !r.description).length;
  return h(
    'div',
    { class: 'mt-3 space-y-2' },
    h(
      'div',
      { class: 'flex flex-wrap gap-1.5' },
      x.rubriques.map((r) =>
        h(
          'span',
          {
            class: 'inline-flex items-center gap-1 rounded-md bg-ink-50 px-2 py-1 font-mono text-xs text-ink',
            title: r.description || t('themes.no_description'),
          },
          r.icon ? h('span', {}, r.icon) : h('span', { class: 'text-ink-300' }, '·'),
          r.name,
        ),
      ),
    ),
    creux
      ? h('p', { class: 'text-xs text-amber-700' }, t('themes.incomplete_form', { count: fmtNum(creux), total: fmtNum(x.rubriques.length) }))
      : null,
  );
}

/** Une thématique à trous laisserait des rubriques sans icône ni description sur le site. */
function avertissementIncomplete() {
  return h(
    'p',
    { class: 'flex items-start gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900' },
    icon('alert', 'size-4 shrink-0 mt-0.5'),
    t('themes.incomplete_warn', { slugs: state.incomplete.slice(0, 6).join(', '), count: fmtNum(state.incomplete.length) }),
  );
}

/** Ce que le changement ne fera pas, dit une fois pour éviter une déception. */
function noteTextes() {
  return h(
    'p',
    { class: 'flex items-start gap-2 rounded-lg bg-ink-50 px-4 py-3 text-sm text-ink-500' },
    icon('alert', 'size-4 shrink-0 mt-0.5'),
    t('themes.texts_note'),
  );
}

/** La barre d'action : l'autorisation, puis la pose. */
function barre(permissions) {
  const peut = peutAppliquerEnMasse(permissions);
  const n = orphelins();
  const bloques = aChanger().filter((s) => s.writable && s.orphans > 0 && !state.autoriseOrphelins).length;
  const verrouilles = analyses().filter((s) => !s.writable).length;
  const posables = aChanger().filter((s) => s.engine && s.writable && (state.autoriseOrphelins || !s.orphans)).length;

  return h(
    'div',
    { class: 'card space-y-3 px-5 py-4' },
    n
      ? h(
          'label',
          { class: 'flex cursor-pointer items-start gap-2 text-sm' },
          h('input', {
            type: 'checkbox',
            class: 'mt-0.5 size-4 rounded border-ink-200 text-accent-600',
            checked: state.autoriseOrphelins,
            onchange: (e) => {
              state.autoriseOrphelins = e.target.checked;
              themeAction.onChange?.();
            },
          }),
          h(
            'span',
            {},
            h('span', { class: 'font-medium text-ink' }, t('themes.allow_orphans')),
            h('span', { class: 'mt-0.5 block text-xs text-ink-500' }, t('themes.allow_orphans_hint', { count: fmtNum(n) })),
          ),
        )
      : null,
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-x-4 gap-y-2' },
      h(
        'p',
        { class: 'flex-1 text-sm text-ink-500' },
        t('themes.ready', { count: fmtNum(posables), total: fmtNum(aChanger().length) }),
        bloques ? h('span', { class: 'mt-0.5 block text-xs text-amber-700' }, t('themes.blocked', { count: fmtNum(bloques) })) : null,
        // VERROUILLÉS : 217 sites sur 400 mesurés sur vps-004. Le dire ici, et non après
        // un échec, c'est la différence entre un outil et une devinette.
        verrouilles ? h('span', { class: 'mt-0.5 block text-xs text-amber-700' }, t('themes.locked_count', { count: fmtNum(verrouilles) })) : null,
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'btn-primary',
          disabled: !peut || !posables || state.occupe,
          title: peut ? null : t('reason.permission_denied'),
          onclick: () => poser(),
        },
        h('span', { class: 'inline-flex items-center gap-2' }, icon('palette'), t(state.occupe ? 'themes.applying' : 'themes.apply')),
      ),
    ),
  );
}

/** Pose la thématique, serveur par serveur : chaque appel s'adresse à une session SSH. */
async function poser() {
  const cibles = aChanger().filter((s) => s.engine && s.writable && (state.autoriseOrphelins || !s.orphans));
  if (!cibles.length) return;
  state.occupe = true;
  themeAction.onChange?.();
  try {
    const parServeur = new Map();
    for (const s of cibles) parServeur.set(s.server, [...(parServeur.get(s.server) ?? []), s.domain]);

    let poses = 0;
    for (const [server, domains] of parServeur) {
      const out = await api('/api/thematiques/apply', {
        method: 'POST',
        body: { server, domains, thematiqueId: state.thematiqueId, allowOrphans: state.autoriseOrphelins },
      });
      for (const s of out.sites ?? []) {
        state.poses.set(`${server}/${s.domain}`, s);
        if (s.state === 'done') poses += 1;
      }
    }
    toast(t('themes.applied', { count: fmtNum(poses), total: fmtNum(cibles.length) }), poses ? 'success' : 'info');
  } catch (err) {
    toastError(err);
  } finally {
    state.occupe = false;
    themeAction.onChange?.();
  }
}

/** Remet un site dans l'état d'avant, d'après une sauvegarde nommée. */
async function revenir(site, stamp) {
  state.occupe = true;
  themeAction.onChange?.();
  try {
    const out = await api('/api/thematiques/restore', {
      method: 'POST',
      body: { server: site.server, domain: site.domain, stamp },
    });
    state.poses.set(`${site.server}/${site.domain}`, { ...(state.poses.get(`${site.server}/${site.domain}`) ?? {}), state: 'restored', restore: out });
    toast(t('themes.restored', { domain: site.domain, count: fmtNum((out.restored ?? []).length) }), 'success');
  } catch (err) {
    toastError(err);
  } finally {
    state.occupe = false;
    themeAction.onChange?.();
  }
}

/** Le tableau : un site par ligne, ce qui change, et ce qu'on peut défaire. */
function tableau(permissions) {
  const multi = new Set(state.sites.map((s) => s.server)).size > 1;
  const peut = peutAppliquerEnMasse(permissions);
  const rangs = (s) => {
    const pose = state.poses.get(`${s.server}/${s.domain}`);
    if (pose) return ORDRE.indexOf(pose.state) >= 0 ? ORDRE.indexOf(pose.state) : 0;
    if (s.error) return 0;
    if (s.orphans) return 2;
    if (s.already) return 4;
    return 3;
  };

  return h(
    'section',
    { class: 'card overflow-hidden' },
    h(
      'div',
      { class: 'max-h-[32rem] overflow-y-auto' },
      h(
        'table',
        { class: 'w-full text-sm' },
        h(
          'thead',
          { class: 'sticky top-0 bg-white text-xs text-ink-400' },
          h(
            'tr',
            {},
            h('th', { class: 'px-4 py-2 text-left font-medium' }, t('col.domain')),
            multi ? h('th', { class: 'px-3 py-2 text-left font-medium' }, t('col.server')) : null,
            h('th', { class: 'px-3 py-2 text-left font-medium' }, t('themes.col_now')),
            h('th', { class: 'px-3 py-2 text-left font-medium' }, t('themes.col_change')),
            h('th', { class: 'px-3 py-2 text-right font-medium' }, t('themes.col_orphans')),
            h('th', { class: 'px-4 py-2 text-right font-medium' }, t('col.actions')),
          ),
        ),
        h('tbody', {}, [...state.sites].sort((a, b) => rangs(a) - rangs(b)).map((s) => ligne(s, { multi, peut }))),
      ),
    ),
  );
}

function ligne(s, { multi, peut }) {
  const pose = state.poses.get(`${s.server}/${s.domain}`);
  const etat = pose?.state ?? (s.error ? 'error' : !s.writable ? 'locked' : s.already ? 'already' : s.orphans ? 'orphans' : null);

  return h(
    'tr',
    { class: 'border-t border-ink-50 align-top' },
    h(
      'td',
      { class: 'px-4 py-2' },
      h(
        'a',
        { href: `https://${s.domain}/`, target: '_blank', rel: 'noopener', class: 'font-mono text-xs text-accent-700 hover:underline' },
        s.domain,
      ),
      etat ? h('span', { class: `ml-2 rounded px-1.5 py-0.5 text-[0.65rem] font-semibold ${TEINTES[etat] ?? 'bg-ink-100 text-ink-500'}` }, t(`themes.state_${etat}`)) : null,
      pose?.error ? h('span', { class: 'mt-0.5 block text-xs text-red-600' }, pose.error) : null,
      pose?.rollback && !pose.rollback.ok ? h('span', { class: 'mt-0.5 block text-xs text-red-700' }, t('themes.rollback_failed')) : null,
    ),
    multi ? h('td', { class: 'px-3 py-2 text-ink-400' }, s.server) : null,
    h(
      'td',
      { class: 'px-3 py-2 text-ink-500' },
      s.detected ? `${s.detected.label} (${s.detected.lang})` : h('span', { class: 'text-ink-300' }, t('themes.unknown_theme')),
      h('span', { class: 'mt-0.5 block font-mono text-[0.7rem] text-ink-300' }, (s.current ?? []).map((c) => c.slug).join(' ')),
    ),
    h(
      'td',
      { class: 'px-3 py-2' },
      s.error
        ? h('span', { class: 'text-xs text-red-600' }, t(`themes.err_${s.error}`, {}) || s.error)
        : !s.writable
          ? h('span', { class: 'text-xs text-amber-700' }, t('themes.err_locked'))
          : s.already
          ? h('span', { class: 'text-xs text-ink-400' }, t('themes.no_change'))
          : h(
              'span',
              { class: 'font-mono text-[0.7rem]' },
              (s.created ?? []).length ? h('span', { class: 'text-accent-700' }, `+${(s.created ?? []).join(' +')}`) : null,
              (s.created ?? []).length && (s.dropped ?? []).length ? ' ' : null,
              (s.dropped ?? []).length ? h('span', { class: 'text-red-600' }, `-${(s.dropped ?? []).join(' -')}`) : null,
            ),
    ),
    h(
      'td',
      { class: 'px-3 py-2 text-right tabular-nums' },
      // Rien à compter sur un site qu'on n'a pas pu lire : afficher un nombre laisserait
      // croire qu'on sait ce qu'un changement y ferait.
      !s.error && s.orphans
        ? h('span', { class: 'text-red-600', title: Object.entries(s.orphansBySlug ?? {}).map(([k, v]) => `${k} : ${v}`).join('\n') }, fmtNum(s.orphans))
        : h('span', { class: 'text-ink-300' }, '—'),
    ),
    h('td', { class: 'px-4 py-2 text-right' }, boutonRetour(s, pose, peut)),
  );
}

/**
 * Le bouton de retour arrière.
 *
 * Il n'apparaît que s'il y a vraiment où revenir : une sauvegarde nommée, prise par la
 * pose. Proposer un retour sans sauvegarde serait la pire des promesses.
 */
function boutonRetour(s, pose, peut) {
  const stamp = pose?.stamp;
  if (!stamp) return h('span', { class: 'text-xs text-ink-300' }, '—');
  if (pose.state === 'restored') return h('span', { class: 'text-xs text-ink-400' }, t('themes.state_restored'));
  return h(
    'button',
    {
      type: 'button',
      class: 'btn-outline px-2 py-1 text-xs',
      disabled: !peut || state.occupe,
      title: `${t('themes.restore_hint')} — ${stamp}`,
      onclick: () => revenir(s, stamp),
    },
    h('span', { class: 'inline-flex items-center gap-1.5' }, icon('refresh', 'size-3.5'), t('themes.restore')),
  );
}
