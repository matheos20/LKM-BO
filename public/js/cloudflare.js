import { api } from './api.js';
import { t } from './i18n.js';
import { $, closeModal, enc, fmtDate, fmtNum, formError, h, icon, modalHeader, openModal, toast, toastError } from './ui.js';

/**
 * Écran Cloudflare.
 *
 * Trente-huit mille domaines : on n'en montre jamais plus de cinquante à la fois, et la
 * recherche porte côté serveur. Une case par ligne permet d'agir sur plusieurs domaines
 * d'un coup — c'est le geste que l'agent répétait le plus.
 *
 * Deux principes tiennent l'écran :
 *
 *   - CE QUI MODIFIE SE CONFIRME. Changer un mode SSL ou vider un cache se voit par les
 *     visiteurs. Chaque action de masse annonce ce qu'elle va faire, sur combien de
 *     domaines, avant de le faire.
 *   - CE QUI A ÉCHOUÉ SE DIT. Une opération sur cent domaines qui en rate douze doit
 *     nommer les douze et leur motif, pas afficher « terminé ».
 */

const state = {
  open: false,
  loading: false,
  zones: [],
  total: 0,
  page: 1,
  pages: 1,
  perPage: 50,
  search: '',
  filter: '',
  selected: new Set(),
  stats: null,
  permissions: [],
  onClose: null,
  busy: null,
};

const can = (p) => state.permissions.includes(p);
const view = () => $('#cloudflare-view');

/** Les modes SSL, du plus ouvert au plus strict, avec ce qu'ils impliquent. */
const SSL_MODES = [
  { value: 'off', tone: 'bg-red-100 text-red-700' },
  { value: 'flexible', tone: 'bg-amber-100 text-amber-800' },
  { value: 'full', tone: 'bg-accent-100 text-accent-700' },
  { value: 'strict', tone: 'bg-accent-200 text-accent-700' },
];

const SECURITY_LEVELS = ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'];

const ETAT_TONS = {
  active: 'bg-accent-100 text-accent-700',
  pending: 'bg-amber-100 text-amber-800',
  initializing: 'bg-ink-100 text-ink-600',
  moved: 'bg-red-100 text-red-700',
  deactivated: 'bg-red-100 text-red-700',
};

export function closeCloudflare() {
  if (!state.open) return;
  state.open = false;
  state.selected.clear();
  view().hidden = true;
  view().replaceChildren();
  state.onClose?.();
}

export async function openCloudflare({ permissions = [], onClose = null } = {}) {
  Object.assign(state, { open: true, permissions, onClose, page: 1, search: '', filter: '', selected: new Set() });
  $('#domains-view').hidden = true;
  $('#files-view').hidden = true;
  $('#admin-view').hidden = true;
  $('#design-view').hidden = true;
  $('#actions-view').hidden = true;
  view().hidden = false;
  await load();
}

async function load() {
  state.loading = true;
  render();
  try {
    const [liste, stats] = await Promise.all([
      api(`/api/cloudflare?search=${enc(state.search)}&status=${enc(state.filter)}&page=${state.page}&perPage=${state.perPage}`),
      state.stats ? Promise.resolve(state.stats) : api('/api/cloudflare/stats'),
    ]);
    Object.assign(state, { zones: liste.zones, total: liste.total, pages: liste.pages, page: liste.page, stats });
  } catch (err) {
    toastError(err);
    state.zones = [];
  }
  state.loading = false;
  render();
}

const rafraichirStats = async () => {
  try { state.stats = await api('/api/cloudflare/stats'); } catch { /* l'écran vit sans */ }
};

// ───────────────────────────── Rendu ─────────────────────────────

const pastille = (classe, ...contenu) => h('span', { class: `badge ${classe}` }, ...contenu);

/**
 * Un identifiant, tronqué mais copiable d'un clic.
 *
 * Ni le compte ni la zone ne sont des secrets : ce sont des références que l'agent
 * recopie dans d'autres outils, et les lire en entier à l'écran n'apporte rien. On les
 * raccourcit donc, en gardant le texte complet sous la souris et dans le presse-papier.
 */
function reference(libelle, valeur) {
  if (!valeur) return h('p', { class: 'text-[10px] text-ink-300' }, `${libelle} —`);
  const b = h(
    'button',
    {
      type: 'button',
      class: 'block max-w-44 truncate text-left font-mono text-[10px] text-ink-500 transition hover:text-accent-700',
      title: `${libelle} : ${valeur} — ${t('cf.click_to_copy')}`,
    },
    `${libelle} ${valeur.slice(0, 10)}…`,
  );
  b.addEventListener('click', () => copier(valeur, libelle));
  return b;
}

/** Copie dans le presse-papier, et le dit. */
async function copier(texte, quoi) {
  try {
    await navigator.clipboard.writeText(texte);
    toast(t('cf.copied', { what: quoi }), 'success');
  } catch {
    toast(t('cf.copy_failed'), 'error');
  }
}

const tuile = (valeur, libelle, tonValeur = 'text-ink') =>
  h(
    'div',
    { class: 'rounded-xl border border-ink-100 bg-white px-4 py-3' },
    h('p', { class: `text-xl font-semibold tabular-nums ${tonValeur}` }, fmtNum(valeur)),
    h('p', { class: 'mt-0.5 text-xs text-ink-400' }, libelle),
  );

function enteteStats() {
  const s = state.stats;
  if (!s) return h('div', {});
  const bloques = s.zones - s.ready;
  return h(
    'div',
    { class: 'grid grid-cols-2 gap-3 sm:grid-cols-4' },
    tuile(s.zones, t('cf.stat_domains')),
    tuile(s.ready, t('cf.stat_ready'), s.ready ? 'text-accent-700' : 'text-ink'),
    tuile(bloques, t('cf.stat_blocked'), bloques ? 'text-red-600' : 'text-ink'),
    tuile(s.accounts, t('cf.stat_accounts')),
  );
}

