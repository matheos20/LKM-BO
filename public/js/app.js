import { api, qs, setUnauthorizedHandler } from './api.js';
import { applyI18n, getLang, getLanguages, initI18n, onLangChange, setLang, t } from './i18n.js';
import { closeFiles, isFilesOpen, openFiles, rerenderFiles } from './files.js';
import { accountDialog, closeAdmin, isAdminOpen, openAdmin, rerenderAdmin } from './admin.js';
import { closeDesign, isDesignOpen, openDesign, rerenderDesign } from './design.js';
import { closeActions, isActionsOpen, isActionsSuspended, openActions, rerenderActions } from './actions.js';
import { $, closeModal, enc, fmtDate, fmtNum, fmtSize, formError, h, icon, modalHeader, openModal, store, toast, toastError } from './ui.js';

// ───────────────────────── État ─────────────────────────
const state = {
  user: null,
  servers: [],
  current: null, // 'all' | id serveur
  query: { q: '', status: 'all', sort: 'name', page: 1, size: Number(store.get('lkm.size')) || 50 },
  result: null,
  loadSeq: 0,
  drawer: null,
};
const serverById = (id) => state.servers.find((s) => s.id === id);
const isAll = () => state.current === 'all';
const connectedServers = () => state.servers.filter((s) => s.state === 'connected');
const viewReady = () => (isAll() ? connectedServers().length > 0 : serverById(state.current)?.state === 'connected');
/** Droit accordé par le rôle de l'utilisateur connecté (la vérification fait foi côté serveur). */
const can = (permission) => state.user?.permissions?.includes(permission) ?? false;
const reasonText = (cap) => t('action.unavailable', { reason: t(`reason.${cap?.reason ?? 'not_configured'}`) });

// ───────────────────────── Styles d'état ─────────────────────────
const DOT = { connected: 'bg-accent', connecting: 'bg-amber-400 animate-pulse', error: 'bg-red-500', disconnected: 'bg-ink-500' };
const STATE_BADGE = {
  connected: 'badge bg-accent-100 text-accent-700',
  connecting: 'badge bg-amber-100 text-amber-800',
  error: 'badge bg-red-100 text-red-700',
  disconnected: 'badge bg-ink-100 text-ink-600',
};
const STATUS_BADGE = {
  locked: 'badge bg-ink text-white',
  unlocked: 'badge bg-accent-100 text-accent-700',
  incomplete: 'badge bg-amber-100 text-amber-800',
};
const STATUS_ICON = { locked: 'lock', unlocked: 'unlock', incomplete: 'alert' };
const statusBadge = (st) => h('span', { class: STATUS_BADGE[st] }, icon(STATUS_ICON[st], 'size-3.5'), t(`status.${st}`));

// ───────────────────────── Barre latérale ─────────────────────────
function renderSidebar() {
  const groups = new Map();
  for (const s of state.servers) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);

  $('#server-list').replaceChildren(
    ...[...groups].map(([group, servers]) =>
      h(
        'div',
        {},
        h('p', { class: 'mb-1 px-3 text-[11px] font-medium text-ink-400' }, group),
        h('div', { class: 'space-y-0.5' }, servers.map(serverItem)),
      ),
    ),
  );
  $('#nav-all').setAttribute('aria-current', String(isAll()));
  // Les traitements de masse acceptent aussi une liste de domaines venue de
  // plusieurs serveurs : l'entrée reste donc accessible depuis « tous les serveurs ».
  $('#nav-actions').hidden = !can('design.read');
  $('#nav-actions').setAttribute('aria-current', String(isActionsOpen()));
  $('#all-count').textContent = `${connectedServers().length}/${state.servers.length}`;
}

