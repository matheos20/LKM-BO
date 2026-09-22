import { ApiError, api, qs } from './api.js';
import { getLang, t } from './i18n.js';
import { $, closeModal, enc, fmtDate, fmtNum, fmtSize, formError, h, icon, modalHeader, openModal, toast, toastError } from './ui.js';

/**
 * Gestionnaire de fichiers d'un domaine : explorateur, édition, renommage,
 * suppression, compression / décompression et téléchargement.
 */

const state = {
  serverId: null,
  serverLabel: '',
  domain: '',
  path: '',
  data: null,
  status: null,
  selection: new Set(),
  filter: '',
  seq: 0,
  onClose: null,
  // Historique de navigation, comme dans un explorateur de fichiers : les dossiers
  // quittés (Précédent) et ceux d'où l'on est revenu (Suivant).
  history: { back: [], forward: [] },
  // Dossier d'où l'on vient de remonter : mis en évidence pour ne pas perdre le fil.
  focus: null,
};

const base = () => `/api/servers/${enc(state.serverId)}/domains/${enc(state.domain)}/files`;
const isLocked = () => state.status === 'locked';
const rel = (name) => (state.path ? `${state.path}/${name}` : name);
export const isFilesOpen = () => state.serverId !== null;

const EXT_ICON = [
  [/\.(zip|tar|gz|tgz|bz2|xz|rar|7z)$/i, 'archive'],
  [/\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i, 'image'],
  [/\.(php|js|mjs|css|html?|json|xml|ya?ml|sh|sql|ts)$/i, 'code'],
];
const entryIcon = (entry) => {
  if (entry.type === 'dir') return 'folder';
  if (entry.type === 'link') return 'link';
  return EXT_ICON.find(([re]) => re.test(entry.name))?.[1] ?? 'file';
};
const isZip = (entry) => entry.type === 'file' && /\.zip$/i.test(entry.name);

// ───────────────────────── Ouverture / fermeture ─────────────────────────

export async function openFiles({ serverId, serverLabel, domain, status, onClose }) {
  Object.assign(state, { serverId, serverLabel, domain, status: status ?? null, path: '', data: null, filter: '', onClose, focus: null, history: { back: [], forward: [] } });
  state.selection.clear();
  $('#domains-view').hidden = true;
  $('#files-view').hidden = false;
  $('#btn-back').hidden = false;
  for (const sel of ['#btn-conn', '#btn-refresh', '#btn-add']) $(sel).hidden = true;
  await load('');
}

export function closeFiles() {
  if (!isFilesOpen()) return;
  const onClose = state.onClose;
  state.serverId = null;
  state.data = null;
  state.seq++;
  $('#files-view').hidden = true;
  $('#files-view').replaceChildren();
  $('#domains-view').hidden = false;
  $('#btn-back').hidden = true;
  for (const sel of ['#btn-refresh', '#btn-add']) $(sel).hidden = false;
  onClose?.();
}

/** Re-rendu après changement de langue. */
export function rerenderFiles() {
  if (isFilesOpen() && state.data) render();
}

// ───────────────────────── Chargement ─────────────────────────

/**
 * Charge un dossier. `commit` n'est appelé qu'une fois le dossier obtenu : un dossier
 * supprimé entre-temps ne laisse donc pas d'entrée fantôme dans l'historique.
 */
async function load(path = state.path, { keepSelection = false, commit = null, focus = null } = {}) {
  const seq = ++state.seq;
  render({ loading: true });
  try {
    const data = await api(`${base()}?${qs({ path })}`);
    if (seq !== state.seq) return false;
    state.data = data;
    state.path = data.path;
    if (data.status) state.status = data.status;
    if (!keepSelection) state.selection.clear();
    commit?.();
    state.focus = focus;
    render();
    return true;
  } catch (err) {
    if (seq !== state.seq) return false;
    toastError(err);
    render({ error: err });
    return false;
  }
}

// ───────────────────────── Navigation ─────────────────────────

const parentOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Premier dossier de `from` situé sous `to` : celui à mettre en évidence après le retour. */
function childOf(to, from) {
  if (from === to) return null;
  const prefix = to ? `${to}/` : '';
  if (!from.startsWith(prefix)) return null;
  return from.slice(prefix.length).split('/')[0] || null;
}

/** Navigation voulue par l'agent : le dossier quitté rejoint « Précédent ». */
function navigate(path) {
  if (path === state.path) return;
  const leaving = state.path;
  load(path, {
    focus: childOf(path, leaving),
    commit: () => {
      state.history.back.push(leaving);
      state.history.forward.length = 0;
    },
  });
}

function goBack() {
  const target = state.history.back.at(-1);
  if (target === undefined) return;
  const leaving = state.path;
  load(target, {
    focus: childOf(target, leaving),
    commit: () => {
      state.history.back.pop();
      state.history.forward.push(leaving);
    },
  });
}

function goForward() {
  const target = state.history.forward.at(-1);
  if (target === undefined) return;
  const leaving = state.path;
  load(target, {
    focus: childOf(target, leaving),
    commit: () => {
      state.history.forward.pop();
      state.history.back.push(leaving);
    },
  });
}

/** Remonter d'un niveau est une navigation comme une autre : « Précédent » y ramène. */
const goUp = () => state.path && navigate(parentOf(state.path));

/**
 * Raccourcis d'un explorateur de fichiers : Alt+← / Alt+→ / Alt+↑, Retour arrière,
 * et les boutons latéraux de la souris. Inactifs pendant une saisie ou une fenêtre ouverte.
 */
const typing = (el) => el?.closest?.('input, textarea, select, [contenteditable="true"]');
const modalOpen = () => $('#modal') && !$('#modal').hidden;

document.addEventListener('keydown', (e) => {
  if (!isFilesOpen() || !state.data || modalOpen() || typing(e.target)) return;
  const action =
    e.altKey && e.key === 'ArrowLeft' ? goBack
    : e.altKey && e.key === 'ArrowRight' ? goForward
    : e.altKey && e.key === 'ArrowUp' ? goUp
    : !e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'Backspace' ? goBack
    : null;
  if (!action) return;
  // Alt+← est aussi le raccourci « page précédente » du navigateur : on l'intercepte
  // pour qu'il ramène au dossier précédent au lieu de quitter l'application.
  e.preventDefault();
  action();
});

document.addEventListener('mouseup', (e) => {
  if (!isFilesOpen() || !state.data || modalOpen() || (e.button !== 3 && e.button !== 4)) return;
  e.preventDefault();
  (e.button === 3 ? goBack : goForward)();
});

const reload = () => load(state.path, { keepSelection: false });

// ───────────────────────── Rendu ─────────────────────────

function render({ loading = false, error = null } = {}) {
  if (!isFilesOpen()) return;
  $('#page-title').textContent = state.domain;
  $('#page-sub').classList.add('font-mono');
  $('#page-sub').textContent = `${state.serverLabel} · ${state.data?.docroot ?? ''}${state.path ? `/${state.path}` : ''}`;
  $('#page-state').replaceChildren(
    h('span', { class: isLocked() ? 'badge bg-ink text-white' : 'badge bg-accent-100 text-accent-700' }, icon(isLocked() ? 'lock' : 'unlock', 'size-3.5'), t(`status.${isLocked() ? 'locked' : 'unlocked'}`)),
  );
  // replaceChildren() n'ignore pas les valeurs nulles (il insère « null ») : on filtre.
  $('#files-view').replaceChildren(...[breadcrumb(), isLocked() ? lockedBanner() : null, toolbar(), table(loading, error)].filter(Boolean));

  const focused = !loading && $('#files-view tr[data-focus]');
  if (focused) {
    focused.scrollIntoView({ block: 'nearest' });
    setTimeout(() => focused.removeAttribute('data-focus'), 1800);
    state.focus = null;
  }
}

