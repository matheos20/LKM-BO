import { api } from './api.js';
import { t } from './i18n.js';
import { $, enc, fmtNum, h, icon, toast, toastError } from './ui.js';

/**
 * Écran de traduction des pages d'accueil.
 *
 * Il s'adresse à un agent, pas à un développeur. Trois temps, et rien d'autre :
 *   1. ANALYSER — le back-office lit la page d'accueil de chaque site du serveur et
 *      repère les textes rédigés dans une autre langue. Rien n'est modifié.
 *   2. RELIRE  — pour chaque site, l'emplacement du texte est nommé en clair
 *      (« Bannière — Titre »), la traduction connue est déjà proposée, et l'agent
 *      corrige ce qu'il veut avant de décocher ce qu'il ne veut pas.
 *   3. APPLIQUER — l'écriture emprunte le circuit de publication du site : sauvegarde
 *      horodatée, contrôle de syntaxe, relecture de contrôle.
 *
 * L'analyse avance par lots, pour que la progression soit visible et interruptible :
 * un serveur du parc porte plusieurs milliers de domaines.
 */

/** Taille d'un lot d'analyse : la progression reste visible, le serveur travaille en continu. */
const BATCH = 100;

const state = {
  open: false,
  serverId: null,
  serverLabel: '',
  permissions: [],
  machine: false,
  domains: [],
  phase: 'idle', // idle | scanning | done
  scanned: 0,
  cancel: false,
  sites: [], // sites porteurs d'au moins un texte à traduire
  failed: [], // sites illisibles
  selected: null,
  edits: new Map(), // domaine → Map(chemin → { keep, value })
  doneDomains: new Map(), // domaine → nombre de textes appliqués
  filter: '',
  onClose: null,
};

export const isTranslateOpen = () => state.open;
export const rerenderTranslate = () => state.open && render();

const can = (perm) => state.permissions.includes(perm);

export async function openTranslate({ serverId, serverLabel, permissions, onClose }) {
  Object.assign(state, {
    open: true,
    serverId,
    serverLabel: serverLabel ?? serverId,
    permissions: permissions ?? [],
    domains: [],
    phase: 'idle',
    scanned: 0,
    cancel: false,
    sites: [],
    failed: [],
    selected: null,
    filter: '',
    onClose,
  });
  state.edits.clear();
  state.doneDomains.clear();

  $('#domains-view').hidden = true;
  $('#files-view').hidden = true;
  $('#admin-view').hidden = true;
  $('#design-view').hidden = true;
  $('#translate-view').hidden = false;
  $('#btn-back').hidden = false;
  for (const sel of ['#btn-conn', '#btn-refresh', '#btn-add']) $(sel).hidden = true;

  render();
  // La liste complète des domaines du serveur : le tableau n'en montre qu'une page,
  // mais une analyse de parc doit les connaître tous.
  try {
    const [status, list] = await Promise.all([
      api(`/api/servers/${enc(serverId)}/translation/status`).catch(() => ({ machine: false })),
      api(`/api/servers/${enc(serverId)}/domain-names`),
    ]);
    if (!state.open || state.serverId !== serverId) return;
    state.machine = Boolean(status.machine);
    state.domains = list.domains ?? [];
  } catch (err) {
    toastError(err);
  }
  render();
}

export function closeTranslate() {
  if (!state.open) return;
  state.open = false;
  state.cancel = true;
  $('#translate-view').hidden = true;
  $('#translate-view').replaceChildren();
  $('#domains-view').hidden = false;
  $('#btn-back').hidden = true;
  for (const sel of ['#btn-refresh', '#btn-add']) $(sel).hidden = false;
  state.onClose?.();
}

// ───────────────────────── Emplacements lisibles ─────────────────────────

/**
 * Traduit un chemin de configuration en emplacement compréhensible.
 * « homepage.faq.items.2.q » devient « Questions fréquentes — Question 3 ».
 */