function serverItem(s) {
  return h(
    'button',
    {
      type: 'button',
      class: 'flex w-full items-center gap-3 rounded-xl border-l-2 border-transparent px-3 py-2 text-left transition hover:bg-white/5 aria-[current=true]:border-accent aria-[current=true]:bg-white/10',
      'aria-current': String(state.current === s.id),
      title: s.error ?? t(`server.state_${s.state}`),
      onclick: () => selectServer(s.id),
    },
    h('span', { class: `size-2.5 shrink-0 rounded-full ${DOT[s.state]}` }),
    h(
      'span',
      { class: 'min-w-0 flex-1' },
      h('span', { class: 'block truncate text-sm font-medium text-white' }, s.label),
      h('span', { class: 'block truncate font-mono text-[11px] text-ink-400' }, s.host),
    ),
    s.domainCount != null ? h('span', { class: 'text-xs text-ink-300 tabular-nums' }, fmtNum(s.domainCount)) : null,
  );
}

function toggleSidebar(open) {
  $('#sidebar').classList.toggle('-translate-x-full', !open);
  $('#sidebar-backdrop').hidden = !open;
}

// ───────────────────────── En-tête & états vides ─────────────────────────
function renderHeader() {
  if (isFilesOpen() || isAdminOpen() || isDesignOpen() || isActionsOpen()) return; // l'en-tête appartient à l'écran ouvert
  const s = serverById(state.current);
  const conn = $('#btn-conn');
  $('#page-sub').classList.toggle('font-mono', !isAll());
  if (isAll() || !s) {
    $('#page-title').textContent = t('nav.all_servers');
    $('#page-sub').textContent = t('server.all_hint', { count: connectedServers().length, total: state.servers.length });
    $('#page-state').replaceChildren();
    conn.hidden = true;
  } else {
    $('#page-title').textContent = s.label;
    $('#page-sub').textContent = [`${s.username}@${s.host}:${s.port}`, t(`server.auth_${s.authType}`), s.fingerprint].filter(Boolean).join(' · ');
    $('#page-state').replaceChildren(h('span', { class: STATE_BADGE[s.state] }, h('span', { class: `size-1.5 rounded-full ${DOT[s.state]}` }), t(`server.state_${s.state}`)));
    const on = s.state === 'connected';
    conn.hidden = false;
    conn.className = on ? 'btn btn-outline' : 'btn btn-dark';
    conn.disabled = s.state === 'connecting';
    conn.replaceChildren(icon('plug'), on ? t('server.disconnect') : t('server.connect'));
  }

  const add = $('#btn-add');
  const targets = (isAll() ? connectedServers() : s?.state === 'connected' ? [s] : []).filter((x) => x.capabilities.create.ok);
  add.disabled = targets.length === 0;
  add.title = add.disabled && s?.state === 'connected' ? reasonText(s.capabilities.create) : '';
  $('#btn-refresh').disabled = !viewReady();
  $('#col-server').hidden = !isAll();
}

function renderNotice() {
  const ready = viewReady();
  $('#notice').hidden = ready;
  $('#domains-card').hidden = !ready;
  $('#stats').hidden = !ready;
  if (ready) return $('#partial').setAttribute('hidden', '');

  const s = serverById(state.current);
  const action = $('#notice-action');
  const err = $('#notice-error');
  if (isAll()) {
    $('#notice-title').textContent = t('nav.all_servers');
    $('#notice-body').textContent = t('server.none_connected');
    action.textContent = t('server.connect_all');
    err.hidden = true;
  } else {
    $('#notice-title').textContent = t('server.not_connected_title');
    $('#notice-body').textContent = t('server.not_connected_body');
    action.textContent = s?.state === 'connecting' ? t('server.state_connecting') : t('server.connect');
    err.textContent = s?.error ?? '';
    err.hidden = !(s?.state === 'error' && s.error);
  }
  action.hidden = false;
  action.disabled = s?.state === 'connecting';
}