/** Précédent, Suivant, Dossier parent : l'infobulle rappelle le raccourci clavier. */
function navButtons() {
  const btn = (name, label, keys, onclick, disabled) =>
    h(
      'button',
      { type: 'button', class: 'icon-btn size-7', title: `${label} (${keys})`, 'aria-label': label, disabled, onclick },
      icon(name, 'size-4'),
    );
  return h(
    'div',
    { class: 'flex shrink-0 items-center gap-0.5 rounded-lg border border-ink-200 bg-white p-0.5', role: 'group', 'aria-label': t('files.nav_group') },
    btn('arrowLeft', t('files.nav_back'), 'Alt+←', goBack, !state.history.back.length),
    btn('arrowRight', t('files.nav_forward'), 'Alt+→', goForward, !state.history.forward.length),
    btn('arrowUp', t('files.nav_up'), 'Alt+↑', goUp, !state.path),
  );
}

function breadcrumb() {
  const parts = state.path ? state.path.split('/') : [];
  const crumb = (label, path, last) =>
    last
      ? h('span', { class: 'font-semibold text-ink' }, label)
      : h('button', { type: 'button', class: 'text-ink-500 transition hover:text-accent-700 hover:underline', onclick: () => navigate(path) }, label);
  const items = [h('span', { class: 'flex items-center gap-1.5' }, icon('home', 'size-4 text-ink-400'), crumb(t('files.root'), '', parts.length === 0))];
  parts.forEach((part, i) => {
    items.push(icon('chevronRight', 'size-3.5 shrink-0 text-ink-300'));
    items.push(crumb(part, parts.slice(0, i + 1).join('/'), i === parts.length - 1));
  });
  return h(
    'div',
    { class: 'flex items-center gap-3' },
    navButtons(),
    h('nav', { class: 'flex min-w-0 flex-wrap items-center gap-1.5 overflow-x-auto text-sm', 'aria-label': t('files.title') }, items),
  );
}

const lockedBanner = () =>
  h(
    'p',
    { class: 'flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800' },
    icon('lock', 'size-4 shrink-0'),
    t('files.locked'),
  );

function toolbar() {
  const count = state.selection.size;
  const btn = (label, iconName, onclick, { primary = false, danger = false, disabled = false } = {}) =>
    h(
      'button',
      {
        type: 'button',
        class: `btn ${danger ? 'btn-danger' : primary ? 'btn-primary' : 'btn-outline'} px-3 py-1.5`,
        onclick,
        disabled,
        title: disabled && isLocked() ? t('files.locked') : null,
      },
      icon(iconName),
      label,
    );

  const search = h('input', {
    type: 'search',
    class: 'input py-1.5',
    value: state.filter,
    placeholder: t('files.search'),
    autocomplete: 'off',
    oninput: (e) => {
      state.filter = e.target.value;
      render();
    },
  });

  return h(
    'div',
    { class: 'card flex flex-wrap items-center gap-2 px-4 py-3', 'data-toolbar': true },
    h('div', { class: 'min-w-44 flex-1' }, search),
    count
      ? h(
          'span',
          { class: 'badge bg-accent-100 text-accent-700' },
          t('files.selected', { count: fmtNum(count) }),
        )
      : null,
    count ? btn(t('files.download_zip'), 'download', () => downloadSelection()) : null,
    count ? btn(t('files.compress'), 'compress', () => promptCompress(), { disabled: isLocked() }) : null,
    count ? btn(t('files.delete'), 'trash', () => promptDelete([...state.selection]), { danger: true, disabled: isLocked() }) : null,
    btn(t('files.upload'), 'upload', () => promptUpload(), { primary: true, disabled: isLocked() }),
    btn(t('files.new_folder'), 'folderPlus', () => promptMkdir(), { disabled: isLocked() }),
    btn(t('files.new_file'), 'file', () => promptNewFile(), { disabled: isLocked() }),
    btn(t('files.refresh'), 'refresh', () => reload()),
  );
}

