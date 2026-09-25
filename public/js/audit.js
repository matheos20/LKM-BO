import { api } from './api.js';
import { t } from './i18n.js';
import { fmtNum, h, icon, toastError } from './ui.js';

/**
 * L'onglet « Journal » de l'administration : qui a fait quoi, quand, sur quoi.
 *
 * Il s'adresse d'abord à quelqu'un qui cherche une chose précise — « qu'est-ce qui
 * s'est passé sur ce domaine hier ? » — et non à quelqu'un qui lit le journal du
 * début à la fin. Tout est donc organisé autour de la recherche :
 *
 *   - un champ libre qui balaie l'auteur, l'action, le domaine et la cible ;
 *   - des raccourcis de période (aujourd'hui, 7 jours, 30 jours) avant les dates
 *     exactes, parce que c'est ce qu'on demande neuf fois sur dix ;
 *   - des listes déroulantes qui ne proposent que ce qui figure VRAIMENT au journal,
 *     et avec leur nombre : un filtre qui ne rendrait rien ne s'affiche pas.
 *
 * Le filtrage et la pagination se font en base, jamais dans le navigateur : le journal
 * est fait pour grossir, et l'écran doit rester le même à dix mille lignes.
 */

const state = {
  filtres: { search: '', user: '', action: '', family: '', ok: '', from: '', to: '' },
  page: 1,
  data: null, // { events, total, page, pages, perPage }
  facets: null, // { users, actions, span }
  chargement: false,
  periode: '', // le raccourci de période actif, pour le montrer enfoncé
};

let saisie = null; // le champ de recherche survit aux rendus : on tape dedans
let minuteur = null;

export function resetAudit() {
  state.filtres = { search: '', user: '', action: '', family: '', ok: '', from: '', to: '' };
  state.page = 1;
  state.data = null;
  state.periode = '';
  saisie = null;
}

/** Les familles d'action, et la couleur qui va avec. */
const FAMILLES = {
  create: 'bg-accent-100 text-accent-800',
  update: 'bg-amber-100 text-amber-800',
  delete: 'bg-red-100 text-red-700',
  auth: 'bg-sky-100 text-sky-800',
  read: 'bg-ink-100 text-ink-600',
  other: 'bg-ink-100 text-ink-600',
};

const ICONES = { create: 'plus', update: 'wrench', delete: 'trash', auth: 'plug', read: 'eye', other: 'file' };

/**
 * Le nom d'une action, en toutes lettres quand on le connaît.
 *
 * Une action inconnue de la traduction n'est pas cachée : elle s'affiche telle quelle.
 * Un journal qui tait ce qu'il ne sait pas nommer ne vaut rien.
 */
const nomAction = (cle) => {
  const traduit = t(`audit.action.${cle}`);
  return traduit === `audit.action.${cle}` ? cle : traduit;
};

const badge = (event) =>
  h(
    'span',
    { class: `badge ${FAMILLES[event.family] ?? FAMILLES.other} whitespace-nowrap` },
    icon(ICONES[event.family] ?? ICONES.other, 'size-3'),
    nomAction(event.action),
  );

/** Date et heure, à la seconde : un journal se lit à la seconde près. */
const quand = (ms) => {
  const d = new Date(ms);
  return {
    jour: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
    heure: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
};

const jourISO = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// ───────────────────────── Chargement ─────────────────────────

export async function loadAudit({ force = false } = {}) {
  if (state.chargement) return;
  state.chargement = true;
  rerender();
  try {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(state.filtres)) if (v) params.set(k, v);
    params.set('page', String(state.page));

    const [data, facets] = await Promise.all([
      api(`/api/admin/audit?${params}`),
      !state.facets || force ? api('/api/admin/audit/facets') : Promise.resolve(state.facets),
    ]);
    state.data = data;
    state.facets = facets;
  } catch (err) {
    toastError(err);
    state.data = { events: [], total: 0, page: 1, pages: 1, perPage: 50 };
  } finally {
    state.chargement = false;
    rerender();
  }
}

let rerender = () => {};
export const onAuditChange = (fn) => {
  rerender = fn;
};

function changer(patch, { garderPage = false } = {}) {
  Object.assign(state.filtres, patch);
  if (!garderPage) state.page = 1;
  loadAudit();
}

// ───────────────────────── Filtres ─────────────────────────

