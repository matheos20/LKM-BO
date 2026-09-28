import { api } from './api.js';
import { t } from './i18n.js';
import { fmtNum, h, icon, toastError } from './ui.js';

/**
 * Le panneau de recherche globale, au-dessus de la liste des domaines.
 *
 * Il répond à deux questions que l'agent se pose tout le temps : « sur quel VPS est ce
 * domaine ? » et « à quel article correspond cette adresse ? ». Dans les deux cas il
 * colle ce qu'il a sous la main — souvent l'adresse entière prise dans son navigateur —
 * et le panneau lui donne le serveur, le domaine, l'article, puis les boutons pour agir.
 *
 * Il ne s'affiche QUE quand il a quelque chose à dire : une adresse complète, un
 * domaine reconnu, ou un échec qui s'explique. Tant que l'agent filtre simplement la
 * liste par un bout de nom, le tableau en dessous suffit et le panneau reste absent.
 */

const state = {
  q: '',
  res: null,
  chargement: false,
};

let minuteur = null;
let dessiner = () => {};
let actions = {};

/**
 * @param {object} o
 * @param {Function} o.onRender      redessine l'écran hôte
 * @param {object}   o.actions       ce que le panneau sait ouvrir (design, fichiers, détails…)
 */
export function initSearch({ onRender, actions: a }) {
  dessiner = onRender;
  actions = a ?? {};
}

export const searchResult = () => state.res;

/**
 * Met l'état du verrou à jour après une bascule, pour que le panneau ne montre pas
 * un cadenas périmé à côté du bouton qu'on vient d'actionner.
 */
export function setSearchStatus(status) {
  if (!state.res?.site) return;
  state.res.site.status = status;
  dessiner();
}
export const clearSearch = () => {
  state.q = '';
  state.res = null;
  state.chargement = false;
  clearTimeout(minuteur);
};

/**
 * Une recherche ne part que si elle a une chance d'apprendre quelque chose : une
 * adresse avec un chemin, ou un nom de domaine complet. Un bout de mot tapé dans le
 * filtre ne doit pas déclencher d'aller-retour avec le serveur.
 */
export const vautLaPeine = (q) => {
  const v = String(q ?? '').trim();
  if (v.length < 4) return false;
  return v.includes('/') || /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(v.replace(/^[a-z]+:\/\//i, '').replace(/^www\./i, ''));
};

/** Lance la recherche, en laissant à l'agent le temps de finir sa frappe. */
export function askSearch(q) {
  clearTimeout(minuteur);
  state.q = String(q ?? '').trim();

  if (!vautLaPeine(state.q)) {
    const avait = Boolean(state.res);
    state.res = null;
    state.chargement = false;
    if (avait) dessiner();
    return;
  }

  minuteur = setTimeout(async () => {
    const demande = state.q;
    state.chargement = true;
    dessiner();
    try {
      const res = await api('/api/search', { method: 'POST', body: { q: demande } });
      // Une réponse en retard ne doit pas écraser une recherche plus récente.
      if (demande !== state.q) return;
      state.res = res;
    } catch (err) {
      toastError(err);
      state.res = null;
    } finally {
      state.chargement = false;
      dessiner();
    }
  }, 350);
}

// ───────────────────────── Rendu ─────────────────────────

const carte = (...enfants) => h('div', { class: 'card px-4 py-3' }, ...enfants);

const badgeServeur = (label) => h('span', { class: 'badge bg-ink-100 text-ink-700' }, icon('disk', 'size-3.5'), label);

const ETAT = {
  locked: 'badge bg-ink text-white',
  unlocked: 'badge bg-accent-100 text-accent-700',
  incomplete: 'badge bg-amber-100 text-amber-800',
};

/**
 * Verrouiller ou déverrouiller, sans quitter la recherche.
 *
 * Absent sur un domaine incomplet — il n'y a rien à verrouiller — et inactif, avec sa
 * raison, quand le compte SSH ou les droits de l'utilisateur ne le permettent pas. Le
 * serveur a déjà croisé les deux : l'écran ne fait que lire sa réponse.
 */
function boutonVerrou(site) {
  if (site.status === 'incomplete') return null;
  const action = site.status === 'locked' ? 'unlock' : 'lock';
  const cap = actions.caps?.(site)?.[action];
  const permis = cap?.ok !== false;
  return h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline px-3 py-1.5 text-xs',
      disabled: !permis,
      title: permis ? null : t('action.unavailable', { reason: t(`reason.${cap?.reason ?? 'permission_denied'}`) }),
      onclick: (e) => actions.toggleLock?.(site, action, e.currentTarget),
    },
    icon(action === 'lock' ? 'lock' : 'unlock', 'size-3.5'),
    t(`action.${action}`),
  );
}