export function whereLabel(path) {
  const parts = String(path ?? '').split('.');
  if (parts[0] === 'site_tagline') return t('translate.where.site_tagline');
  if (parts[0] === 'header_cta_text') return t('translate.where.header_cta_text');
  if (parts[0] !== 'homepage' || parts.length < 2) return path;

  // Champ posé directement sur la page, hors bloc : « homepage.meta_description ».
  if (parts.length === 2) {
    const field = t(`design.field.${parts[1]}`);
    if (!field.startsWith('design.field.')) return field;
  }

  const family = t(`design.family.${parts[1]}`);
  const head = family.startsWith('design.family.') ? parts[1] : family;
  const rest = parts.slice(2);
  if (!rest.length) return head;

  // Élément d'une liste : « items.2.q » ou « features.1 ».
  const idx = rest.findIndex((seg) => /^\d+$/.test(seg));
  if (idx !== -1) {
    const leaf = rest[idx + 1] ?? rest[idx - 1];
    const label = t(`design.field.${leaf}`);
    const name = label.startsWith('design.field.') ? leaf : label;
    return `${head} — ${name} ${Number(rest[idx]) + 1}`;
  }
  const leaf = rest[rest.length - 1];
  const label = t(`design.field.${leaf}`);
  return `${head} — ${label.startsWith('design.field.') ? leaf : label}`;
}

/**
 * Un texte de quatre mots dont deux sont des mots outils communs à deux langues
 * (« en », « de », « je ») peut être mal classé. Ces cas restent affichés — sinon de
 * vrais oublis passeraient à la trappe — mais signalés comme incertains.
 */
const uncertain = (item) => item.source === 'detected' && ((item.words ?? 9) < 5 || (item.gap ?? 9) < 2);

const langName = (code) => {
  if (!code) return '—';
  const label = t(`translate.lang.${code}`);
  return label.startsWith('translate.lang.') ? code : label;
};

// ───────────────────────── Analyse ─────────────────────────

const editsFor = (domain) => {
  if (!state.edits.has(domain)) state.edits.set(domain, new Map());
  return state.edits.get(domain);
};

async function runScan() {
  const all = state.domains.filter((d) => !state.filter || d.includes(state.filter));
  if (!all.length) return toast(t('translate.no_domain'), 'info');

  Object.assign(state, { phase: 'scanning', scanned: 0, cancel: false, sites: [], failed: [], selected: null });
  state.edits.clear();
  state.doneDomains.clear();
  render();

  for (let i = 0; i < all.length; i += BATCH) {
    if (state.cancel || !state.open) break;
    const batch = all.slice(i, i + BATCH);
    try {
      const { sites } = await api(`/api/servers/${enc(state.serverId)}/translation/scan`, { method: 'POST', body: { domains: batch } });
      for (const site of sites ?? []) {
        if (site.error) state.failed.push(site);
        else if (site.items?.length) state.sites.push(site);
      }
    } catch (err) {
      state.phase = 'done';
      render();
      return toastError(err);
    }
    state.scanned += batch.length;
    if (!state.selected && state.sites.length) select(state.sites[0].domain);
    render();
  }

  state.phase = 'done';
  if (!state.selected && state.sites.length) select(state.sites[0].domain);
  render();
  if (!state.cancel) toast(t('translate.scan_done', { sites: fmtNum(state.sites.length), texts: fmtNum(countTexts()) }), 'success');
}

const countTexts = () => state.sites.reduce((n, s) => n + s.items.length, 0);

function select(domain) {
  state.selected = domain;
  const site = state.sites.find((s) => s.domain === domain);
  const edits = editsFor(domain);
  // Première ouverture : la proposition connue est pré-remplie, et seuls les textes
  // pour lesquels une traduction existe sont cochés — l'agent complète les autres.
  for (const item of site?.items ?? []) {
    if (!edits.has(item.path)) edits.set(item.path, { keep: Boolean(item.suggestion), value: item.suggestion ?? '' });
  }
}

// ───────────────────────── Actions sur un site ─────────────────────────