/**
 * Met à jour la barre d'outils et le surlignage des lignes sélectionnées,
 * sans reconstruire le tableau (qui peut compter des milliers d'entrées).
 */
function syncSelection() {
  const view = $('#files-view');
  view.querySelector('[data-toolbar]')?.replaceWith(toolbar());
  for (const tr of view.querySelectorAll('tbody tr[data-name]')) {
    tr.classList.toggle('bg-accent-50/60', state.selection.has(tr.dataset.name));
  }
}

function visibleEntries() {
  const needle = state.filter.trim().toLowerCase();
  const entries = state.data?.entries ?? [];
  return needle ? entries.filter((e) => e.name.toLowerCase().includes(needle)) : entries;
}

function table(loading, error) {
  const entries = visibleEntries();
  const allSelected = entries.length > 0 && entries.every((e) => state.selection.has(e.name));

  const head = h(
    'thead',
    { class: 'bg-ink-50/60 text-xs tracking-wide text-ink-500 uppercase' },
    h(
      'tr',
      {},
      h(
        'th',
        { class: 'w-10 px-4 py-3' },
        h('input', {
          type: 'checkbox',
          class: 'size-4 rounded border-ink-300 accent-accent',
          checked: allSelected,
          'aria-label': t('files.select_all'),
          onchange: (e) => {
            for (const entry of entries) (e.target.checked ? state.selection.add(entry.name) : state.selection.delete(entry.name));
            for (const box of $('#files-view').querySelectorAll('tbody input[type=checkbox]')) box.checked = e.target.checked;
            syncSelection();
          },
        }),
      ),
      h('th', { class: 'px-2 py-3 font-semibold' }, t('files.col_name')),
      h('th', { class: 'px-4 py-3 font-semibold' }, t('files.col_size')),
      h('th', { class: 'hidden px-4 py-3 font-semibold md:table-cell' }, t('files.col_modified')),
      h('th', { class: 'hidden px-4 py-3 font-semibold lg:table-cell' }, t('files.col_perms')),
      h('th', { class: 'px-4 py-3 text-right font-semibold' }, t('col.actions')),
    ),
  );

  const message = (text) => h('tr', {}, h('td', { colspan: 6, class: 'px-5 py-14 text-center text-ink-400' }, text));

  // La ligne « .. » des explorateurs : le geste le plus attendu pour remonter.
  const parentRow = state.path && state.data && !error
    ? h(
        'tr',
        {
          class: 'cursor-pointer text-ink-500 transition hover:bg-accent-50/50 focus:bg-accent-50/50 focus:outline-none',
          tabindex: '0',
          title: `${t('files.parent_row')} (Alt+↑)`,
          onclick: goUp,
          onkeydown: (e) => e.key === 'Enter' && goUp(),
        },
        h('td', { class: 'px-4 py-2.5' }),
        h(
          'td',
          { class: 'px-2 py-2.5', colspan: 5 },
          h('span', { class: 'flex items-center gap-2' }, icon('arrowUp', 'size-4 text-ink-400'), h('span', { class: 'font-mono' }, '..'), h('span', { class: 'text-xs text-ink-400' }, t('files.parent_row'))),
        ),
      )
    : null;
  const body = h(
    'tbody',
    { class: 'divide-y divide-ink-100' },
    ...[parentRow, ...(loading && !state.data ? [message(t('files.loading'))] : error ? [message(error.message)] : entries.length ? entries.map(row) : [message(t('files.empty'))])].filter(Boolean),
  );

  const footer = h(
    'footer',
    { class: 'flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 px-4 py-3 text-xs text-ink-500' },
    h('span', {}, t('files.count', { count: fmtNum(entries.length) })),
    state.data?.truncated ? h('span', { class: 'text-amber-700' }, t('files.truncated', { limit: fmtNum(state.data.limit) })) : null,
  );

  return h(
    'section',
    { class: `card overflow-hidden ${loading ? 'opacity-60' : ''}` },
    h('div', { class: 'overflow-x-auto' }, h('table', { class: 'w-full text-left text-sm' }, head, body)),
    footer,
  );
}

