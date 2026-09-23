import { api } from './api.js';
import { t } from './i18n.js';
import { $, enc, fmtNum, h, icon, toast, toastError } from './ui.js';
import { translateAction } from './translate.js';

/**
 * Écran « Actions » : les traitements de masse du parc.
 *
 * L'écran ne connaît aucun traitement en particulier. Il apporte ce qui leur est
 * commun — choisir l'action, choisir les sites, avancer par lots, montrer où l'on en
 * est — et laisse chaque action rendre ses propres résultats. Ajouter un traitement
 * demain, c'est ajouter une entrée dans ACTIONS.
 *
 * Deux périmètres, parce que les deux besoins existent :
 *   - TOUT LE SERVEUR : la tournée de fond, sur les milliers de sites d'un VPS ;
 *   - UNE LISTE DE DOMAINES : ceux qu'un agent colle depuis un tableur. Ils peuvent
 *     venir de plusieurs serveurs à la fois : le back-office les répartit lui-même,
 *     et dit clairement lesquels il ne trouve pas, et pourquoi.
 */

/** Traitements disponibles. Une action = { key, icon, labelKey, hintKey, batch, reset, run, stats, results }. */
const ACTIONS = [translateAction];

const state = {
  open: false,
  action: ACTIONS[0],
  serverId: null,
  serverLabel: '',
  servers: [],
  permissions: [],
  domains: [], // domaines du serveur courant (périmètre « tout le serveur »)
  loadingDomains: false,
  scope: 'server', // server | list
  text: '',
  resolved: null, // { found:[{domain,server}], unknown:[], offline:[] }
  resolving: false,
  phase: 'idle', // idle | running | done
  total: 0,
  done: 0,
  cancel: false,
  onClose: null,
};

export const isActionsOpen = () => state.open;
export const rerenderActions = () => state.open && render();

const serverLabel = (id) => state.servers.find((s) => s.id === id)?.label ?? id;

export async function openActions({ serverId, serverLabel: label, servers, permissions, onClose }) {
  Object.assign(state, {
    open: true,
    action: ACTIONS[0],
    serverId: serverId && serverId !== 'all' ? serverId : null,
    serverLabel: label ?? serverId ?? '',
    servers: servers ?? [],
    permissions: permissions ?? [],
    domains: [],
    loadingDomains: false,
    scope: serverId && serverId !== 'all' ? 'server' : 'list',
    text: '',
    resolved: null,
    resolving: false,
    phase: 'idle',
    total: 0,
    done: 0,
    cancel: false,
    onClose,
  });
  if (listArea) listArea.value = '';
  for (const action of ACTIONS) {
    action.reset();
    action.onChange = render;
  }

  $('#domains-view').hidden = true;
  $('#files-view').hidden = true;
  $('#admin-view').hidden = true;
  $('#design-view').hidden = true;
  $('#actions-view').hidden = false;
  $('#btn-back').hidden = false;
  for (const sel of ['#btn-conn', '#btn-refresh', '#btn-add']) $(sel).hidden = true;

  render();
  await loadServerDomains();
}

export function closeActions() {
  if (!state.open) return;
  state.open = false;
  state.cancel = true;
  $('#actions-view').hidden = true;
  $('#actions-view').replaceChildren();
  $('#domains-view').hidden = false;
  $('#btn-back').hidden = true;
  for (const sel of ['#btn-refresh', '#btn-add']) $(sel).hidden = false;
  state.onClose?.();
}

/** Liste complète des domaines du serveur : le tableau n'en montre qu'une page. */
async function loadServerDomains() {
  if (!state.serverId) return;
  state.loadingDomains = true;
  render();
  try {
    const { domains } = await api(`/api/servers/${enc(state.serverId)}/domain-names`);
    state.domains = domains ?? [];
  } catch (err) {
    toastError(err);
  } finally {
    state.loadingDomains = false;
    render();
  }
}

// ───────────────────────── Périmètre ─────────────────────────