async function machineTranslateSite(site, button) {
  const edits = editsFor(site.domain);
  const pending = site.items.filter((it) => !edits.get(it.path)?.value.trim());
  if (!pending.length) return toast(t('translate.nothing_to_fill'), 'info');

  button.disabled = true;
  try {
    // DeepL n'accepte qu'une langue source par appel : les textes sont groupés par langue.
    const groups = new Map();
    for (const item of pending) {
      const key = item.lang ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [from, items] of groups) {
      const { translations } = await api(`/api/servers/${enc(state.serverId)}/translation/translate`, {
        method: 'POST',
        body: { texts: items.map((it) => it.text), from: from || undefined, to: site.lang },
      });
      items.forEach((item, i) => {
        const text = translations?.[i];
        if (text) edits.set(item.path, { keep: true, value: text });
      });
    }
    toast(t('translate.filled'), 'success');
  } catch (err) {
    toastError(err);
  } finally {
    button.disabled = false;
    render();
  }
}

async function applySite(site, button) {
  const edits = editsFor(site.domain);
  const changes = site.items
    .filter((item) => {
      const edit = edits.get(item.path);
      return edit?.keep && edit.value.trim() && edit.value !== item.text;
    })
    .map((item) => ({ path: item.path, from: item.text, to: edits.get(item.path).value.trim() }));

  if (!changes.length) return toast(t('translate.nothing_selected'), 'info');

  button.disabled = true;
  try {
    const out = await api(`/api/servers/${enc(state.serverId)}/translation/apply`, { method: 'POST', body: { domain: site.domain, changes } });
    state.doneDomains.set(site.domain, out.applied.length);
    toast(t('translate.applied', { count: fmtNum(out.applied.length), domain: site.domain }), 'success');
    if (out.skipped?.length) toast(t('translate.skipped', { count: fmtNum(out.skipped.length) }), 'info');
    // On enchaîne : l'agent passe au site suivant sans chercher où cliquer.
    const next = state.sites.find((s) => !state.doneDomains.has(s.domain));
    if (next) select(next.domain);
  } catch (err) {
    toastError(err);
  } finally {
    button.disabled = false;
    render();
  }
}

// ───────────────────────── Rendu ─────────────────────────

function render() {
  if (!state.open) return;
  $('#page-title').textContent = t('translate.title');
  $('#page-sub').classList.remove('font-mono');
  $('#page-sub').textContent = state.serverLabel;
  $('#page-state').replaceChildren();

  const body = [intro(), stats()];
  if (state.sites.length) body.push(workspace());
  else if (state.phase === 'done') body.push(emptyResult());
  $('#translate-view').replaceChildren(...body.filter(Boolean));
}

/** Bandeau d'explication et commande d'analyse. */
function intro() {
  const scanning = state.phase === 'scanning';
  const total = state.domains.filter((d) => !state.filter || d.includes(state.filter)).length;

  const filter = h('input', {
    class: 'input sm:w-64',
    type: 'search',
    value: state.filter,
    placeholder: t('translate.filter_placeholder'),
    disabled: scanning,
    oninput: (e) => {
      state.filter = e.target.value.trim().toLowerCase();
      const counter = $('#translate-scope');
      if (counter) counter.textContent = t('translate.scope', { count: fmtNum(state.domains.filter((d) => !state.filter || d.includes(state.filter)).length) });
    },
  });

  const action = scanning
    ? h('button', { type: 'button', class: 'btn btn-outline', onclick: () => { state.cancel = true; } }, t('translate.stop'))
    : h(
        'button',
        { type: 'button', class: 'btn btn-primary', disabled: !state.domains.length, onclick: runScan },
        icon('refresh'),
        t(state.phase === 'done' ? 'translate.rescan' : 'translate.scan'),
      );

  return h(
    'div',
    { class: 'card p-5' },
    h(
      'div',
      { class: 'flex flex-wrap items-start gap-4' },
      h('span', { class: 'flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-50 text-accent-700' }, icon('globe', 'size-5')),
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h('h2', { class: 'text-base font-semibold' }, t('translate.step_scan')),
        h('p', { class: 'mt-1 max-w-3xl text-sm text-ink-500' }, t('translate.explain')),
        h('p', { id: 'translate-scope', class: 'mt-2 text-xs text-ink-400' }, t('translate.scope', { count: fmtNum(total) })),
      ),
      h('div', { class: 'flex flex-wrap items-center gap-2' }, filter, action),
    ),
    scanning ? progress(total) : null,
  );
}