/** Le bandeau qui explique ce qui bloque, quand quelque chose bloque. */
function bandeauBlocage() {
  const s = state.stats;
  if (!s || (!s.withoutEmail && !s.withoutZone)) return null;
  const details = [];
  if (s.withoutEmail) details.push(t('cf.blocked_email', { count: fmtNum(s.withoutEmail), domain: s.emailDomain }));
  if (s.withoutZone) details.push(t('cf.blocked_zone', { count: fmtNum(s.withoutZone) }));
  return h(
    'div',
    { class: 'rounded-xl border border-amber-200 bg-amber-50 px-4 py-3' },
    h('p', { class: 'flex items-center gap-2 text-sm font-semibold text-amber-900' }, icon('alert', 'size-4'), t('cf.blocked_title')),
    ...details.map((d) => h('p', { class: 'mt-1 text-xs text-amber-800' }, d)),
  );
}

function barreRecherche() {
  const champ = h('input', {
    type: 'search',
    class: 'input',
    placeholder: t('cf.search_placeholder'),
    value: state.search,
    'aria-label': t('cf.search_placeholder'),
  });
  let minuteur = null;
  champ.addEventListener('input', () => {
    clearTimeout(minuteur);
    // On ne part pas au serveur à chaque frappe : l'agent tape un nom de domaine entier.
    minuteur = setTimeout(() => { state.search = champ.value.trim(); state.page = 1; load(); }, 300);
  });

  const filtre = (valeur, libelle) => {
    const actif = state.filter === valeur;
    const b = h('button', { type: 'button', class: `btn ${actif ? 'btn-primary' : 'btn-outline'} px-3 py-1.5 text-xs` }, libelle);
    b.addEventListener('click', () => { state.filter = actif ? '' : valeur; state.page = 1; load(); });
    return b;
  };

  return h(
    'div',
    { class: 'flex flex-wrap items-center gap-2' },
    h('div', { class: 'min-w-56 flex-1' }, champ),
    filtre('ready', t('cf.filter_ready')),
    filtre('blocked', t('cf.filter_blocked')),
  );
}

/** La barre d'actions de masse : elle n'apparaît qu'une fois des domaines choisis. */
function barreSelection() {
  const n = state.selected.size;
  if (!n) return null;
  const bouton = (libelle, ico, onclick, classe = 'btn-outline') => {
    const b = h('button', { type: 'button', class: `btn ${classe} px-3 py-1.5 text-xs`, disabled: Boolean(state.busy) }, icon(ico, 'size-3.5'), libelle);
    b.addEventListener('click', onclick);
    return b;
  };
  return h(
    'div',
    { class: 'flex flex-wrap items-center gap-2 rounded-xl border border-accent-200 bg-accent-50 px-4 py-3' },
    h('p', { class: 'flex-1 text-sm font-medium text-accent-700' }, t('cf.selected', { count: fmtNum(n) })),
    can('cloudflare.purge') ? bouton(t('cf.purge'), 'refresh', () => confirmerMasse('purge')) : null,
    can('cloudflare.write') ? bouton(t('cf.ssl_mode'), 'shield', () => confirmerMasse('ssl')) : null,
    can('cloudflare.write') ? bouton(t('cf.always_https'), 'lock', () => confirmerMasse('https')) : null,
    bouton(t('action.cancel'), 'close', () => { state.selected.clear(); render(); }, 'btn-ghost'),
  );
}

function ligne(z) {
  const choisi = state.selected.has(z.domain);
  const case_ = h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', 'aria-label': z.domain });
  case_.checked = choisi;
  case_.disabled = !z.ready;
  case_.addEventListener('change', () => {
    if (case_.checked) state.selected.add(z.domain); else state.selected.delete(z.domain);
    render();
  });

  const ssl = z.sslMode ? SSL_MODES.find((m) => m.value === z.sslMode) : null;

  return h(
    'tr',
    { class: `border-t border-ink-100 align-middle ${choisi ? 'bg-accent-50/60' : 'hover:bg-ink-50/50'}` },
    h('td', { class: 'px-4 py-2.5' }, case_),
    h(
      'td',
      { class: 'px-4 py-2.5' },
      h('span', { class: 'block text-sm font-medium text-ink' }, z.domain),
      z.lastError ? h('span', { class: 'mt-0.5 block max-w-md truncate text-[11px] text-red-600', title: z.lastError }, z.lastError) : null,
    ),
    h(
      'td',
      { class: 'px-4 py-2.5 whitespace-nowrap' },
      z.ready
        ? pastille(ETAT_TONS[z.status] ?? 'bg-ink-100 text-ink-600', z.status ? t(`cf.zone_${z.status}`, {}, z.status) : t('cf.zone_unknown'))
        : pastille('bg-red-100 text-red-700', icon('alert', 'size-3'), t('cf.not_ready')),
    ),
    h('td', { class: 'px-4 py-2.5 whitespace-nowrap' }, ssl ? pastille(ssl.tone, t(`cf.ssl_${ssl.value}`)) : h('span', { class: 'text-xs text-ink-300' }, '—')),
    h(
      'td',
      { class: 'px-4 py-2.5 whitespace-nowrap' },
      z.alwaysHttps == null
        ? h('span', { class: 'text-xs text-ink-300' }, '—')
        : pastille(z.alwaysHttps ? 'bg-accent-100 text-accent-700' : 'bg-ink-100 text-ink-500', z.alwaysHttps ? t('action.on') : t('action.off')),
    ),
    h(
      'td',
      { class: 'px-4 py-2.5 whitespace-nowrap' },
      reference(t('cf.col_account'), z.accountId),
      reference(t('cf.col_zone'), z.zoneId),
    ),
    h('td', { class: 'px-4 py-2.5 whitespace-nowrap text-xs text-ink-400' }, z.checkedAt ? fmtDate(z.checkedAt) : h('span', { class: 'text-ink-300' }, t('cf.never_checked'))),
    h(
      'td',
      { class: 'px-5 py-2 text-right' },
      h(
        'button',
        {
          type: 'button',
          class: 'btn btn-outline px-3 py-1 text-xs',
          disabled: !z.ready,
          title: z.ready ? t('cf.open_zone') : t('cf.not_ready_hint'),
          onclick: () => ouvrirZone(z.domain),
        },
        icon('eye', 'size-3.5'),
        t('cf.manage'),
      ),
    ),
  );
}