function row(entry) {
  const selected = state.selection.has(entry.name);
  const iconCls = entry.type === 'dir' ? 'size-4 shrink-0 text-accent-700' : 'size-4 shrink-0 text-ink-400';
  const open = () => (entry.type === 'dir' ? navigate(rel(entry.name)) : openEditor(entry));

  const action = (name, label, onclick, { disabled = false, extra = '' } = {}) =>
    h(
      'button',
      { type: 'button', class: `icon-btn ${extra}`, title: disabled && isLocked() ? t('files.locked') : label, 'aria-label': label, disabled, onclick },
      icon(name),
    );

  return h(
    'tr',
    {
      // data-focus : le dossier d'où l'on revient, surligné le temps de retrouver ses repères.
      class: `transition-colors duration-700 hover:bg-accent-50/50 data-[focus]:bg-accent-100 ${selected ? 'bg-accent-50/60' : ''}`,
      'data-name': entry.name,
      'data-focus': state.focus === entry.name ? '' : null,
    },
    h(
      'td',
      { class: 'px-4 py-2.5' },
      h('input', {
        type: 'checkbox',
        class: 'size-4 rounded border-ink-300 accent-accent',
        checked: selected,
        'aria-label': entry.name,
        onchange: (e) => {
          if (e.target.checked) state.selection.add(entry.name);
          else state.selection.delete(entry.name);
          syncSelection();
        },
      }),
    ),
    h(
      'td',
      { class: 'px-2 py-2.5' },
      h(
        'button',
        { type: 'button', class: 'flex max-w-md items-center gap-2 text-left', onclick: open },
        icon(entryIcon(entry), iconCls),
        h('span', { class: 'truncate font-medium text-ink hover:text-accent-700 hover:underline' }, entry.name),
      ),
      entry.linkTarget ? h('p', { class: 'truncate pl-6 font-mono text-[11px] text-ink-400' }, `→ ${entry.linkTarget}`) : null,
    ),
    h('td', { class: 'px-4 py-2.5 whitespace-nowrap text-ink-500 tabular-nums' }, entry.type === 'dir' ? '—' : fmtSize(entry.size)),
    h('td', { class: 'hidden px-4 py-2.5 whitespace-nowrap text-ink-500 md:table-cell' }, fmtDate(entry.mtime)),
    h('td', { class: 'hidden px-4 py-2.5 font-mono text-xs text-ink-400 lg:table-cell' }, entry.mode),
    h(
      'td',
      { class: 'px-4 py-2' },
      h(
        'div',
        { class: 'flex justify-end gap-0.5' },
        entry.type === 'file' ? action('code', t('files.edit'), () => openEditor(entry), { disabled: isLocked() }) : null,
        isZip(entry) ? action('expand', t('files.extract'), () => promptExtract(entry), { disabled: isLocked() }) : null,
        action('download', t('files.download'), () => (entry.type === 'file' ? downloadFile(entry) : downloadSelection([entry.name]))),
        action('pencil', t('files.rename'), () => promptRename(entry), { disabled: isLocked() }),
        action('trash', t('files.delete'), () => promptDelete([entry.name]), { disabled: isLocked(), extra: 'hover:bg-red-50 hover:text-red-600' }),
      ),
    ),
  );
}

// ───────────────────────── Téléchargements ─────────────────────────

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function downloadFile(entry) {
  const a = h('a', { href: `${base()}/download?${qs({ path: rel(entry.name) })}`, download: entry.name });
  document.body.append(a);
  a.click();
  a.remove();
  toast(t('files.toast_downloaded', { name: entry.name }), 'info');
}