// ───────────────────────── Statistiques ─────────────────────────
function renderStats(stats) {
  const pct = (n) => (stats.total ? `${Math.round((n / stats.total) * 100)} %` : '');
  const card = (key, value, sub, filter, tone) =>
    h(
      filter ? 'button' : 'div',
      {
        type: filter ? 'button' : null,
        class: `${tone} rounded-2xl p-5 text-left shadow-sm transition ${filter ? 'hover:-translate-y-0.5 hover:shadow-md' : ''}`,
        onclick: filter ? () => setStatusFilter(filter) : null,
      },
      h('p', { class: 'text-xs font-semibold tracking-wide uppercase opacity-70' }, t(key)),
      h('p', { class: 'mt-2 text-3xl font-bold tabular-nums' }, fmtNum(value)),
      h('p', { class: 'mt-1 min-h-4 text-xs opacity-60' }, sub),
    );
  $('#stats').replaceChildren(
    card('stats.total', stats.total, isAll() ? `${connectedServers().length}/${state.servers.length} · ${t('nav.servers')}` : '', 'all', 'bg-ink text-white'),
    card('stats.locked', stats.locked, pct(stats.locked), 'locked', 'border border-ink-100 bg-white text-ink'),
    card('stats.unlocked', stats.unlocked, pct(stats.unlocked), 'unlocked', 'border border-accent-200 bg-accent-50 text-ink'),
    card('stats.incomplete', stats.incomplete, pct(stats.incomplete), 'incomplete', 'border border-ink-100 bg-white text-ink'),
    card('stats.link', stats.link, stats.wwwCanon ? `${t('stats.www')} : ${fmtNum(stats.wwwCanon)}` : '', null, 'border border-ink-100 bg-white text-ink'),
  );
}

// ───────────────────────── Tableau ─────────────────────────
function actionBtn(name, label, cap, onclick, extra = '') {
  const ok = Boolean(cap?.ok);
  return h(
    'button',
    { type: 'button', class: `icon-btn ${extra}`, title: ok ? label : `${label} — ${reasonText(cap)}`, 'aria-label': label, disabled: !ok, onclick },
    icon(name),
  );
}

function row(d) {
  const s = serverById(d.server);
  const caps = s?.capabilities ?? {};
  const toggle = d.status === 'locked' ? 'unlock' : 'lock';
  return h(
    'tr',
    { class: 'transition hover:bg-accent-50/50' },
    h(
      'td',
      { class: 'px-5 py-3' },
      h('button', { type: 'button', class: 'text-left font-medium text-ink hover:text-accent-700 hover:underline', onclick: () => openDetails(d.server, d.name) }, d.name),
      d.wwwCanon ? h('span', { class: 'ml-2 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[10px] text-ink-500', title: t('details.canon_www') }, 'www') : null,
      d.siteUser ? h('p', { class: 'font-mono text-[11px] text-ink-400' }, d.siteUser) : null,
    ),
    isAll() ? h('td', { class: 'px-4 py-3 whitespace-nowrap text-ink-600' }, s?.label ?? d.server) : null,
    h('td', { class: 'px-4 py-3' }, statusBadge(d.status)),
    h(
      'td',
      { class: 'hidden px-4 py-3 whitespace-nowrap text-ink-500 md:table-cell' },
      h('span', { class: 'inline-flex items-center gap-1.5' }, icon(d.storage === 'link' ? 'link' : 'disk', 'size-3.5'), t(`storage.${d.storage}`)),
    ),
    h('td', { class: 'hidden px-4 py-3 whitespace-nowrap text-ink-500 lg:table-cell' }, fmtDate(d.mtime)),
    h(
      'td',
      { class: 'px-5 py-2' },
      h(
        'div',
        { class: 'flex justify-end gap-0.5' },
        actionBtn('palette', t('design.open'), { ok: can('design.read'), reason: 'permission_denied' }, () => openDesignFor(d.server, d.name, d.status)),
        actionBtn('folder', t('files.open_manager'), { ok: can('files.read'), reason: 'permission_denied' }, () => openFilesFor(d.server, d.name, d.status)),
        actionBtn('eye', t('action.details'), { ok: true }, () => openDetails(d.server, d.name)),
        d.status === 'incomplete' ? null : actionBtn(toggle, t(`action.${toggle}`), caps[toggle], (e) => runUpdate(d.server, d.name, toggle, e.currentTarget)),
        actionBtn('wrench', t('action.fix_perms'), caps.fixPerms, (e) => runUpdate(d.server, d.name, 'fixPerms', e.currentTarget)),
        actionBtn('trash', t('action.delete'), caps.delete, () => openDelete(d.server, d.name), 'hover:bg-red-50 hover:text-red-600'),
      ),
    ),
  );
}