function pagination() {
  if (state.pages <= 1) return null;
  const aller = (p) => { state.page = p; state.selected.clear(); load(); };
  const b = (libelle, p, actif) => {
    const x = h('button', { type: 'button', class: `btn ${actif ? 'btn-primary' : 'btn-outline'} px-3 py-1 text-xs`, disabled: p < 1 || p > state.pages || state.loading }, libelle);
    x.addEventListener('click', () => aller(p));
    return x;
  };
  return h(
    'div',
    { class: 'flex flex-wrap items-center gap-2 border-t border-ink-100 px-5 py-3' },
    h('p', { class: 'flex-1 text-xs text-ink-400' }, t('cf.page_of', { page: state.page, pages: state.pages, total: fmtNum(state.total) })),
    b(t('action.previous'), state.page - 1, false),
    b(t('action.next'), state.page + 1, false),
  );
}

function tableau() {
  if (state.loading) {
    return h(
      'div',
      { class: 'flex items-center justify-center gap-3 px-6 py-16 text-sm text-ink-400' },
      icon('refresh', 'size-4 animate-spin'),
      t('cf.loading'),
    );
  }
  if (!state.zones.length) {
    return h(
      'div',
      { class: 'px-6 py-16 text-center' },
      h('p', { class: 'text-sm font-medium text-ink-500' }, t('cf.empty')),
      h('p', { class: 'mt-1 text-xs text-ink-400' }, state.search || state.filter ? t('cf.empty_filtered') : t('cf.empty_hint')),
    );
  }

  const prets = state.zones.filter((z) => z.ready);
  const toutChoisi = prets.length > 0 && prets.every((z) => state.selected.has(z.domain));
  const tout = h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', 'aria-label': t('cf.select_all') });
  tout.checked = toutChoisi;
  tout.disabled = !prets.length;
  tout.addEventListener('change', () => {
    for (const z of prets) if (tout.checked) state.selected.add(z.domain); else state.selected.delete(z.domain);
    render();
  });

  const th = (cle, extra = '') => h('th', { class: `px-4 py-2.5 font-semibold ${extra}` }, t(cle));
  return h(
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
          h('th', { class: 'px-4 py-2.5' }, tout),
          th('cf.col_domain'),
          th('cf.col_status'),
          th('cf.col_ssl'),
          th('cf.col_https'),
          th('cf.col_refs'),
          th('cf.col_checked'),
          th('col.actions', 'px-5 text-right'),
        ),
      ),
      h('tbody', {}, state.zones.map(ligne)),
    ),
  );
}

function render() {
  if (!state.open) return;
  view().replaceChildren(
    h(
      'div',
      { class: 'space-y-4' },
      h(
        'div',
        { class: 'flex flex-wrap items-start gap-3' },
        h(
          'div',
          { class: 'min-w-0 flex-1' },
          h('h1', { class: 'text-xl font-semibold text-ink' }, t('cf.title')),
          h('p', { class: 'mt-0.5 text-sm text-ink-400' }, t('cf.subtitle')),
        ),
        can('cloudflare.purge')
          ? h('button', { type: 'button', class: 'btn btn-outline px-3 py-1.5 text-xs', onclick: purgeCollee }, icon('list', 'size-3.5'), t('cf.paste_button'))
          : null,
        h('button', { type: 'button', class: 'btn btn-outline px-3 py-1.5 text-xs', disabled: state.loading, onclick: () => { state.stats = null; load(); } }, icon('refresh', `size-3.5 ${state.loading ? 'animate-spin' : ''}`), t('files.refresh')),
      ),
      enteteStats(),
      bandeauBlocage(),
      barreRecherche(),
      barreSelection(),
      h('section', { class: 'card overflow-hidden' }, tableau(), pagination()),
    ),
  );
}

// ───────────────────────── Actions de masse ─────────────────────────

/** Demande confirmation, puis exécute sur la sélection, et rend compte de chacun. */
function confirmerMasse(kind) {
  const domaines = [...state.selected];
  const corps = h('div', { class: 'space-y-3' });
  let options = {};

  if (kind === 'purge') {
    corps.append(
      h('p', { class: 'rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900' }, t('cf.purge_warning')),
    );
    options = { everything: true };
  } else if (kind === 'ssl') {
    const choix = h('select', { class: 'input' }, ...SSL_MODES.map((m) => h('option', { value: m.value }, t(`cf.ssl_${m.value}`))));
    choix.value = 'full';
    const avertit = h('p', { class: 'text-xs text-red-600', hidden: true }, t('cf.ssl_off_warning'));
    choix.addEventListener('change', () => { avertit.hidden = choix.value !== 'off'; options = { mode: choix.value }; });
    options = { mode: 'full' };
    corps.append(h('label', { class: 'label' }, t('cf.ssl_mode')), choix, avertit);
  } else {
    const choix = h('select', { class: 'input' }, h('option', { value: 'on' }, t('action.on')), h('option', { value: 'off' }, t('action.off')));
    choix.addEventListener('change', () => { options = { enabled: choix.value === 'on' }; });
    options = { enabled: true };
    corps.append(h('label', { class: 'label' }, t('cf.always_https')), choix);
  }

  const erreur = h('div', { class: 'mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const valider = h('button', { type: 'submit', class: `btn ${kind === 'purge' ? 'btn-danger' : 'btn-primary'}` }, t('action.confirm'));

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        valider.disabled = true;
        valider.textContent = t('action.working');
        try {
          const out = await api('/api/cloudflare/bulk', { method: 'POST', body: { kind, domains: domaines, options } });
          closeModal();
          montrerReleve(kind, out);
          state.selected.clear();
          await rafraichirStats();
          await load();
        } catch (err) {
          formError(err, erreur);
          valider.disabled = false;
          valider.textContent = t('action.confirm');
        }
      },
    },
    modalHeader(t(`cf.confirm_${kind}`), kind === 'purge' ? 'bg-red-50 text-red-600' : 'bg-accent-50 text-accent-700', kind === 'purge' ? 'trash' : 'shield'),
    h('p', { class: 'rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-600' }, t('cf.bulk_scope', { count: fmtNum(domaines.length) })),
    h('div', { class: 'mt-3' }, corps),
    erreur,
    h(
      'div',
      { class: 'mt-6 flex justify-end gap-2' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')),
      valider,
    ),
  );
  openModal(form, 'max-w-lg');
}