function progress(total) {
  const pct = total ? Math.min(100, Math.round((state.scanned / total) * 100)) : 0;
  return h(
    'div',
    { class: 'mt-5' },
    h(
      'div',
      { class: 'mb-1.5 flex items-center justify-between text-xs font-medium text-ink-500' },
      h('span', {}, t('translate.progress', { done: fmtNum(state.scanned), total: fmtNum(total) })),
      h('span', { class: 'tabular-nums' }, `${pct} %`),
    ),
    h(
      'div',
      { class: 'h-2 overflow-hidden rounded-full bg-ink-100', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      h('div', { class: 'h-full rounded-full bg-accent transition-all duration-300', style: `width:${pct}%` }),
    ),
  );
}

function stats() {
  if (state.phase === 'idle') return null;
  const done = [...state.doneDomains.values()].reduce((a, b) => a + b, 0);
  const cells = [
    ['translate.stat_scanned', fmtNum(state.scanned), 'text-ink'],
    ['translate.stat_sites', fmtNum(state.sites.length), 'text-accent-700'],
    ['translate.stat_texts', fmtNum(countTexts()), 'text-ink'],
    ['translate.stat_applied', fmtNum(done), 'text-accent-700'],
    ['translate.stat_failed', fmtNum(state.failed.length), state.failed.length ? 'text-red-600' : 'text-ink-300'],
  ];
  return h(
    'div',
    { class: 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5' },
    cells.map(([key, value, tone]) =>
      h(
        'div',
        { class: 'card px-4 py-3' },
        h('p', { class: 'text-xs font-medium tracking-wide text-ink-400 uppercase' }, t(key)),
        h('p', { class: `mt-1 text-2xl font-bold tabular-nums ${tone}` }, value),
      ),
    ),
  );
}

function emptyResult() {
  return h(
    'div',
    { class: 'card px-6 py-16 text-center' },
    h('span', { class: 'mx-auto flex size-12 items-center justify-center rounded-2xl bg-accent-50 text-accent-700' }, icon('check', 'size-6')),
    h('p', { class: 'mt-4 font-semibold' }, t('translate.all_clean')),
    h('p', { class: 'mt-1 text-sm text-ink-500' }, t('translate.all_clean_hint')),
  );
}

/** Liste des sites à gauche, textes du site retenu à droite. */
function workspace() {
  return h('div', { class: 'grid gap-4 lg:grid-cols-[19rem_1fr]' }, siteList(), siteDetail());
}

function siteList() {
  const rows = state.sites.map((site) => {
    const applied = state.doneDomains.get(site.domain);
    const active = state.selected === site.domain;
    return h(
      'button',
      {
        type: 'button',
        class: `flex w-full items-center gap-3 border-b border-ink-100 px-4 py-3 text-left transition last:border-0 ${active ? 'bg-accent-50' : 'hover:bg-ink-50'}`,
        'aria-current': String(active),
        onclick: () => {
          select(site.domain);
          render();
        },
      },
      h(
        'span',
        { class: 'min-w-0 flex-1' },
        h('span', { class: 'block truncate text-sm font-medium' }, site.domain),
        h('span', { class: 'mt-0.5 block text-xs text-ink-400' }, `${langName(site.lang)} · ${t('translate.texts_count', { count: fmtNum(site.items.length) })}`),
      ),
      applied != null
        ? h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5'), fmtNum(applied))
        : h('span', { class: 'badge bg-ink-100 text-ink-600 tabular-nums' }, fmtNum(site.items.length)),
    );
  });

  return h(
    'div',
    { class: 'card overflow-hidden self-start' },
    h('p', { class: 'border-b border-ink-100 bg-ink-50/60 px-4 py-2.5 text-xs font-semibold tracking-wide text-ink-500 uppercase' }, t('translate.sites_to_fix')),
    h('div', { class: 'max-h-[32rem] overflow-y-auto' }, rows.filter(Boolean)),
  );
}

function siteDetail() {
  const site = state.sites.find((s) => s.domain === state.selected);
  if (!site) return h('div', { class: 'card px-6 py-16 text-center text-ink-400' }, t('translate.pick_site'));

  const edits = editsFor(site.domain);
  const applied = state.doneDomains.get(site.domain);

  const header = h(
    'div',
    { class: 'flex flex-wrap items-center gap-3 border-b border-ink-100 px-5 py-4' },
    h(
      'div',
      { class: 'min-w-0 flex-1' },
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        h('h3', { class: 'truncate font-semibold' }, site.domain),
        h('span', { class: 'badge bg-ink-100 text-ink-700' }, langName(site.lang)),
        applied != null ? h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5'), t('translate.applied_badge')) : null,
      ),
      h('p', { class: 'mt-1 text-xs text-ink-400' }, t(`translate.source.${site.langSource}`, { hint: site.hint || '—' })),
    ),
    state.machine && can('design.edit')
      ? h('button', { type: 'button', class: 'btn btn-outline', onclick: (e) => machineTranslateSite(site, e.currentTarget) }, icon('wrench'), t('translate.autofill'))
      : null,
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-primary',
        disabled: !can('design.publish'),
        title: can('design.publish') ? null : t('reason.permission_denied'),
        onclick: (e) => applySite(site, e.currentTarget),
      },
      icon('save'),
      t('translate.apply'),
    ),
  );

  const rows = site.items.map((item) => textRow(site, item, edits));

  return h(
    'div',
    { class: 'card overflow-hidden' },
    header,
    h('div', { class: 'divide-y divide-ink-100' }, rows),
    h(
      'p',
      { class: 'border-t border-ink-100 bg-ink-50/60 px-5 py-3 text-xs text-ink-500' },
      t('translate.safety_note'),
    ),
  );
}