function barreRecherche() {
  saisie ??= h('input', {
    class: 'input w-full',
    type: 'search',
    placeholder: t('audit.search_placeholder'),
    value: state.filtres.search,
    // On attend que l'agent ait fini de taper : une requête par frappe ferait
    // clignoter le tableau sans rien lui apprendre.
    oninput: (e) => {
      const v = e.target.value;
      clearTimeout(minuteur);
      minuteur = setTimeout(() => changer({ search: v }), 350);
    },
  });
  saisie.value = state.filtres.search;

  return h(
    'div',
    { class: 'flex flex-1 basis-72 items-center gap-2 rounded-lg border border-ink-200 bg-white px-3' },
    icon('search', 'size-4 shrink-0 text-ink-400'),
    h('span', { class: 'flex-1' }, saisie),
  );
}

/** Aujourd'hui, 7 jours, 30 jours : ce qu'on demande neuf fois sur dix. */
function raccourcisPeriode() {
  const poser = (cle, jours) => {
    if (state.periode === cle) {
      state.periode = '';
      return changer({ from: '', to: '' });
    }
    state.periode = cle;
    const fin = new Date();
    const debut = new Date(fin.getTime() - jours * 86400000);
    changer({ from: jourISO(debut), to: jourISO(fin) });
  };

  const bouton = (cle, jours, libelle) =>
    h(
      'button',
      { type: 'button', class: 'seg', 'aria-pressed': String(state.periode === cle), onclick: () => poser(cle, jours) },
      libelle,
    );

  return h(
    'div',
    { class: 'flex rounded-lg bg-ink-50 p-1' },
    bouton('today', 0, t('audit.period_today')),
    bouton('7d', 7, t('audit.period_7d')),
    bouton('30d', 30, t('audit.period_30d')),
  );
}

function listeDeroulante(cle, libelleVide, options) {
  return h(
    'select',
    {
      class: 'input w-auto min-w-40',
      'aria-label': libelleVide,
      onchange: (e) => {
        state.periode = '';
        changer({ [cle]: e.target.value });
      },
    },
    h('option', { value: '' }, libelleVide),
    options.map((o) => h('option', { value: o.value, selected: state.filtres[cle] === o.value }, o.label)),
  );
}

function filtres() {
  const f = state.facets;
  const utilisateurs = (f?.users ?? []).map((u) => ({
    value: u.username,
    label: `${u.displayName || u.username} (${fmtNum(u.count)})`,
  }));
  const actions = (f?.actions ?? []).map((a) => ({ value: a.action, label: `${nomAction(a.action)} (${fmtNum(a.count)})` }));
  const familles = ['create', 'update', 'delete', 'auth', 'read'].map((k) => ({ value: k, label: t(`audit.family_${k}`) }));

  const dates = h(
    'div',
    { class: 'flex items-center gap-1.5' },
    h('input', {
      type: 'date',
      class: 'input w-auto',
      'aria-label': t('audit.from'),
      value: state.filtres.from,
      onchange: (e) => {
        state.periode = '';
        changer({ from: e.target.value });
      },
    }),
    h('span', { class: 'text-xs text-ink-400' }, '→'),
    h('input', {
      type: 'date',
      class: 'input w-auto',
      'aria-label': t('audit.to'),
      value: state.filtres.to,
      onchange: (e) => {
        state.periode = '';
        changer({ to: e.target.value });
      },
    }),
  );

  const actifs = Object.values(state.filtres).filter(Boolean).length;

  return h(
    'div',
    { class: 'card space-y-3 px-4 py-3' },
    h('div', { class: 'flex flex-wrap items-center gap-2' }, barreRecherche(), raccourcisPeriode()),
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-2' },
      listeDeroulante('user', t('audit.all_users'), utilisateurs),
      listeDeroulante('action', t('audit.all_actions'), actions),
      listeDeroulante('family', t('audit.all_families'), familles),
      listeDeroulante('ok', t('audit.all_results'), [
        { value: 'true', label: t('audit.only_ok') },
        { value: 'false', label: t('audit.only_failed') },
      ]),
      dates,
      h('span', { class: 'flex-1' }),
      actifs
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-ghost px-2 py-1 text-xs',
              onclick: () => {
                resetAudit();
                loadAudit();
              },
            },
            icon('close', 'size-3.5'),
            t('audit.clear_filters', { count: fmtNum(actifs) }),
          )
        : null,
    ),
  );
}

// ───────────────────────── Le tableau ─────────────────────────