function renderRows() {
  const r = state.result;
  const message = (text) => h('tr', {}, h('td', { colspan: 6, class: 'px-5 py-14 text-center text-ink-400' }, text));
  $('#rows').replaceChildren(...(!r ? [message(t('domains.loading'))] : r.items.length ? r.items.map(row) : [message(t('domains.empty'))]));
  if (!r) return;

  const from = r.total ? (r.page - 1) * r.size + 1 : 0;
  $('#pager-info').textContent = t('domains.showing', { from: fmtNum(from), to: fmtNum(Math.min(r.page * r.size, r.total)), total: fmtNum(r.total) });
  $('#btn-prev').disabled = r.page <= 1;
  $('#btn-next').disabled = r.page >= r.pages;
  $('#updated').textContent = r.cachedAt ? t('domains.updated', { time: fmtDate(r.cachedAt) }) : '';

  const failed = r.failed ?? [];
  $('#partial').hidden = failed.length === 0;
  $('#partial').textContent = failed.length ? t('domains.partial', { list: failed.map((f) => `${serverById(f.server)?.label ?? f.server} — ${f.message}`).join(' · ') }) : '';
}

function setStatusFilter(status) {
  state.query.status = status;
  state.query.page = 1;
  for (const b of document.querySelectorAll('#filter [data-status]')) b.setAttribute('aria-pressed', String(b.dataset.status === status));
  loadDomains();
}

// ───────────────────────── Chargement ─────────────────────────
async function refreshServers() {
  const { servers } = await api('/api/servers');
  state.servers = servers;
  renderSidebar();
  renderHeader();
}

async function loadDomains({ refresh = false } = {}) {
  renderHeader();
  renderNotice();
  if (!viewReady()) return;

  const seq = ++state.loadSeq;
  const params = qs({ ...state.query, refresh: refresh ? 1 : '' });
  const url = isAll() ? `/api/domains?${params}` : `/api/servers/${enc(state.current)}/domains?${params}`;
  $('#rows').classList.add('opacity-50');
  try {
    const r = await api(url);
    if (seq !== state.loadSeq) return;
    state.result = r;
    state.query.page = r.page;
    renderStats(r.stats);
    renderRows();
    if (isAll()) {
      refreshServers().catch(() => {}); // met à jour les compteurs par serveur de la barre latérale
    } else {
      serverById(state.current).domainCount = r.stats.total;
      renderSidebar();
    }
  } catch (err) {
    if (seq !== state.loadSeq) return;
    toastError(err);
    if (err.key === 'errors.ssh_not_connected') {
      await refreshServers();
      renderNotice();
    }
  } finally {
    if (seq === state.loadSeq) $('#rows').classList.remove('opacity-50');
  }
}

// ───────────────────────── Connexions SSH ─────────────────────────
async function connect(id, { quiet = false } = {}) {
  const s = serverById(id);
  Object.assign(s, { state: 'connecting', error: null });
  renderSidebar();
  renderHeader();
  renderNotice();
  try {
    Object.assign(s, await api(`/api/servers/${enc(id)}/connect`, { method: 'POST' }));
    if (!quiet) toast(t('toast.connected', { server: s.label }));
  } catch (err) {
    Object.assign(s, { state: 'error', error: err.message });
    if (!quiet) toastError(err);
  }
  renderSidebar();
  return s.state === 'connected';
}

async function disconnect(id) {
  try {
    const s = serverById(id);
    Object.assign(s, await api(`/api/servers/${enc(id)}/disconnect`, { method: 'POST' }));
    toast(t('toast.disconnected', { server: s.label }), 'info');
  } catch (err) {
    toastError(err);
  }
  renderSidebar();
  await loadDomains();
}