/** Une ligne = un texte : où il se trouve, ce qu'il dit, ce qu'il va devenir. */
function textRow(site, item, edits) {
  const edit = edits.get(item.path) ?? { keep: false, value: '' };
  const long = item.text.length > 90;

  const field = h(long ? 'textarea' : 'input', {
    class: 'input',
    rows: long ? '3' : null,
    value: long ? null : edit.value,
    placeholder: t('translate.placeholder', { lang: langName(site.lang) }),
    oninput: (e) => {
      const current = edits.get(item.path) ?? { keep: true, value: '' };
      edits.set(item.path, { keep: current.keep || Boolean(e.target.value.trim()), value: e.target.value });
      const box = e.target.closest('[data-row]')?.querySelector('input[type=checkbox]');
      if (box && e.target.value.trim()) box.checked = true;
    },
  });
  if (long) field.value = edit.value;

  const keep = h('input', {
    type: 'checkbox',
    class: 'size-4 rounded border-ink-300 text-accent focus:ring-accent',
    checked: edit.keep,
    'aria-label': t('translate.keep'),
    onchange: (e) => {
      const current = edits.get(item.path) ?? { keep: false, value: '' };
      edits.set(item.path, { ...current, keep: e.target.checked });
    },
  });

  return h(
    'div',
    { class: 'grid gap-3 px-5 py-4 lg:grid-cols-2', 'data-row': item.path },
    h(
      'div',
      { class: 'min-w-0' },
      h(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        h('span', { class: 'text-sm font-semibold' }, whereLabel(item.path)),
        item.source === 'dictionary'
          ? h('span', { class: 'badge bg-accent-50 text-accent-700' }, t('translate.source_dictionary'))
          : uncertain(item)
            ? h('span', { class: 'badge bg-ink-100 text-ink-600', title: t('translate.uncertain_hint') }, t('translate.uncertain', { lang: langName(item.lang) }))
            : h('span', { class: 'badge bg-amber-50 text-amber-700' }, t('translate.detected', { lang: langName(item.lang) })),
      ),
      h('p', { class: 'mt-1.5 rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-700' }, item.text),
      h('p', { class: 'mt-1 font-mono text-[11px] text-ink-300' }, item.path),
    ),
    h(
      'div',
      { class: 'min-w-0' },
      h(
        'div',
        { class: 'mb-1.5 flex items-center justify-between gap-2' },
        h('span', { class: 'text-xs font-semibold tracking-wide text-ink-500 uppercase' }, t('translate.new_text')),
        h('label', { class: 'flex items-center gap-2 text-xs text-ink-500' }, keep, t('translate.keep')),
      ),
      field,
      item.suggestion ? h('p', { class: 'mt-1 text-xs text-accent-700' }, t('translate.from_dictionary')) : null,
    ),
  );
}