async function downloadSelection(names = [...state.selection]) {
  if (!names.length) return;
  toast(t('files.preparing'), 'info');
  try {
    const res = await fetch(`${base()}/download`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'lkm-bo', 'X-Lang': getLang() },
      body: JSON.stringify({ path: state.path, names }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error?.message ?? t('errors.generic'), data.error?.key, data.error?.detail);
    }
    const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1];
    const blob = await res.blob();
    const fileName = name ? decodeURIComponent(name) : `${state.domain}.zip`;
    saveBlob(blob, fileName);
    toast(t('files.toast_downloaded', { name: fileName }));
  } catch (err) {
    toastError(err);
  }
}

// ───────────────────────── Éditeur ─────────────────────────

async function openEditor(entry) {
  let file;
  try {
    file = await api(`${base()}/read?${qs({ path: rel(entry.name) })}`);
  } catch (err) {
    return toastError(err);
  }
  if (file.binary) return toast(t('files.binary'), 'info');

  const area = h('textarea', {
    class: 'h-[55vh] w-full resize-none rounded-xl border border-ink-200 bg-ink-50/40 p-3 font-mono text-xs leading-5 text-ink focus:border-accent focus:outline-none',
    spellcheck: 'false',
    wrap: 'off',
  });
  area.value = file.content;
  const dirty = h('span', { class: 'text-xs text-amber-700', hidden: true }, t('files.unsaved'));
  const error = h('div', { class: 'mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary', disabled: isLocked(), title: isLocked() ? t('files.locked') : t('files.save_hint') }, icon('save'), t('files.save'));
  let mtime = file.mtimeRaw;

  area.addEventListener('input', () => {
    dirty.hidden = area.value === file.content;
  });

  const save = async (e) => {
    e?.preventDefault();
    if (isLocked()) return;
    error.hidden = true;
    submit.disabled = true;
    try {
      const saved = await api(`${base()}/content`, { method: 'PUT', body: { path: rel(entry.name), content: area.value, expectMtime: mtime } });
      mtime = saved.mtimeRaw;
      file.content = area.value;
      dirty.hidden = true;
      toast(t('files.toast_saved', { name: entry.name }));
      reload();
    } catch (err) {
      formError(err, error);
    } finally {
      submit.disabled = isLocked();
    }
  };

  const form = h(
    'form',
    { onsubmit: save, onkeydown: (e) => (e.ctrlKey || e.metaKey) && e.key === 's' && save(e) },
    h(
      'div',
      { class: 'mb-4 flex flex-wrap items-center gap-3' },
      icon(entryIcon(entry), 'size-5 text-ink-400'),
      h('h2', { class: 'min-w-0 flex-1 truncate text-lg font-semibold' }, entry.name),
      dirty,
      h('span', { class: 'text-xs text-ink-400' }, fmtSize(file.size)),
    ),
    area,
    error,
    h(
      'div',
      { class: 'mt-4 flex justify-end gap-2' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.close')),
      submit,
    ),
  );
  openModal(form, 'max-w-4xl');
}

// ───────────────────────── Boîtes de dialogue ─────────────────────────

function promptText({ title, label, value = '', hint = '', iconName = 'pencil', submitLabel, tone, run }) {
  const input = h('input', { class: 'input', value, autocomplete: 'off', spellcheck: 'false', required: true });
  const error = h('div', { class: 'mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const submit = h('button', { type: 'submit', class: `btn ${tone ?? 'btn-primary'}` }, submitLabel);
  const form = h(
    'form',
    {
      novalidate: true,
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        const previous = submit.textContent;
        submit.textContent = t('action.working');
        try {
          await run(input.value.trim());
          closeModal();
        } catch (err) {
          formError(err, error);
          submit.disabled = false;
          submit.textContent = previous;
        }
      },
    },
    modalHeader(title, tone === 'btn-danger' ? 'bg-red-50 text-red-600' : 'bg-accent-50 text-accent-700', iconName),
    h('label', { class: 'label' }, label),
    input,
    hint ? h('p', { class: 'mt-1.5 text-xs text-ink-400' }, hint) : null,
    error,
    h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), submit),
  );
  openModal(form);
  setTimeout(() => input.select(), 40);
}