async function connectAll() {
  const todo = state.servers.filter((s) => s.state !== 'connected');
  await Promise.all(todo.map((s) => connect(s.id, { quiet: true })));
  for (const s of todo.filter((x) => x.state === 'error')) toast(`${s.label} — ${s.error}`, 'error');
  await loadDomains();
}

/** Sélection d'un serveur : connexion SSH à la demande, puis chargement des domaines. */
async function selectServer(id) {
  closeFiles();
  closeAdmin();
  closeDesign();
  closeActions();
  state.current = id;
  state.result = null;
  state.query.page = 1;
  store.set('lkm.current', id);
  toggleSidebar(false);
  renderSidebar();
  renderRows();
  const s = serverById(id);
  if (s && s.state === 'disconnected') await connect(id, { quiet: true });
  if (state.current === id) await loadDomains();
}

// ───────────────────────── Détails (Read) ─────────────────────────

/** Bascule vers l'éditeur de design et de contenu du domaine. */
function openDesignFor(serverId, domain, status) {
  closeDrawer();
  openDesign({
    serverId,
    serverLabel: serverById(serverId)?.label ?? serverId,
    domain,
    status,
    permissions: state.user?.permissions ?? [],
    onClose: () => {
      renderHeader();
      renderNotice();
    },
  });
}

/** Bascule vers le gestionnaire de fichiers du domaine. */
function openFilesFor(serverId, domain, status) {
  closeDrawer();
  openFiles({
    serverId,
    serverLabel: serverById(serverId)?.label ?? serverId,
    domain,
    status,
    onClose: () => {
      renderHeader();
      renderNotice();
    },
  });
}

async function openDetails(serverId, name) {
  const s = serverById(serverId);
  state.drawer = { serverId, name };
  $('#drawer-title').textContent = name;
  $('#drawer-server').textContent = `${s.label} · ${s.host}`;
  $('#drawer-body').replaceChildren(h('p', { class: 'py-12 text-center text-sm text-ink-400' }, t('domains.loading')));
  $('#drawer-actions').replaceChildren();
  $('#drawer').hidden = false;
  try {
    const d = await api(`/api/servers/${enc(serverId)}/domains/${enc(name)}`);
    if (state.drawer?.name === name && state.drawer.serverId === serverId) renderDetails(s, d);
  } catch (err) {
    $('#drawer-body').replaceChildren(h('p', { class: 'rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700' }, err.message));
  }
}

function closeDrawer() {
  $('#drawer').hidden = true;
  state.drawer = null;
}