/**
 * Purger le cache d'une liste de domaines COLLÉE.
 *
 * Cocher trente-huit mille lignes une par une n'a pas de sens : l'agent a sa liste
 * ailleurs — un tableur, un courriel, une autre console — et veut la coller telle
 * quelle. Une ligne peut porter ses propres accès, pour un domaine que la base ne
 * connaît pas encore.
 */
function purgeCollee() {
  const zone = h('textarea', {
    class: 'input min-h-40 font-mono text-xs',
    placeholder: 'exemple.com\nautre-exemple.fr',
    spellcheck: 'false',
  });
  const compteur = h('p', { class: 'text-[11px] text-ink-400' }, t('cf.paste_count', { count: 0 }));
  zone.addEventListener('input', () => {
    const n = zone.value.split(/[\r\n,\t]+/).filter((l) => l.trim() && !l.trim().startsWith('#')).length;
    compteur.textContent = t('cf.paste_count', { count: fmtNum(n) });
  });

  const adresses = h('input', { type: 'text', class: 'input font-mono text-xs', placeholder: 'https://exemple.com/page  (vide = tout le cache)' });

  const erreur = h('div', { class: 'mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const valider = h('button', { type: 'submit', class: 'btn btn-danger' }, icon('trash', 'size-4'), t('cf.purge'));

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        const texte = zone.value.trim();
        if (!texte) { formError(new Error(t('cf.paste_empty')), erreur); return; }
        valider.disabled = true;
        valider.textContent = t('action.working');
        const urls = adresses.value.split(/\s+/).map((u) => u.trim()).filter(Boolean);
        try {
          const out = await api('/api/cloudflare/purge', {
            method: 'POST',
            body: { text: texte, everything: urls.length === 0, files: urls },
          });
          closeModal();
          montrerReleve('purge', out);
          await load();
        } catch (err) {
          formError(err, erreur);
          valider.disabled = false;
          valider.textContent = t('cf.purge');
        }
      },
    },
    modalHeader(t('cf.paste_title'), 'bg-red-50 text-red-600', 'trash'),
    h(
      'div',
      { class: 'space-y-3' },
      h('p', { class: 'rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900' }, t('cf.purge_warning_single')),
      h('div', { class: 'grid gap-1' }, h('label', { class: 'label' }, t('cf.paste_label')), zone, compteur),
      h(
        'div',
        { class: 'grid gap-1' },
        h('label', { class: 'label' }, t('cf.paste_urls')),
        adresses,
        h('p', { class: 'text-[11px] text-ink-400' }, t('cf.paste_urls_hint')),
      ),
      h('p', { class: 'text-[11px] text-ink-400' }, t('cf.paste_format')),
    ),
    erreur,
    h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), valider),
  );
  openModal(form, 'max-w-2xl');
}

/** Le relevé d'une opération de masse : ce qui a marché, ce qui a échoué, et pourquoi. */
function montrerReleve(kind, out) {
  const rates = [...(out.results ?? []).filter((r) => !r.ok), ...(out.skipped ?? []).map((s) => ({ domain: s.domain, error: t(s.reason, {}, s.reason) }))];
  const tout = rates.length === 0;

  // LE RELEVÉ S'AFFICHE TOUJOURS, même quand tout a réussi.
  //
  // Une version précédente se contentait d'un message fugace en cas de succès complet.
  // L'agent lançait une purge sur quarante domaines, voyait passer une ligne, et ne
  // savait plus ensuite si elle était allée au bout. Une opération qu'on ne voit pas
  // finir, on la relance — et on purge deux fois.
  openModal(
    h(
      'div',
      { class: 'card w-full p-0' },
      modalHeader(
        tout ? t('cf.bulk_done_title') : t(`cf.confirm_${kind}`),
        tout ? 'bg-accent-50 text-accent-700' : 'bg-ink-50 text-ink-600',
        tout ? 'check' : 'alert',
      ),
      h(
        'div',
        { class: 'space-y-3 px-6 py-5' },
        h(
          'p',
          { class: `rounded-lg px-3 py-2 text-sm ${tout ? 'bg-accent-50 text-accent-700' : 'bg-ink-50 text-ink-600'}` },
          tout ? t('cf.bulk_done', { count: fmtNum(out.succeeded) }) : t('cf.bulk_partial', { done: fmtNum(out.succeeded), failed: fmtNum(rates.length) }),
        ),
        h(
          'div',
          { class: 'flex flex-wrap gap-2' },
          pastille('bg-accent-100 text-accent-700', t('cf.bulk_succeeded', { count: fmtNum(out.succeeded) })),
          rates.length ? pastille('bg-red-100 text-red-700', t('cf.bulk_failed', { count: fmtNum(rates.length) })) : null,
        ),
        rates.length
          ? h(
              'div',
              { class: 'max-h-80 overflow-auto rounded-lg border border-ink-200' },
              ...rates.map((r) => h(
                'div',
                { class: 'flex gap-3 border-b border-ink-50 px-3 py-2 last:border-b-0' },
                h('span', { class: 'w-56 shrink-0 truncate font-mono text-xs text-ink-600', title: r.domain }, r.domain),
                h('span', { class: 'min-w-0 flex-1 text-xs text-red-600' }, r.error),
              )),
            )
          : null,
        tout && kind === 'purge' ? h('p', { class: 'text-[11px] text-ink-400' }, t('cf.purge_after_hint')) : null,
      ),
      h('div', { class: 'flex justify-end border-t border-ink-100 px-6 py-4' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: closeModal }, t('action.close'))),
    ),
    'max-w-2xl',
  );
}