const promptRename = (entry) =>
  promptText({
    title: t('files.rename_title'),
    label: t('files.rename_label'),
    value: entry.name,
    iconName: 'pencil',
    submitLabel: t('files.rename'),
    run: async (name) => {
      const res = await api(`${base()}/rename`, { method: 'POST', body: { path: rel(entry.name), name } });
      toast(t('files.toast_renamed', { name: res.name }));
      await reload();
    },
  });

const promptMkdir = () =>
  promptText({
    title: t('files.new_folder_title'),
    label: t('files.new_folder_label'),
    iconName: 'folderPlus',
    submitLabel: t('action.create'),
    run: async (name) => {
      const res = await api(`${base()}/mkdir`, { method: 'POST', body: { path: state.path, name } });
      toast(t('files.toast_folder', { name: res.name }));
      await reload();
    },
  });

// ───────────────────────── Téléversement ─────────────────────────

function promptUpload() {
  const picker = h('input', { type: 'file', class: 'hidden' });
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.remove();
    if (file) uploadDialog(file);
  });
  document.body.append(picker);
  picker.click();
}

/** Envoi en corps binaire brut. XHR et non fetch : seul XHR expose la progression d'envoi. */
function sendFile(file, { extract }, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base()}/upload?${qs({ path: state.path, name: file.name, extract: extract ? 1 : '' })}`);
    xhr.setRequestHeader('X-Requested-With', 'lkm-bo');
    xhr.setRequestHeader('X-Lang', getLang());
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', (e) => e.lengthComputable && onProgress(e.loaded / e.total));
    xhr.addEventListener('load', () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data.error?.message ?? t('errors.generic'), data.error?.key, data.error?.detail));
    });
    xhr.addEventListener('error', () => reject(new ApiError(0, t('errors.network'), 'errors.network')));
    xhr.send(file);
  });
}

function uploadDialog(file) {
  const max = state.data?.maxUpload ?? 200 * 1024 * 1024;
  const tooBig = file.size > max;
  const isZip = /\.zip$/i.test(file.name);

  const extract = h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', checked: isZip });
  const fill = h('div', { class: 'h-full w-0 rounded-full bg-accent transition-all' });
  const track = h('div', { class: 'mt-4 h-2 w-full overflow-hidden rounded-full bg-ink-100', hidden: true }, fill);
  const error = h(
    'div',
    { class: 'mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: !tooBig, role: 'alert' },
    tooBig ? t('errors.file_too_big') : '',
  );
  const submit = h('button', { type: 'submit', class: 'btn btn-primary', disabled: tooBig }, icon('upload'), t('files.upload_send'));
  const line = (label, value) =>
    h(
      'div',
      { class: 'flex items-baseline justify-between gap-3 border-b border-ink-100 py-2 text-sm' },
      h('span', { class: 'shrink-0 text-ink-500' }, label),
      h('span', { class: 'truncate font-medium' }, value),
    );

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        track.hidden = false;
        submit.disabled = true;
        submit.replaceChildren(t('files.upload_progress', { percent: 0 }));
        try {
          const res = await sendFile(file, { extract: extract.checked && isZip }, (ratio) => {
            const percent = Math.round(ratio * 100);
            fill.style.width = `${percent}%`;
            submit.replaceChildren(t('files.upload_progress', { percent }));
          });
          closeModal();
          toast(
            res.extracted
              ? t('files.toast_uploaded_extracted', { name: res.name, count: res.extracted.files })
              : t('files.toast_uploaded', { name: res.name }),
          );
          await reload();
        } catch (err) {
          formError(err, error);
          track.hidden = true;
          submit.disabled = false;
          submit.replaceChildren(icon('upload'), t('files.upload_send'));
          // Le fichier peut avoir été déposé avant l'échec (décompression invalide, par ex.) :
          // on rafraîchit la liste pour que l'état affiché corresponde au serveur.
          reload();
        }
      },
    },
    modalHeader(t('files.upload_title'), 'bg-accent-50 text-accent-700', 'upload'),
    line(t('files.upload_file'), file.name),
    line(t('files.col_size'), fmtSize(file.size)),
    line(t('files.upload_target'), state.path ? `/${state.path}` : t('files.root')),
    isZip ? h('label', { class: 'mt-4 flex items-center gap-2 text-sm' }, extract, t('files.upload_extract')) : null,
    h('p', { class: 'mt-3 text-xs text-ink-400' }, t('files.upload_hint', { size: fmtSize(max) })),
    track,
    error,
    h(
      'div',
      { class: 'mt-6 flex justify-end gap-2' },
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')),
      submit,
    ),
  );
  openModal(form);
}

const promptNewFile = () =>
  promptText({
    title: t('files.new_file_title'),
    label: t('files.new_file_label'),
    iconName: 'file',
    submitLabel: t('action.create'),
    run: async (name) => {
      const res = await api(`${base()}/new-file`, { method: 'POST', body: { path: state.path, name } });
      toast(t('files.toast_file', { name: res.name }));
      await reload();
      const entry = (state.data?.entries ?? []).find((e) => e.name === res.name);
      if (entry) openEditor(entry);
    },
  });

function promptCompress() {
  const names = [...state.selection];
  const suggestion = names.length === 1 ? `${names[0]}.zip` : `${state.domain}.zip`;
  promptText({
    title: t('files.compress_title'),
    label: t('files.compress_label'),
    value: suggestion,
    hint: t('files.compress_hint', { count: names.length }),
    iconName: 'compress',
    submitLabel: t('files.compress'),
    run: async (archive) => {
      const res = await api(`${base()}/compress`, { method: 'POST', body: { path: state.path, names, archive } });
      toast(t('files.toast_compressed', { name: res.name, count: res.entries }), 'success', fmtSize(res.size));
      await reload();
    },
  });
}

const promptExtract = (entry) =>
  promptText({
    title: t('files.extract_title'),
    label: t('files.extract_label'),
    value: entry.name.replace(/\.zip$/i, ''),
    hint: t('files.extract_hint', { name: entry.name }),
    iconName: 'expand',
    submitLabel: t('files.extract'),
    run: async (dest) => {
      const res = await api(`${base()}/extract`, { method: 'POST', body: { path: rel(entry.name), dest } });
      const skipped = res.skipped ? t('files.toast_skipped', { skipped: res.skipped }) : '';
      toast(t('files.toast_extracted', { name: res.name, count: res.files }) + skipped);
      await reload();
    },
  });

function promptDelete(names) {
  const error = h('div', { class: 'mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-danger' }, t('files.delete'));
  const preview = names.slice(0, 8);
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.hidden = true;
        submit.disabled = true;
        submit.textContent = t('action.working');
        try {
          await api(base(), { method: 'DELETE', body: { paths: names.map(rel) } });
          closeModal();
          toast(t('files.toast_deleted', { count: names.length }));
          await reload();
        } catch (err) {
          formError(err, error);
          submit.disabled = false;
          submit.textContent = t('files.delete');
        }
      },
    },
    modalHeader(t('files.delete_title'), 'bg-red-50 text-red-600', 'trash'),
    h('p', { class: 'mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800' }, t('files.delete_warning', { count: names.length })),
    h(
      'ul',
      { class: 'max-h-40 overflow-auto rounded-lg border border-ink-100 px-3 py-2 font-mono text-xs text-ink-600' },
      ...preview.map((n) => h('li', { class: 'truncate' }, n)),
      names.length > preview.length ? h('li', { class: 'text-ink-400' }, `+ ${names.length - preview.length}`) : null,
    ),
    error,
    h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), submit),
  );
  openModal(form);
}