function renderDetails(s, d) {
  const none = t('details.none');
  const yesNo = (v) => (v == null ? none : t(v ? 'details.yes' : 'details.no'));
  const list = (rows) =>
    h(
      'dl',
      { class: 'divide-y divide-ink-100 rounded-xl border border-ink-100' },
      rows.map(([key, value, mono]) =>
        h(
          'div',
          { class: 'grid grid-cols-5 gap-3 px-4 py-2.5 text-sm' },
          h('dt', { class: 'col-span-2 text-ink-500' }, t(key)),
          h('dd', { class: `col-span-3 break-all text-ink ${mono ? 'font-mono text-xs leading-5' : ''}` }, value || none),
        ),
      ),
    );
  const mini = (label, value) =>
    h('div', { class: 'rounded-xl bg-ink-50 px-4 py-3' }, h('p', { class: 'text-xs text-ink-500' }, label), h('p', { class: 'mt-1 text-lg font-semibold tabular-nums' }, value));

  $('#drawer-body').replaceChildren(
    h(
      'div',
      { class: 'mb-5 flex flex-wrap items-center gap-2' },
      statusBadge(d.status),
      h('span', { class: 'badge bg-ink-100 text-ink-600' }, icon(d.storage === 'link' ? 'link' : 'disk', 'size-3.5'), t(`storage.${d.storage}`)),
    ),
    h('div', { class: 'mb-6 grid grid-cols-2 gap-3' }, mini(t('details.size'), fmtSize(d.size)), mini(t('details.files'), d.files == null ? none : fmtNum(d.files))),
    list([
      ['details.path', d.path, true],
      ['details.real_path', d.realPath, true],
      ['details.owner', [d.owner, d.group].filter(Boolean).join(':'), true],
      ['details.site_user', d.siteUser, true],
      ['details.php_socket', d.phpSocket, true],
      ['details.index', d.index, true],
      ['details.writable', yesNo(d.writable)],
      ['details.modified', fmtDate(d.mtime)],
    ]),
    h('h3', { class: 'mt-7 mb-2 text-xs font-semibold tracking-wider text-ink-500 uppercase' }, t('details.settings')),
    list([
      ['details.docroot', d.docroot, true],
      ['details.canonical', d.wwwCanon == null ? none : t(d.wwwCanon ? 'details.canon_www' : 'details.canon_apex')],
      ['details.ssl', t('details.ssl_value')],
    ]),
    h('p', { class: 'mt-2 text-xs text-ink-400' }, t('details.readonly_hint')),
  );

  const caps = d.capabilities;
  const btn = (label, cls, cap, onclick) => h('button', { type: 'button', class: `btn ${cls}`, disabled: !cap?.ok, title: cap?.ok ? null : reasonText(cap), onclick }, label);
  const toggle = d.status === 'locked' ? 'unlock' : 'lock';
  // replaceChildren() n'ignore pas les valeurs nulles (il insère « null ») : on filtre.
  $('#drawer-actions').replaceChildren(
    ...[
    btn(h('span', { class: 'inline-flex items-center gap-2' }, icon('palette'), t('design.title')), 'btn-outline', { ok: can('design.read'), reason: 'permission_denied' }, () => openDesignFor(s.id, d.name, d.status)),
    btn(h('span', { class: 'inline-flex items-center gap-2' }, icon('folder'), t('files.title')), 'btn-outline', { ok: can('files.read'), reason: 'permission_denied' }, () => openFilesFor(s.id, d.name, d.status)),
    d.status === 'incomplete' ? null : btn(h('span', { class: 'inline-flex items-center gap-2' }, icon(toggle), t(`action.${toggle}`)), 'btn-dark', caps[toggle], (e) => runUpdate(s.id, d.name, toggle, e.currentTarget)),
    btn(h('span', { class: 'inline-flex items-center gap-2' }, icon('wrench'), t('action.fix_perms')), 'btn-outline', caps.fixPerms, (e) => runUpdate(s.id, d.name, 'fixPerms', e.currentTarget)),
    btn(h('span', { class: 'inline-flex items-center gap-2' }, icon('trash'), t('action.delete')), 'btn-danger ml-auto', caps.delete, () => openDelete(s.id, d.name)),
    ].filter(Boolean),
  );
}

// ───────────────────────── Update (lock / unlock / droits) ─────────────────────────
async function runUpdate(serverId, name, action, button) {
  if (button) {
    button.disabled = true;
    button.classList.add('animate-pulse');
  }
  try {
    const r = await api(`/api/servers/${enc(serverId)}/domains/${enc(name)}`, { method: 'PATCH', body: { action } });
    const key = { lock: 'toast.locked', unlock: 'toast.unlocked', fixPerms: 'toast.perms_fixed' }[action];
    toast(t(key, { domain: name }), 'success', r.output || undefined);
    if (state.drawer?.name === name) openDetails(serverId, name);
    await loadDomains();
  } catch (err) {
    toastError(err);
    if (button?.isConnected) {
      button.disabled = false;
      button.classList.remove('animate-pulse');
    }
  }
}