// ───────────────────────── Le détail d'une zone ─────────────────────────

async function ouvrirZone(domain) {
  let detail;
  try {
    detail = await api(`/api/cloudflare/zones/${enc(domain)}`);
  } catch (err) {
    return toastError(err);
  }
  rendreZone(detail);
}

function rendreZone(detail) {
  const { domain, zone, settings, dns } = detail;
  const corps = h('div', { class: 'space-y-5 px-6 py-5' });

  const majReglage = async (setting, value, bouton) => {
    const avant = bouton.textContent;
    bouton.disabled = true;
    bouton.textContent = t('action.working');
    try {
      await api(`/api/cloudflare/zones/${enc(domain)}/setting`, { method: 'PATCH', body: { setting, value } });
      toast(t('cf.setting_saved'), 'success');
      const frais = await api(`/api/cloudflare/zones/${enc(domain)}`);
      closeModal();
      rendreZone(frais);
      load();
    } catch (err) {
      toastError(err);
      bouton.disabled = false;
      bouton.textContent = avant;
    }
  };

  /** Une ligne de réglage : son nom, sa valeur actuelle, et de quoi la changer. */
  const reglage = (cle, libelle, controle, aide = '') =>
    h(
      'div',
      { class: 'grid gap-2 border-b border-ink-50 py-3 last:border-b-0 sm:grid-cols-[14rem_1fr] sm:items-center' },
      h(
        'div',
        {},
        h('p', { class: 'text-sm font-medium text-ink-700' }, libelle),
        aide ? h('p', { class: 'mt-0.5 text-[11px] text-ink-400' }, aide) : null,
      ),
      controle,
      void cle,
    );

  const choixAvecBouton = (cle, valeurs, actuelle, etiquette) => {
    const select = h('select', { class: 'input max-w-xs', disabled: !can('cloudflare.write') }, ...valeurs.map((v) => h('option', { value: v }, etiquette(v))));
    select.value = actuelle ?? valeurs[0];
    const appliquer = h('button', { type: 'button', class: 'btn btn-primary px-3 py-1.5 text-xs', disabled: !can('cloudflare.write') }, t('action.apply'));
    appliquer.addEventListener('click', () => majReglage(cle, select.value, appliquer));
    return h('div', { class: 'flex flex-wrap items-center gap-2' }, select, appliquer);
  };

  const interrupteur = (cle, actif) => {
    const b = h(
      'button',
      { type: 'button', class: `btn ${actif ? 'btn-primary' : 'btn-outline'} px-3 py-1.5 text-xs`, disabled: !can('cloudflare.write') },
      icon(actif ? 'check' : 'close', 'size-3.5'),
      actif ? t('action.on') : t('action.off'),
    );
    b.addEventListener('click', () => majReglage(cle, !actif, b));
    return b;
  };

  // ── L'état de la zone, toujours visible ──
  const entete = h(
    'div',
    { class: 'flex flex-wrap items-center gap-2 px-6 pb-3' },
    pastille(ETAT_TONS[zone.status] ?? 'bg-ink-100 text-ink-600', t(`cf.zone_${zone.status}`, {}, zone.status)),
    pastille('bg-ink-100 text-ink-600', zone.plan || '—'),
    zone.paused ? pastille('bg-amber-100 text-amber-800', t('cf.zone_paused')) : null,
    h('span', { class: 'flex-1' }),
    h('span', { class: 'truncate text-[11px] text-ink-400', title: (zone.nameServers ?? []).join(' · ') }, (zone.nameServers ?? []).join(' · ')),
  );

  // ── Les réglages ──
  const bloc = h('div', { class: 'rounded-xl border border-ink-100 px-4' });
  bloc.append(
    reglage('ssl', t('cf.ssl_mode'), choixAvecBouton('ssl', SSL_MODES.map((m) => m.value), settings.ssl, (v) => t(`cf.ssl_${v}`)), t('cf.ssl_hint')),
    reglage('always_use_https', t('cf.always_https'), interrupteur('always_use_https', settings.always_use_https === 'on'), t('cf.always_https_hint')),
    reglage('development_mode', t('cf.dev_mode'), interrupteur('development_mode', settings.development_mode === 'on'), t('cf.dev_mode_hint')),
    reglage('security_level', t('cf.security_level'), choixAvecBouton('security_level', SECURITY_LEVELS, settings.security_level, (v) => t(`cf.sec_${v}`)), t('cf.security_hint')),
    reglage('browser_cache_ttl', t('cf.browser_cache'), choixAvecBouton('browser_cache_ttl', ['0', '1800', '3600', '14400', '86400', '604800'], String(settings.browser_cache_ttl ?? '0'), (v) => (v === '0' ? t('cf.cache_respect_origin') : t('cf.cache_seconds', { n: fmtNum(Number(v)) }))), t('cf.browser_cache_hint')),
  );

  // La minification : deux cases, car Cloudflare a retiré le JavaScript en 2024.
  const mini = settings.minify ?? {};
  const caseMini = (nom) => {
    const c = h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', disabled: !can('cloudflare.write'), 'aria-label': nom });
    c.checked = mini[nom] === 'on';
    return c;
  };
  const css = caseMini('css');
  const html = caseMini('html');
  const appliquerMini = h('button', { type: 'button', class: 'btn btn-primary px-3 py-1.5 text-xs', disabled: !can('cloudflare.write') }, t('action.apply'));
  appliquerMini.addEventListener('click', () => majReglage('minify', { css: css.checked, html: html.checked }, appliquerMini));
  bloc.append(reglage(
    'minify',
    t('cf.minify'),
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-3' },
      h('label', { class: 'flex items-center gap-1.5 text-xs text-ink-600' }, css, 'CSS'),
      h('label', { class: 'flex items-center gap-1.5 text-xs text-ink-600' }, html, 'HTML'),
      appliquerMini,
    ),
    t('cf.minify_hint'),
  ));
  // ── La purge ──
  let blocCache = null;
  if (can('cloudflare.purge')) {
    const adresse = h('input', { type: 'url', class: 'input', placeholder: `https://${domain}/page` });
    const purgerUne = h('button', { type: 'button', class: 'btn btn-outline px-3 py-1.5 text-xs' }, icon('refresh', 'size-3.5'), t('cf.purge_url'));
    const purgerTout = h('button', { type: 'button', class: 'btn btn-danger px-3 py-1.5 text-xs' }, icon('trash', 'size-3.5'), t('cf.purge_all'));
    const lancer = async (bouton, corpsPurge) => {
      bouton.disabled = true;
      try {
        await api(`/api/cloudflare/zones/${enc(domain)}/purge`, { method: 'POST', body: corpsPurge });
        toast(t('cf.purge_done', { domain }), 'success');
        adresse.value = '';
      } catch (err) { toastError(err); }
      bouton.disabled = false;
    };
    purgerUne.addEventListener('click', () => (adresse.value.trim() ? lancer(purgerUne, { files: [adresse.value.trim()] }) : toast(t('cf.purge_url_needed'), 'info')));
    purgerTout.addEventListener('click', () => lancer(purgerTout, { everything: true }));

    blocCache = h(
      'div',
      { class: 'rounded-xl border border-ink-100 p-4' },
      h('p', { class: 'text-sm font-medium text-ink-700' }, t('cf.cache')),
      h('p', { class: 'mt-0.5 text-[11px] text-ink-400' }, t('cf.purge_hint')),
      h('div', { class: 'mt-3 flex flex-wrap items-center gap-2' }, h('div', { class: 'min-w-48 flex-1' }, adresse), purgerUne, purgerTout),
    );
  }

  /**
   * DES ONGLETS, et non un empilement.
   *
   * Tout mis bout à bout, la fenêtre faisait deux écrans et demi : l'agent devait
   * dérouler longuement pour atteindre le DNS, et perdait de vue ce qu'il cherchait.
   * Quatre volets, un seul à la fois, et l'état de la zone reste visible au-dessus.
   *
   * Les contenus sont construits UNE fois et seulement montrés ou cachés : la clé
   * révélée, une adresse à demi saisie ou un formulaire ouvert survivent au changement
   * d'onglet.
   */
  const volets = [
    { cle: 'settings', libelle: t('cf.tab_settings'), ico: 'wrench', contenu: bloc },
    blocCache ? { cle: 'cache', libelle: t('cf.cache'), ico: 'refresh', contenu: blocCache } : null,
    { cle: 'dns', libelle: t('cf.dns'), ico: 'list', contenu: blocDns(domain, dns) },
    { cle: 'access', libelle: t('cf.credentials'), ico: 'lock', contenu: blocAcces(domain, zone) },
  ].filter(Boolean);

  const barre = h('div', { class: 'flex flex-wrap gap-1 border-b border-ink-100 px-6' });
  const montrer = (cle) => {
    for (const v of volets) v.contenu.hidden = v.cle !== cle;
    for (const v of volets) v.bouton.setAttribute('aria-selected', String(v.cle === cle));
    for (const v of volets) {
      v.bouton.className = `-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
        v.cle === cle ? 'border-accent text-ink' : 'border-transparent text-ink-400 hover:text-ink-600'
      }`;
    }
  };
  for (const v of volets) {
    v.bouton = h('button', { type: 'button', role: 'tab' }, icon(v.ico, 'size-3.5 mr-1.5 inline-block align-[-2px]'), v.libelle);
    v.bouton.addEventListener('click', () => montrer(v.cle));
    barre.append(v.bouton);
    corps.append(v.contenu);
  }
  montrer(volets[0].cle);

  openModal(
    h(
      'div',
      { class: 'card w-full p-0' },
      h('div', { class: 'px-6 pt-6' }, modalHeader(domain, 'bg-accent-50 text-accent-700', 'globe')),
      entete,
      barre,
      corps,
      h('div', { class: 'flex justify-end border-t border-ink-100 px-6 py-4' }, h('button', { type: 'button', class: 'btn btn-outline', onclick: closeModal }, t('action.close'))),
    ),
    'max-w-3xl',
  );
}