function ligne(event) {
  const { jour, heure } = quand(event.at);
  // Le nom d'affichage passe devant l'identifiant : c'est ainsi que l'agent connaît
  // ses collègues. L'identifiant reste dessous, pour lever toute ambiguïté.
  const auteur = event.user
    ? h(
        'span',
        { class: 'min-w-0' },
        h('span', { class: 'block truncate text-sm font-medium' }, event.user.displayName || event.user.username),
        event.user.displayName && event.user.displayName !== event.user.username
          ? h('span', { class: 'block truncate text-[11px] text-ink-400' }, event.user.username)
          : null,
      )
    : h('span', { class: 'text-sm text-ink-400 italic' }, t('audit.no_user'));

  const cible = [event.domain, event.target].filter(Boolean).join(' · ');

  return h(
    'tr',
    { class: 'border-t border-ink-100 align-top hover:bg-ink-50/50' },
    h(
      'td',
      { class: 'px-5 py-2.5 whitespace-nowrap' },
      h('span', { class: 'block text-sm' }, jour),
      h('span', { class: 'block font-mono text-[11px] text-ink-400' }, heure),
    ),
    h('td', { class: 'px-4 py-2.5' }, auteur),
    h('td', { class: 'px-4 py-2.5' }, badge(event)),
    h(
      'td',
      { class: 'px-4 py-2.5' },
      cible
        ? h('span', { class: 'block max-w-xs truncate text-sm' }, cible)
        : h('span', { class: 'text-sm text-ink-300' }, '—'),
      event.server ? h('span', { class: 'block text-[11px] text-ink-400' }, event.server) : null,
    ),
    h(
      'td',
      { class: 'px-5 py-2.5 text-right' },
      event.ok
        ? h('span', { class: 'badge bg-accent-100 text-accent-800' }, icon('check', 'size-3'), t('audit.ok'))
        : h(
            'span',
            { class: 'badge bg-red-100 text-red-700', title: event.error ?? '' },
            icon('alert', 'size-3'),
            t('audit.failed'),
          ),
    ),
  );
}

function tableau() {
  const d = state.data;
  if (!d) return h('div', { class: 'card px-6 py-14 text-center text-ink-400' }, t('files.loading'));

  if (!d.events.length) {
    const filtre = Object.values(state.filtres).some(Boolean);
    return h(
      'div',
      { class: 'card px-6 py-16 text-center' },
      h('span', { class: 'mx-auto flex size-12 items-center justify-center rounded-2xl bg-ink-50 text-ink-300' }, icon('search', 'size-6')),
      h('p', { class: 'mt-4 font-semibold' }, t(filtre ? 'audit.none_matching' : 'audit.none')),
      h('p', { class: 'mt-1 text-sm text-ink-500' }, t(filtre ? 'audit.none_matching_hint' : 'audit.none_hint')),
    );
  }

  // La marge est donnée UNE fois : empiler « px-4 px-5 » laisserait l'ordre du
  // fichier CSS décider, et non celui de l'attribut.
  const th = (cle, { pad = 'px-4', align = '' } = {}) => h('th', { class: `${pad} py-3 font-semibold ${align}` }, t(cle));

  return h(
    'div',
    { class: 'card overflow-hidden' },
    h(
      'div',
      { class: 'overflow-x-auto' },
      h(
        'table',
        { class: 'w-full text-left' },
        h(
          'thead',
          { class: 'bg-ink-50/60 text-xs tracking-wide text-ink-500 uppercase' },
          h(
            'tr',
            {},
            th('audit.col_when', { pad: 'px-5' }),
            th('audit.col_who'),
            th('audit.col_action'),
            th('audit.col_target'),
            th('audit.col_result', { pad: 'px-5', align: 'text-right' }),
          ),
        ),
        h('tbody', {}, d.events.map(ligne)),
      ),
    ),
    pagination(d),
  );
}

function pagination(d) {
  const aller = (p) => {
    state.page = p;
    loadAudit();
  };
  const premier = (d.page - 1) * d.perPage + 1;
  const dernier = Math.min(d.page * d.perPage, d.total);

  return h(
    'div',
    { class: 'flex flex-wrap items-center gap-3 border-t border-ink-100 px-5 py-3' },
    h('p', { class: 'flex-1 text-xs text-ink-500' }, t('audit.range', { from: fmtNum(premier), to: fmtNum(dernier), total: fmtNum(d.total) })),
    d.pages > 1
      ? h(
          'div',
          { class: 'flex items-center gap-2' },
          h(
            'button',
            { type: 'button', class: 'btn btn-outline px-2.5 py-1 text-xs', disabled: d.page <= 1, onclick: () => aller(d.page - 1) },
            t('audit.previous'),
          ),
          h('span', { class: 'text-xs text-ink-500' }, t('audit.page_of', { page: fmtNum(d.page), pages: fmtNum(d.pages) })),
          h(
            'button',
            { type: 'button', class: 'btn btn-outline px-2.5 py-1 text-xs', disabled: d.page >= d.pages, onclick: () => aller(d.page + 1) },
            t('audit.next'),
          ),
        )
      : null,
  );
}

/** L'onglet entier : les filtres, puis le tableau. */
export function auditView() {
  return h('div', { class: 'space-y-4' }, filtres(), tableau());
}

export const auditCount = () => state.data?.total ?? 0;