// ───────────────────────── Modales : Create / Delete ─────────────────────────
function openCreate() {
  const choices = connectedServers().filter((s) => s.capabilities.create.ok);
  if (!choices.length) return;
  const input = h('input', { id: 'f-domain', class: 'input', placeholder: t('create.placeholder'), autocomplete: 'off', spellcheck: 'false', required: true });
  const select = h('select', { id: 'f-server', class: 'input' }, choices.map((s) => h('option', { value: s.id, selected: s.id === state.current }, `${s.label} — ${s.host}`)));
  const error = h('div', { class: 'mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, t('action.create'));

  const form = h(
    'form',
    {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        submit.textContent = t('action.working');
        try {
          const r = await api(`/api/servers/${enc(select.value)}/domains`, { method: 'POST', body: { domain: input.value } });
          closeModal();
          toast(t('toast.created', { domain: r.domain }), 'success', r.output || undefined);
          await refreshServers();
          await loadDomains({ refresh: true });
        } catch (err) {
          formError(err, error);
          submit.disabled = false;
          submit.textContent = t('action.create');
        }
      },
    },
    modalHeader(t('create.title')),
    h('label', { class: 'label', for: 'f-domain' }, t('create.label')),
    input,
    h('p', { class: 'mt-1.5 mb-4 text-xs text-ink-400' }, t('create.hint')),
    h('label', { class: 'label', for: 'f-server' }, t('create.server')),
    select,
    error,
    h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), submit),
  );
  openModal(form);
}

function openDelete(serverId, name) {
  const input = h('input', { id: 'f-confirm', class: 'input font-mono', autocomplete: 'off', spellcheck: 'false' });
  const error = h('div', { class: 'mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-danger', disabled: true }, t('action.delete'));
  input.addEventListener('input', () => {
    submit.disabled = input.value.trim() !== name;
  });

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        submit.textContent = t('action.working');
        try {
          await api(`/api/servers/${enc(serverId)}/domains/${enc(name)}`, { method: 'DELETE', body: { confirm: input.value.trim() } });
          closeModal();
          if (state.drawer?.name === name) closeDrawer();
          toast(t('toast.deleted', { domain: name }));
          await loadDomains();
        } catch (err) {
          formError(err, error);
          submit.disabled = false;
          submit.textContent = t('action.delete');
        }
      },
    },
    modalHeader(t('delete.title'), 'bg-red-50 text-red-600', 'trash'),
    h('p', { class: 'mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800' }, t('delete.warning', { domain: name })),
    h('label', { class: 'label normal-case', for: 'f-confirm' }, t('delete.type_to_confirm', { domain: name })),
    input,
    error,
    h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), submit),
  );
  openModal(form);
}

// ───────────────────────── Authentification ─────────────────────────
function showLogin(message) {
  state.user = null;
  $('#view-app').hidden = true;
  $('#view-login').hidden = false;
  $('#login-pass').value = '';
  $('#login-error').textContent = message ?? '';
  $('#login-error').hidden = !message;
  $('#login-user').focus();
}

async function showApp() {
  $('#view-login').hidden = true;
  $('#view-app').hidden = false;
  $('#user-name').textContent = t('auth.signed_in_as', { user: state.user.username });
  $('#nav-admin').hidden = !can('users.manage');
  await refreshServers();
  const saved = store.get('lkm.current');
  await selectServer(saved === 'all' || serverById(saved) ? saved : (state.servers[0]?.id ?? 'all'));
  // Mot de passe provisoire : changement exigé avant toute autre action.
  if (state.user.mustChangePassword) accountDialog(state.user, { forced: true });
}

// ───────────────────────── Langues ─────────────────────────
function fillLangSelects() {
  for (const sel of [$('#lang-select'), $('#login-lang')]) {
    sel.replaceChildren(...getLanguages().map((l) => h('option', { value: l.code, selected: l.code === getLang() }, l.name)));
  }
}

onLangChange(() => {
  fillLangSelects();
  if (!state.user) return;
  rerenderFiles();
  rerenderDesign();
  rerenderActions();
  $('#user-name').textContent = t('auth.signed_in_as', { user: state.user.username });
  rerenderAdmin();
  renderSidebar();
  renderHeader();
  renderNotice();
  if (state.result) {
    renderStats(state.result.stats);
    renderRows();
  }
  if (state.drawer) openDetails(state.drawer.serverId, state.drawer.name);
});