/**
 * Les accès du domaine : identifiants de compte et de zone, adresse, et clé.
 *
 * La clé globale n'est PAS affichée d'emblée. Elle ouvre le compte Cloudflare en
 * entier — Cloudflare la masque lui-même derrière un bouton, pour cette raison. Ici
 * elle se demande, et la demande part au journal d'audit : on saura toujours qui l'a
 * révélée, pour quel domaine, et quand.
 *
 * Les identifiants de compte et de zone, eux, s'affichent directement : ce sont des
 * références, pas des secrets.
 */
function blocAcces(domain, zone) {
  const champ = (libelle, valeur, { mono = true } = {}) => {
    const texte = h('span', { class: `block min-w-0 flex-1 truncate ${mono ? 'font-mono' : ''} text-xs text-ink-600`, title: valeur ?? '' }, valeur || '—');
    const copie = h('button', { type: 'button', class: 'icon-btn', title: t('cf.click_to_copy'), 'aria-label': t('cf.click_to_copy'), disabled: !valeur }, icon('file', 'size-3.5'));
    copie.addEventListener('click', () => copier(valeur, libelle));
    return h(
      'div',
      { class: 'flex items-center gap-2 border-b border-ink-50 py-2 last:border-b-0' },
      h('span', { class: 'w-40 shrink-0 text-[11px] text-ink-400' }, libelle),
      texte,
      copie,
    );
  };

  const ligneCle = h('div', { class: 'flex items-center gap-2 border-b border-ink-50 py-2 last:border-b-0' });
  const peindreCle = (valeur = null) => {
    const montre = h('span', { class: 'block min-w-0 flex-1 truncate font-mono text-xs text-ink-600' }, valeur ?? '••••••••••••••••••••••••••••••••');
    const enfants = [h('span', { class: 'w-40 shrink-0 text-[11px] text-ink-400' }, t('cf.credential_key')), montre];

    if (valeur) {
      const copie = h('button', { type: 'button', class: 'icon-btn', title: t('cf.click_to_copy'), 'aria-label': t('cf.click_to_copy') }, icon('file', 'size-3.5'));
      copie.addEventListener('click', () => copier(valeur, t('cf.credential_key')));
      const cacher = h('button', { type: 'button', class: 'btn btn-ghost px-2 py-1 text-[11px]' }, t('cf.hide'));
      cacher.addEventListener('click', () => peindreCle(null));
      enfants.push(copie, cacher);
    } else {
      const reveler = h('button', { type: 'button', class: 'btn btn-outline px-2.5 py-1 text-[11px]', disabled: !can('cloudflare.write'), title: can('cloudflare.write') ? t('cf.reveal_hint') : t('reason.permission_denied') }, icon('eye', 'size-3'), t('cf.reveal'));
      reveler.addEventListener('click', async () => {
        reveler.disabled = true;
        try {
          const acces = await api(`/api/cloudflare/zones/${enc(domain)}/credentials`);
          peindreCle(acces.apiToken || acces.globalApiKey || '—');
        } catch (err) {
          toastError(err);
          reveler.disabled = false;
        }
      });
      enfants.push(reveler);
    }
    ligneCle.replaceChildren(...enfants);
  };
  peindreCle(null);

  return h(
    'div',
    { class: 'rounded-xl border border-ink-100 p-4' },
    h('p', { class: 'text-sm font-medium text-ink-700' }, t('cf.credentials')),
    h('p', { class: 'mt-0.5 text-[11px] text-ink-400' }, t('cf.credentials_hint')),
    h(
      'div',
      { class: 'mt-2' },
      champ(t('cf.col_account'), zone.accountId),
      champ(t('cf.col_zone'), zone.id),
      champ(t('cf.credential_email'), zone.email ?? `${domain}@linkuma.co`, { mono: false }),
      ligneCle,
    ),
  );
}