/** Les gestes offerts sur un site trouvé, selon les droits du compte. */
function boutonsSite(site, { article = null } = {}) {
  const bouton = (ico, libelle, permis, onclick, principal = false) =>
    permis
      ? h('button', { type: 'button', class: `btn ${principal ? 'btn-primary' : 'btn-outline'} px-3 py-1.5 text-xs`, onclick }, icon(ico, 'size-3.5'), libelle)
      : null;

  return h(
    'div',
    { class: 'flex flex-wrap items-center gap-2' },
    // Quand un article est trouvé, l'ouvrir est le geste attendu : il passe devant.
    article
      ? bouton('pencil', t('search.open_article'), actions.can?.('design.read'), () => actions.openArticle?.(site, article), true)
      : bouton('palette', t('design.open'), actions.can?.('design.read'), () => actions.openDesign?.(site), true),
    bouton('folder', t('files.open_manager'), actions.can?.('files.read'), () => actions.openFiles?.(site)),
    bouton('eye', t('action.details'), true, () => actions.openDetails?.(site)),
    boutonVerrou(site),
    bouton('globe', t('search.visit'), true, () => actions.visit?.(site, article)),
  );
}

/** L'en-tête d'un résultat : le domaine, son serveur, son état. */
const enTeteSite = (site) =>
  h(
    'div',
    { class: 'flex flex-wrap items-center gap-2' },
    h('p', { class: 'font-mono text-sm font-semibold' }, site.domain),
    badgeServeur(site.serverLabel),
    site.status ? h('span', { class: ETAT[site.status] ?? ETAT.unlocked }, t(`status.${site.status}`)) : null,
  );

/** Les serveurs éteints : la première raison pour laquelle un domaine reste introuvable. */
const horsLigne = (res) =>
  res.offline?.length
    ? h(
        'p',
        { class: 'mt-2 text-xs text-amber-700' },
        icon('alert', 'mr-1 inline size-3.5 align-text-bottom'),
        t('search.offline', { servers: res.offline.map((s) => s.label).join(', ') }),
      )
    : null;

function listeCandidats(res) {
  return h(
    'div',
    { class: 'mt-2 flex flex-wrap gap-1.5' },
    res.candidates.map((c) =>
      h(
        'button',
        {
          type: 'button',
          class: 'inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-white py-1 pr-1.5 pl-2.5 text-xs transition hover:border-accent',
          onclick: () => actions.pick?.(c),
        },
        h('span', { class: 'font-mono' }, c.domain),
        h('span', { class: 'text-ink-400' }, c.serverLabel),
      ),
    ),
  );
}

/** Le panneau, ou rien du tout s'il n'a rien à dire. */
export function searchPanel() {
  if (state.chargement) return carte(h('p', { class: 'text-sm text-ink-400' }, t('search.searching')));
  const res = state.res;
  if (!res) return null;

  if (res.kind === 'invalid') return null;

  if (res.kind === 'unknown' || res.kind === 'near') {
    return carte(
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        icon('search', 'size-4 shrink-0 text-ink-400'),
        h('p', { class: 'text-sm text-ink-600' }, t(res.kind === 'near' ? 'search.near' : 'search.unknown', { domain: res.domain })),
      ),
      res.candidates?.length ? listeCandidats(res) : null,
      horsLigne(res),
    );
  }

  const site = res.site;

  // Une adresse d'article, et l'article retrouvé : c'est la réponse la plus complète.
  if (res.kind === 'article') {
    return carte(
      h(
        'div',
        { class: 'flex flex-wrap items-start gap-3' },
        h(
          'div',
          { class: 'min-w-0 flex-1' },
          enTeteSite(site),
          h('p', { class: 'mt-1 truncate text-sm font-medium' }, res.article.url || `/${res.article.file}`),
          h(
            'p',
            { class: 'mt-0.5 font-mono text-[11px] text-ink-400' },
            res.article.file,
            res.article.category ? h('span', { class: 'ml-2 font-sans' }, res.article.category) : null,
          ),
        ),
        boutonsSite(site, { article: res.article }),
      ),
    );
  }

  // Le domaine est là, l'article non : on le dit, et on ouvre quand même la porte.
  if (res.kind === 'article_missing') {
    return carte(
      h(
        'div',
        { class: 'flex flex-wrap items-start gap-3' },
        h(
          'div',
          { class: 'min-w-0 flex-1' },
          enTeteSite(site),
          h('p', { class: 'mt-1 text-sm text-amber-700' }, t('search.article_missing', { path: res.path })),
          h('p', { class: 'mt-0.5 text-xs text-ink-400' }, t('search.article_count', { count: fmtNum(res.articleCount ?? 0) })),
        ),
        boutonsSite(site),
      ),
    );
  }

  // Un domaine, tout simplement.
  return carte(
    h(
      'div',
      { class: 'flex flex-wrap items-start gap-3' },
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        enTeteSite(site),
        res.articleError ? h('p', { class: 'mt-1 text-xs text-amber-700' }, t('search.article_error')) : null,
      ),
      boutonsSite(site),
    ),
    res.candidates?.length ? listeCandidats(res) : null,
  );
}