// ───────────────────────── Événements ─────────────────────────
function wireEvents() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#login-submit');
    btn.disabled = true;
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { username: $('#login-user').value, password: $('#login-pass').value } });
      state.user = r;
      await showApp();
    } catch (err) {
      showLogin(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $('#btn-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    showLogin();
  });
  for (const sel of ['#lang-select', '#login-lang']) $(sel).addEventListener('change', (e) => setLang(e.target.value));

  $('#nav-all').addEventListener('click', () => selectServer('all'));
  $('#btn-connect-all').addEventListener('click', connectAll);
  $('#btn-menu').addEventListener('click', () => toggleSidebar(true));
  $('#btn-back').addEventListener('click', () => {
    // Fichiers ouverts DEPUIS l'écran Actions : on y retourne, analyse intacte.
    if (isActionsSuspended()) return closeFiles();
    closeFiles();
    closeAdmin();
    closeDesign();
    closeActions();
  });
  $('#btn-account').addEventListener('click', () => state.user && accountDialog(state.user));
  $('#nav-admin').addEventListener('click', async () => {
    closeFiles();
    closeDesign();
    closeActions();
    $('#nav-admin').setAttribute('aria-current', 'true');
    await openAdmin({
      servers: state.servers,
      onClose: () => {
        $('#nav-admin').setAttribute('aria-current', 'false');
        renderHeader();
        renderNotice();
      },
    });
  });
  $('#nav-actions').addEventListener('click', () => {
    closeFiles();
    closeAdmin();
    closeDesign();
    toggleSidebar(false);
    openActions({
      serverId: state.current,
      serverLabel: serverById(state.current)?.label ?? state.current,
      servers: state.servers,
      permissions: state.user?.permissions ?? [],
      onClose: () => {
        renderSidebar();
        renderHeader();
        renderNotice();
      },
    });
    renderSidebar();
  });
  $('#sidebar-backdrop').addEventListener('click', () => toggleSidebar(false));

  $('#btn-conn').addEventListener('click', async () => {
    const s = serverById(state.current);
    if (s.state === 'connected') return disconnect(s.id);
    if (await connect(s.id)) await loadDomains();
  });
  $('#notice-action').addEventListener('click', async () => {
    if (isAll()) return connectAll();
    if (await connect(state.current)) await loadDomains();
  });
  $('#btn-refresh').addEventListener('click', async () => {
    await refreshServers();
    await loadDomains({ refresh: true });
  });
  $('#btn-add').addEventListener('click', openCreate);

  let timer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query.q = e.target.value;
      state.query.page = 1;
      loadDomains();
    }, 250);
  });
  $('#filter').addEventListener('click', (e) => {
    const b = e.target.closest('[data-status]');
    if (b) setStatusFilter(b.dataset.status);
  });
  $('#sort').addEventListener('change', (e) => {
    state.query.sort = e.target.value;
    state.query.page = 1;
    loadDomains();
  });
  $('#size').value = String(state.query.size);
  $('#size').addEventListener('change', (e) => {
    state.query.size = Number(e.target.value);
    state.query.page = 1;
    store.set('lkm.size', e.target.value);
    loadDomains();
  });
  $('#btn-prev').addEventListener('click', () => {
    state.query.page--;
    loadDomains();
  });
  $('#btn-next').addEventListener('click', () => {
    state.query.page++;
    loadDomains();
  });

  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#modal-backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) closeModal();
      else if (!$('#drawer').hidden) closeDrawer();
    } else if (e.key === '/' && state.user && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
      e.preventDefault();
      $('#search').focus();
    }
  });

  // Rafraîchit l'état des connexions (fermeture sur inactivité, etc.).
  setInterval(() => state.user && !document.hidden && refreshServers().then(renderNotice).catch(() => {}), 60000);
}

// ───────────────────────── Démarrage ─────────────────────────
setUnauthorizedHandler(() => showLogin(state.user ? t('errors.auth_required') : null));

(async function boot() {
  await initI18n();
  applyI18n(document);
  fillLangSelects();
  wireEvents();
  try {
    state.user = await api('/api/auth/me');
    await showApp();
  } catch {
    showLogin();
  }
})();