/** Une liste collée depuis un tableur : séparateurs libres, adresses complètes tolérées. */
export function parseDomains(text) {
  return [
    ...new Set(
      String(text ?? '')
        .split(/[\s,;|]+/)
        .map((raw) =>
          raw
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//, '')
            .replace(/^www\./, '')
            .replace(/[/?#].*$/, '')
            .replace(/[.,;]+$/, ''),
        )
        .filter((d) => /^[a-z0-9][a-z0-9.-]{1,252}$/.test(d) && d.includes('.')),
    ),
  ];
}

let resolveTimer = null;
function scheduleResolve() {
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(resolveList, 400);
}

async function resolveList() {
  const domains = parseDomains(state.text);
  if (!domains.length) {
    state.resolved = null;
    return render();
  }
  state.resolving = true;
  render();
  try {
    state.resolved = await api('/api/domains/resolve', { method: 'POST', body: { domains } });
  } catch (err) {
    state.resolved = null;
    toastError(err);
  } finally {
    state.resolving = false;
    render();
  }
}

/** Cibles retenues, dans l'ordre, chacune avec le serveur qui la porte. */
function targets() {
  if (state.scope === 'list') return state.resolved?.found ?? [];
  return state.domains.map((domain) => ({ domain, server: state.serverId }));
}

// ───────────────────────── Exécution ─────────────────────────

async function run() {
  const list = targets();
  if (!list.length) return toast(t('actions.no_target'), 'info');

  const action = state.action;
  action.reset();
  Object.assign(state, { phase: 'running', total: list.length, done: 0, cancel: false });
  render();

  // Un lot ne mélange jamais deux serveurs : chaque appel s'adresse à une machine.
  const size = action.batch ?? 100;
  const groups = new Map();
  for (const target of list) {
    if (!groups.has(target.server)) groups.set(target.server, []);
    groups.get(target.server).push(target.domain);
  }

  for (const [server, domains] of groups) {
    for (let i = 0; i < domains.length; i += size) {
      if (state.cancel || !state.open) break;
      const batch = domains.slice(i, i + size);
      try {
        await action.run(server, batch, { permissions: state.permissions });
        // Les résultats portent un identifiant de serveur ; l'écran seul connaît son nom.
        action.labelServers?.(serverLabel);
      } catch (err) {
        state.phase = 'done';
        render();
        return toastError(err);
      }
      state.done += batch.length;
      render();
    }
    if (state.cancel || !state.open) break;
  }

  state.phase = 'done';
  render();
  if (!state.cancel) action.finished?.();
}

// ───────────────────────── Rendu ─────────────────────────

function render() {
  if (!state.open) return;
  $('#page-title').textContent = t('actions.title');
  $('#page-sub').classList.remove('font-mono');
  $('#page-sub').textContent = state.serverId ? state.serverLabel : t('actions.all_servers');
  $('#page-state').replaceChildren();

  const results = state.action.results({ permissions: state.permissions });
  const body = [chooser(), scopeCard(), statsRow(), results ?? (state.phase === 'done' ? state.action.emptyState?.() : null)];
  $('#actions-view').replaceChildren(...body.filter(Boolean));
}

/** Bouton « Action » : une liste déroulante, prête à accueillir les traitements suivants. */
function chooser() {
  const select = h(
    'select',
    {
      class: 'input sm:w-64',
      'aria-label': t('actions.choose'),
      onchange: (e) => {
        state.action = ACTIONS.find((a) => a.key === e.target.value) ?? ACTIONS[0];
        state.phase = 'idle';
        render();
      },
    },
    ACTIONS.map((a) => h('option', { value: a.key, selected: a.key === state.action.key }, t(a.labelKey))),
  );

  return h(
    'div',
    { class: 'card p-5' },
    h(
      'div',
      { class: 'flex flex-wrap items-start gap-4' },
      h('span', { class: 'flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-50 text-accent-700' }, icon(state.action.icon, 'size-5')),
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h('p', { class: 'label' }, t('actions.choose')),
        select,
      ),
      h('p', { class: 'min-w-0 flex-1 basis-72 text-sm text-ink-500' }, t(state.action.hintKey)),
    ),
  );
}

function scopeCard() {
  const tab = (key, label, disabled) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg',
        'aria-pressed': String(state.scope === key),
        disabled,
        title: disabled ? t('actions.pick_server_first') : null,
        onclick: () => {
          state.scope = key;
          render();
        },
      },
      label,
    );

  const running = state.phase === 'running';
  const count = targets().length;

  return h(
    'div',
    { class: 'card p-5' },
    h(
      'div',
      { class: 'flex flex-wrap items-center gap-3' },
      h('p', { class: 'flex-1 text-base font-semibold' }, t('actions.scope')),
      h(
        'div',
        { class: 'flex rounded-lg bg-ink-50 p-1' },
        tab('server', t('actions.scope_server'), !state.serverId || running),
        tab('list', t('actions.scope_list'), running),
      ),
    ),
    state.scope === 'server' ? serverScope() : listScope(),
    h(
      'div',
      { class: 'mt-4 flex flex-wrap items-center gap-3 border-t border-ink-100 pt-4' },
      h('p', { class: 'flex-1 text-sm text-ink-500' }, t('actions.selected', { count: fmtNum(count) })),
      running
        ? h('button', { type: 'button', class: 'btn btn-outline', onclick: () => { state.cancel = true; } }, t('actions.stop'))
        : h(
            'button',
            { type: 'button', class: 'btn btn-primary', disabled: !count, onclick: run },
            icon('refresh'),
            t(state.phase === 'done' ? 'actions.restart' : 'actions.start'),
          ),
    ),
    running ? progress() : null,
  );
}