/**
 * Les enregistrements DNS, présentés comme chez Cloudflare.
 *
 * L'agent travaille avec les deux écrans côte à côte : les mêmes colonnes, dans le même
 * ordre, lui évitent de retraduire ce qu'il voit. D'où « Nom, Type, Contenu, Relais,
 * TTL », et un bouton « Modifier » par ligne plutôt qu'une suppression sèche — se
 * tromper d'une adresse IP et devoir tout retaper est le genre de détail qui use.
 */
function blocDns(domain, records) {
  const etat = { records: [...(records ?? [])] };
  const corps = h('div', {});

  const tableau = () => {
    if (!etat.records.length) return h('p', { class: 'px-3 py-6 text-center text-xs text-ink-400' }, t('cf.dns_empty'));

    const th = (libelle, extra = '') => h('th', { class: `px-3 py-2 font-semibold ${extra}` }, libelle);
    return h(
      'div',
      { class: 'overflow-x-auto' },
      h(
        'table',
        { class: 'w-full text-left' },
        h(
          'thead',
          { class: 'bg-ink-50/60 text-[11px] tracking-wide text-ink-500 uppercase' },
          h('tr', {}, th(t('cf.dns_col_name')), th(t('cf.dns_col_type')), th(t('cf.dns_col_content')), th(t('cf.dns_col_proxy')), th(t('cf.dns_col_ttl')), th(t('col.actions'), 'text-right')),
        ),
        h('tbody', {}, ...etat.records.map(ligneDns)),
      ),
    );
  };

  const ligneDns = (r) => {
    const modifier = h(
      'button',
      { type: 'button', class: 'btn btn-outline px-2.5 py-1 text-[11px]', disabled: !can('cloudflare.write'), title: t('cf.dns_edit') },
      icon('pencil', 'size-3'),
      t('cf.dns_edit'),
    );
    modifier.addEventListener('click', () => editeurDns(r));

    const supprimer = h('button', { type: 'button', class: 'icon-btn hover:bg-red-50 hover:text-red-600', title: t('action.delete'), 'aria-label': t('action.delete'), disabled: !can('cloudflare.write') }, icon('trash', 'size-3.5'));
    supprimer.addEventListener('click', () => confirmerSuppressionDns(r));

    return h(
      'tr',
      { class: 'border-t border-ink-100 align-middle hover:bg-ink-50/40' },
      h('td', { class: 'px-3 py-2' }, h('span', { class: 'block max-w-56 truncate text-xs text-ink-700', title: r.name }, r.name)),
      h('td', { class: 'px-3 py-2' }, h('span', { class: 'font-mono text-[11px] font-semibold text-ink-600' }, r.type)),
      h('td', { class: 'px-3 py-2' }, h('span', { class: 'block max-w-72 truncate font-mono text-[11px] text-ink-500', title: r.content }, r.content)),
      h(
        'td',
        { class: 'px-3 py-2 whitespace-nowrap' },
        r.proxied
          ? h('span', { class: 'badge bg-amber-100 text-amber-800' }, icon('globe', 'size-3'), t('cf.dns_proxied'))
          : h('span', { class: 'text-[11px] text-ink-400' }, t('cf.dns_direct')),
      ),
      h('td', { class: 'px-3 py-2 whitespace-nowrap text-[11px] text-ink-500' }, r.ttl === 1 ? t('cf.dns_ttl_auto') : t('cf.cache_seconds', { n: fmtNum(r.ttl) })),
      h('td', { class: 'px-3 py-2' }, h('div', { class: 'flex justify-end gap-1' }, modifier, supprimer)),
    );
  };

  const recharger = async () => {
    try {
      const frais = await api(`/api/cloudflare/zones/${enc(domain)}`);
      etat.records = frais.dns ?? [];
      corps.replaceChildren(tableau());
    } catch (err) { toastError(err); }
  };

  /**
   * Le formulaire d'un enregistrement, pour en créer un ou en modifier un.
   * Les mêmes champs dans les deux cas : l'agent n'a qu'une seule chose à apprendre.
   */
  const editeurDns = (existant = null) => {
    const type = h('select', { class: 'input' }, ...['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'CAA'].map((x) => h('option', { value: x }, x)));
    const nom = h('input', { type: 'text', class: 'input', placeholder: t('cf.dns_name_placeholder') });
    const valeur = h('input', { type: 'text', class: 'input', placeholder: t('cf.dns_content_placeholder') });
    const ttl = h('select', { class: 'input' }, h('option', { value: '1' }, t('cf.dns_ttl_auto')), ...['60', '300', '1800', '3600', '86400'].map((v) => h('option', { value: v }, t('cf.cache_seconds', { n: fmtNum(Number(v)) }))));
    const priorite = h('input', { type: 'number', class: 'input', min: '0', max: '65535', placeholder: '10' });
    const relais = h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', 'aria-label': t('cf.dns_proxied') });

    if (existant) {
      type.value = existant.type;
      nom.value = existant.name;
      valeur.value = existant.content;
      ttl.value = String(existant.ttl ?? 1);
      relais.checked = Boolean(existant.proxied);
      if (existant.priority != null) priorite.value = String(existant.priority);
    }

    // Seuls A, AAAA et CNAME peuvent passer par Cloudflare ; la priorité ne concerne
    // que MX. Griser ce qui ne s'applique pas vaut mieux que de le laisser tromper.
    const ligneMx = h('div', { class: 'grid gap-1' }, h('label', { class: 'label' }, t('cf.dns_priority')), priorite);
    const refletType = () => {
      const relayable = ['A', 'AAAA', 'CNAME'].includes(type.value);
      relais.disabled = !relayable;
      if (!relayable) relais.checked = false;
      ligneMx.hidden = type.value !== 'MX';
    };
    type.addEventListener('change', refletType);
    refletType();

    const erreur = h('div', { class: 'mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
    const valider = h('button', { type: 'submit', class: 'btn btn-primary' }, existant ? t('action.save') : t('action.add'));

    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          valider.disabled = true;
          valider.textContent = t('action.working');
          const corpsRecord = {
            type: type.value,
            name: nom.value.trim(),
            content: valeur.value.trim(),
            ttl: Number(ttl.value),
            proxied: relais.checked,
            ...(type.value === 'MX' ? { priority: Number(priorite.value || 10) } : {}),
          };
          try {
            if (existant) await api(`/api/cloudflare/zones/${enc(domain)}/dns/${enc(existant.id)}`, { method: 'PUT', body: corpsRecord });
            else await api(`/api/cloudflare/zones/${enc(domain)}/dns`, { method: 'POST', body: corpsRecord });
            closeModal();
            toast(existant ? t('cf.dns_updated') : t('cf.dns_created'), 'success');
            await recharger();
          } catch (err) {
            formError(err, erreur);
            valider.disabled = false;
            valider.textContent = existant ? t('action.save') : t('action.add');
          }
        },
      },
      modalHeader(existant ? t('cf.dns_edit_title') : t('cf.dns_add_title'), 'bg-accent-50 text-accent-700', 'list'),
      h(
        'div',
        { class: 'grid gap-3 sm:grid-cols-2' },
        h('div', { class: 'grid gap-1' }, h('label', { class: 'label' }, t('cf.dns_col_type')), type),
        h('div', { class: 'grid gap-1' }, h('label', { class: 'label' }, t('cf.dns_col_ttl')), ttl),
        h('div', { class: 'grid gap-1 sm:col-span-2' }, h('label', { class: 'label' }, t('cf.dns_col_name')), nom),
        h('div', { class: 'grid gap-1 sm:col-span-2' }, h('label', { class: 'label' }, t('cf.dns_col_content')), valeur),
        ligneMx,
        h('label', { class: 'flex items-center gap-2 text-sm text-ink-600 sm:col-span-2' }, relais, h('span', {}, t('cf.dns_proxy_hint'))),
      ),
      erreur,
      h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), valider),
    );
    openModal(form, 'max-w-xl');
  };

  const confirmerSuppressionDns = (r) => {
    const erreur = h('div', { class: 'mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
    const valider = h('button', { type: 'submit', class: 'btn btn-danger' }, t('action.delete'));
    openModal(
      h(
        'form',
        {
          onsubmit: async (e) => {
            e.preventDefault();
            valider.disabled = true;
            try {
              await api(`/api/cloudflare/zones/${enc(domain)}/dns/${enc(r.id)}`, { method: 'DELETE' });
              closeModal();
              toast(t('cf.dns_deleted'), 'success');
              await recharger();
            } catch (err) { formError(err, erreur); valider.disabled = false; }
          },
        },
        modalHeader(t('cf.dns_delete_title'), 'bg-red-50 text-red-600', 'trash'),
        h('p', { class: 'rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-600' }, t('cf.dns_delete_warning', { type: r.type, name: r.name, content: r.content.slice(0, 60) })),
        erreur,
        h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), valider),
      ),
      'max-w-lg',
    );
  };

  corps.replaceChildren(tableau());

  const ajouter = h('button', { type: 'button', class: 'btn btn-primary px-3 py-1.5 text-xs', disabled: !can('cloudflare.write') }, icon('plus', 'size-3.5'), t('cf.dns_add'));
  ajouter.addEventListener('click', () => editeurDns(null));

  return h(
    'div',
    { class: 'rounded-xl border border-ink-100 p-4' },
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-2' },
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h('p', { class: 'text-sm font-medium text-ink-700' }, t('cf.dns')),
        h('p', { class: 'mt-0.5 text-[11px] text-ink-400' }, t('cf.dns_hint')),
      ),
      ajouter,
    ),
    h('div', { class: 'mt-3 max-h-72 overflow-auto rounded-lg border border-ink-200' }, corps),
  );
}