function serverScope() {
  if (!state.serverId) return h('p', { class: 'mt-3 text-sm text-ink-500' }, t('actions.pick_server_first'));
  return h(
    'p',
    { class: 'mt-3 text-sm text-ink-500' },
    state.loadingDomains
      ? t('files.loading')
      : t('actions.server_scope_hint', { server: state.serverLabel, count: fmtNum(state.domains.length) }),
  );
}

/**
 * La zone de saisie survit aux rafraîchissements.
 *
 * L'écran se redessine à chaque lot analysé et à chaque recherche de domaines ; un
 * champ reconstruit perdrait le curseur au milieu d'une frappe. Le même élément est
 * donc conservé d'un rendu à l'autre, son contenu vivant dans `state.text`.
 */
let listArea = null;
function listInput() {
  listArea ??= h('textarea', {
    class: 'input font-mono text-xs leading-5',
    rows: '5',
    spellcheck: 'false',
    placeholder: 'caswellscoffee.com\ndinemec.com\nmandyscarr.com',
    oninput: (e) => {
      state.text = e.target.value;
      scheduleResolve();
    },
  });
  listArea.disabled = state.phase === 'running';
  return listArea;
}

function listScope() {
  const area = listInput();
  const res = state.resolved;
  return h(
    'div',
    { class: 'mt-3 space-y-2' },
    h('p', { class: 'text-sm text-ink-500' }, t('actions.list_hint')),
    area,
    state.resolving ? h('p', { class: 'text-xs text-ink-400' }, t('actions.resolving')) : null,
    res
      ? h(
          'div',
          { class: 'space-y-1.5' },
          res.found.length
            ? h(
                'p',
                { class: 'text-sm text-accent-700' },
                t('actions.found', { count: fmtNum(res.found.length) }),
                ' ',
                h('span', { class: 'text-ink-500' }, byServer(res.found)),
              )
            : null,
          res.unknown.length
            ? h(
                'p',
                { class: 'text-sm text-red-600' },
                t('actions.unknown', { count: fmtNum(res.unknown.length) }),
                ' ',
                h('span', { class: 'font-mono text-xs' }, res.unknown.slice(0, 8).join(', ')),
                res.unknown.length > 8 ? '…' : '',
              )
            : null,
          res.offline?.length
            ? h('p', { class: 'text-xs text-ink-400' }, t('actions.offline', { servers: res.offline.map((s) => s.label).join(', ') }))
            : null,
        )
      : null,
  );
}

/** « 12 sur vps-001, 3 sur vps-003 » : l'agent voit où son travail va se faire. */
function byServer(found) {
  const counts = new Map();
  for (const f of found) counts.set(f.server, (counts.get(f.server) ?? 0) + 1);
  return [...counts].map(([id, n]) => `${fmtNum(n)} · ${serverLabel(id)}`).join(' — ');
}

function progress() {
  const pct = state.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : 0;
  return h(
    'div',
    { class: 'mt-4' },
    h(
      'div',
      { class: 'mb-1.5 flex items-center justify-between text-xs font-medium text-ink-500' },
      h('span', {}, t('actions.progress', { done: fmtNum(state.done), total: fmtNum(state.total) })),
      h('span', { class: 'tabular-nums' }, `${pct} %`),
    ),
    h(
      'div',
      { class: 'h-2 overflow-hidden rounded-full bg-ink-100', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
      h('div', { class: 'h-full rounded-full bg-accent transition-all duration-300', style: `width:${pct}%` }),
    ),
  );
}

// Classes écrites en toutes lettres : Tailwind lit ce fichier pour produire sa feuille,
// et ne verrait pas une classe assemblée à l'exécution.
const GRID = ['lg:grid-cols-3', 'lg:grid-cols-3', 'lg:grid-cols-3', 'lg:grid-cols-4', 'lg:grid-cols-5'];

function statsRow() {
  if (state.phase === 'idle') return null;
  const cells = state.action.stats();
  if (!cells.length) return null;
  return h(
    'div',
    { class: `grid grid-cols-2 gap-3 sm:grid-cols-3 ${GRID[Math.min(cells.length, GRID.length) - 1]}` },
    cells.map(([key, value, tone]) =>
      h(
        'div',
        { class: 'card px-4 py-3' },
        h('p', { class: 'text-xs font-medium tracking-wide text-ink-400 uppercase' }, t(key)),
        h('p', { class: `mt-1 text-2xl font-bold tabular-nums ${tone ?? 'text-ink'}` }, value),
      ),
    ),
  );
}
