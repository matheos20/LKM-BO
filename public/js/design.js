import { ApiError, api } from './api.js';
import { colorTool, normalizeColor } from './colors.js';
import { layoutLabel, wireframe } from './blocks.js';
import { getLang, t } from './i18n.js';
import { $, closeModal, enc, fmtDate, formError, h, icon, modalHeader, openModal, toast, toastError } from './ui.js';

/**
 * Éditeur de design et de contenu d'un site.
 *
 * Principe d'ergonomie : on ne montre jamais de code. Les blocs de la page d'accueil se
 * choisissent dans une liste illustrée, les couleurs dans des sélecteurs, les textes dans
 * des champs ordinaires. Rien ne part en ligne sans passer par « Publier », et
 * « Prévisualiser » montre le résultat exact sans toucher au site.
 */

const state = {
  open: false,
  serverId: null,
  serverLabel: '',
  domain: '',
  status: null,
  permissions: [],
  tab: 'home',
  catalog: null,
  site: null,
  config: {},
  style: {},
  dirty: false,
  hasDraft: false,
  selected: 0,
  saving: false,
  savedAt: null,
  saveTimer: null,
  articles: [],
  articlesLoading: false,
  titlesLoading: false,
  metasStalled: false,
  metas: new Map(),
  articleFilter: '',
  articleCategory: '',
  article: null,
  backups: [],
  onClose: null,
};

export const isDesignOpen = () => state.open;
const can = (p) => state.permissions.includes(p);
const base = () => `/api/servers/${enc(state.serverId)}/domains/${enc(state.domain)}/design`;
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const humanize = (v) => String(v).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const familyOf = (section) => state.catalog?.families.find((f) => f.variants.includes(section));

// ───────────────────────── Ouverture / fermeture ─────────────────────────

export async function openDesign({ serverId, serverLabel, domain, status, permissions, onClose }) {
  // Tout ce qui décrit le domaine précédent est remis à zéro : sans cela, la liste
  // d'articles, les sauvegardes et les titres du site précédent restaient affichés.
  Object.assign(state, {
    open: true,
    serverId,
    serverLabel,
    domain,
    status,
    permissions: permissions ?? [],
    onClose,
    tab: 'home',
    selected: 0,
    savedAt: null,
    article: null,
    articles: [],
    articlesLoading: false,
    titlesLoading: false,
    metasStalled: false,
    articleFilter: '',
    articleCategory: '',
    metas: new Map(),
    backups: [],
  });
  $('#domains-view').hidden = true;
  $('#files-view').hidden = true;
  $('#admin-view').hidden = true;
  $('#design-view').hidden = false;
  $('#btn-back').hidden = false;
  for (const sel of ['#btn-conn', '#btn-refresh', '#btn-add']) $(sel).hidden = true;
  await load();
}

export function closeDesign() {
  if (!state.open) return;
  state.open = false;
  $('#design-view').hidden = true;
  $('#design-view').replaceChildren();
  $('#domains-view').hidden = false;
  $('#btn-back').hidden = true;
  for (const sel of ['#btn-refresh', '#btn-add']) $(sel).hidden = false;
  state.onClose?.();
}

export const rerenderDesign = () => state.open && state.site && render();

async function load() {
  render({ loading: true });
  try {
    const [catalog, site] = await Promise.all([state.catalog ? Promise.resolve({ ...state.catalog }) : api('/api/design/catalog'), api(base())]);
    state.catalog = catalog;
    state.site = site;
    state.hasDraft = Boolean(site.draft);
    state.config = clone(site.draft?.config ?? site.published.config);
    state.style = clone(site.draft?.style ?? site.published.style);
    state.dirty = false;
    render();
  } catch (err) {
    toastError(err);
    render({ error: err });
  }
}

/**
 * Toute modification marque le brouillon comme à enregistrer, puis l'enregistre seule
 * après une courte pause. L'agent n'a plus d'étape « penser à sauvegarder » : le bouton
 * reste disponible pour ceux qui préfèrent le geste explicite.
 */
const AUTOSAVE_MS = 2000;

const touch = () => {
  state.dirty = true;
  renderToolbar();
  refreshExcerpt();
  if (!can('design.edit')) return;
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveDraft({ silent: true }), AUTOSAVE_MS);
};

// ───────────────────────── Rendu général ─────────────────────────

function render({ loading = false, error = null } = {}) {
  if (!state.open) return;
  $('#page-title').textContent = state.domain;
  $('#page-sub').classList.remove('font-mono');
  $('#page-sub').textContent = `${t('design.title')} · ${state.serverLabel}`;
  $('#page-state').replaceChildren();

  if (loading) return $('#design-view').replaceChildren(h('div', { class: 'card px-6 py-16 text-center text-ink-400' }, t('files.loading')));
  if (error) return $('#design-view').replaceChildren(h('div', { class: 'card px-6 py-16 text-center text-red-600' }, error.message));

  const locked = state.status === 'locked';
  $('#design-view').replaceChildren(
    ...[
      locked
        ? h(
            'p',
            { class: 'flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800' },
            icon('lock', 'size-4 shrink-0'),
            t('design.locked'),
          )
        : null,
      toolbar(),
      tabs(),
      body(),
    ].filter(Boolean),
  );
}

function renderToolbar() {
  const old = $('#design-view [data-toolbar]');
  if (old) old.replaceWith(toolbar());
}

function tabButton(key, label) {
  return h(
    'button',
    {
      type: 'button',
      class: 'seg',
      'aria-pressed': String(state.tab === key),
      onclick: () => {
        state.tab = key;
        render();
      },
    },
    label,
  );
}

const tabs = () =>
  h(
    'div',
    { class: 'flex flex-wrap gap-1 rounded-lg bg-ink-50 p-1' },
    tabButton('home', t('design.tab_home')),
    tabButton('theme', t('design.tab_theme')),
    tabButton('identity', t('design.tab_identity')),
    tabButton('articles', t('design.tab_articles')),
    tabButton('backups', t('design.tab_backups')),
  );

/**
 * Barre d'action, toujours visible pendant le défilement : où en est le brouillon,
 * et les trois seuls gestes qui comptent — enregistrer, voir, mettre en ligne.
 */
function toolbar() {
  const editable = can('design.edit');
  const savedTime = state.savedAt ? state.savedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const statusChip = state.saving
    ? h('span', { class: 'badge bg-ink-100 text-ink-600' }, icon('refresh', 'size-3.5'), t('design.saving'))
    : state.dirty
      ? h('span', { class: 'badge bg-amber-100 text-amber-800' }, icon('pencil', 'size-3.5'), t('design.draft_pending'))
      : state.hasDraft
        ? h('span', { class: 'badge bg-accent-100 text-accent-700' }, icon('check', 'size-3.5'), savedTime ? t('design.draft_saved_at', { time: savedTime }) : t('design.draft_kept'))
        : h('span', { class: 'badge bg-ink-100 text-ink-600' }, t('design.no_draft'));

  const btn = (label, iconName, onclick, { tone = 'btn-outline', disabled = false, title = null } = {}) =>
    h('button', { type: 'button', class: `btn ${tone} px-3 py-1.5`, onclick, disabled, title }, icon(iconName), label);

  const actions = h(
    'div',
    { class: 'flex flex-wrap items-center gap-2' },
    statusChip,
    state.site?.draft?.stale ? h('span', { class: 'badge bg-red-100 text-red-700' }, icon('alert', 'size-3.5'), t('design.stale')) : null,
    h('span', { class: 'flex-1' }),
    btn(t('design.save_draft'), 'save', saveDraft, { disabled: !editable || !state.dirty }),
    btn(t('design.preview'), 'eye', () => previewSite(), { tone: 'btn-dark', disabled: !editable }),
    btn(t('design.publish'), 'upload', confirmPublish, {
      tone: 'btn-primary',
      disabled: !can('design.publish') || state.status === 'locked' || (!state.hasDraft && !state.dirty),
      title: state.status === 'locked' ? t('design.locked') : null,
    }),
    state.hasDraft || state.dirty ? btn(t('design.discard'), 'trash', confirmDiscard, { disabled: !editable }) : null,
  );

  return h(
    'div',
    { class: 'card sticky top-0 z-20 space-y-2 px-4 py-3', 'data-toolbar': true },
    actions,
    h('p', { class: 'text-xs text-ink-400' }, t('design.flow_hint')),
  );
}

const body = () => {
  switch (state.tab) {
    case 'theme':
      return themeTab();
    case 'identity':
      return identityTab();
    case 'articles':
      return articlesTab();
    case 'backups':
      return backupsTab();
    default:
      return homeTab();
  }
};

// ───────────────────────── Briques de formulaire ─────────────────────────

/**
 * Un champ et son intitulé.
 *
 * Une zone d'édition enrichie n'est jamais mise dans un `<label>` : au premier clic,
 * le navigateur y recopie le style du libellé et tout le texte devient gras. Elle reçoit
 * donc un `aria-label`, qui l'annonce aussi bien aux lecteurs d'écran.
 */
const field = (label, control, hint) => {
  const editable = control.querySelector?.('[contenteditable]') ?? (control.isContentEditable ? control : null);
  if (editable) editable.setAttribute('aria-label', label);
  return h(
    editable ? 'div' : 'label',
    { class: 'block' },
    h('span', { class: 'label' }, label),
    control,
    hint ? h('p', { class: 'mt-1 text-xs text-ink-400' }, hint) : null,
  );
};

function textInput(value, onChange, { placeholder = '', mono = false } = {}) {
  const input = h('input', { class: `input ${mono ? 'font-mono text-xs' : ''}`, value: value ?? '', placeholder, autocomplete: 'off' });
  input.addEventListener('input', () => onChange(input.value));
  return input;
}

function textArea(value, onChange, { rows = 3 } = {}) {
  const area = h('textarea', { class: 'input', rows: String(rows) });
  area.value = value ?? '';
  area.addEventListener('input', () => onChange(area.value));
  return area;
}

function selectInput(options, value, onChange, labelFn = humanize) {
  const select = h('select', { class: 'input' }, ...options.map((o) => h('option', { value: o, selected: o === value }, labelFn(o))));
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function colorInput(value, onChange) {
  const swatch = h('input', { type: 'color', class: 'h-9 w-12 cursor-pointer rounded border border-ink-200 bg-white p-1', value: value ?? '#000000' });
  const hex = h('input', { class: 'input font-mono text-xs', value: value ?? '', autocomplete: 'off', maxlength: '9' });
  const sync = (v, from) => {
    if (!/^#[0-9a-f]{6}$/i.test(v)) return;
    if (from !== 'hex') hex.value = v;
    if (from !== 'swatch') swatch.value = v;
    onChange(v.toLowerCase());
  };
  swatch.addEventListener('input', () => sync(swatch.value, 'swatch'));
  hex.addEventListener('input', () => sync(hex.value.trim(), 'hex'));
  return h('div', { class: 'flex items-center gap-2' }, swatch, hex);
}

/** Choix d'une image parmi celles déjà présentes sur le site. */
function imageInput(value, onChange) {
  const preview = h('div', { class: 'flex items-center gap-3' });
  const paint = () => {
    preview.replaceChildren(
      value
        ? h('img', { src: `https://${state.domain}/images/${value}-600.jpg`, alt: '', class: 'h-16 w-24 rounded-lg border border-ink-100 object-cover', loading: 'lazy' })
        : h('div', { class: 'flex h-16 w-24 items-center justify-center rounded-lg border border-dashed border-ink-200 text-xs text-ink-400' }, t('design.image_none')),
      h(
        'div',
        { class: 'flex flex-col gap-1' },
        h('button', { type: 'button', class: 'btn btn-outline px-3 py-1.5', onclick: () => pickImage((id) => { value = id; onChange(id); paint(); }) }, icon('image'), t('design.image_choose')),
        value ? h('button', { type: 'button', class: 'text-xs text-ink-400 hover:text-red-600', onclick: () => { value = ''; onChange(''); paint(); } }, t('design.remove')) : null,
      ),
    );
  };
  paint();
  return preview;
}

/**
 * Choix d'une image parmi celles du site, ou import d'une nouvelle depuis le poste.
 *
 * Le moteur du parc n'affiche que des déclinaisons `<id>-<largeur>.<ext>` : l'import
 * les fabrique toutes sur le serveur du site. L'agent, lui, dépose simplement un fichier.
 */
function pickImage(onPick) {
  const images = [...(state.site?.available?.images ?? [])];
  const grid = h('div', { class: 'grid max-h-[55vh] grid-cols-4 gap-2 overflow-y-auto' });
  let filter = '';

  const paint = () => {
    const list = images.filter((id) => id.includes(filter)).slice(0, 200);
    grid.replaceChildren(
      ...(list.length
        ? list.map((id) =>
            h(
              'button',
              { type: 'button', class: 'group overflow-hidden rounded-lg border border-ink-100 transition hover:border-accent', onclick: () => { onPick(id); closeModal(); } },
              h('img', { src: `https://${state.domain}/images/${id}-600.jpg`, alt: id, class: 'h-20 w-full object-cover', loading: 'lazy' }),
              h('span', { class: 'block truncate px-1 py-0.5 font-mono text-[10px] text-ink-400' }, id),
            ),
          )
        : [h('p', { class: 'col-span-4 py-8 text-center text-sm text-ink-400' }, t('design.image_none_found'))]),
    );
  };

  const search = textInput('', (v) => {
    filter = v.trim();
    paint();
  }, { placeholder: t('design.image_search') });

  // ── Import depuis le poste de l'agent
  const état = h('p', { class: 'text-xs text-ink-400' });
  const champ = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif', class: 'hidden' });
  const bouton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-outline px-3 py-1.5 whitespace-nowrap',
      disabled: !can('design.edit') || state.status === 'locked',
      title: state.status === 'locked' ? t('design.locked') : null,
      onclick: () => champ.click(),
    },
    icon('upload'),
    t('design.image_import'),
  );

  champ.addEventListener('change', async () => {
    const file = champ.files?.[0];
    champ.value = '';
    if (!file) return;
    bouton.disabled = true;
    état.textContent = t('design.image_importing', { name: file.name });
    try {
      const res = await sendImage(file);
      // L'image devient disponible partout dans l'éditeur, sans recharger la page.
      state.site.available.images = [...images.filter((id) => id !== res.id), res.id].sort();
      images.length = 0;
      images.push(...state.site.available.images);
      paint();
      état.textContent = t('design.image_imported', { count: res.files.length, width: res.width, height: res.height });
      toast(t('design.image_imported_toast', { id: res.id }));
      onPick(res.id);
      closeModal();
    } catch (err) {
      état.textContent = '';
      toastError(err);
    } finally {
      bouton.disabled = false;
    }
  });

  paint();
  openModal(
    h(
      'div',
      {},
      modalHeader(t('design.image_choose'), 'bg-accent-50 text-accent-700', 'image'),
      h('div', { class: 'flex flex-wrap items-center gap-2' }, h('div', { class: 'min-w-48 flex-1' }, search), bouton, champ),
      h('p', { class: 'mt-1 text-xs text-ink-400' }, t('design.image_import_hint')),
      état,
      h('div', { class: 'mt-3' }, grid),
    ),
    'max-w-3xl',
  );
}

/** Envoi de l'image en corps binaire brut, comme le gestionnaire de fichiers. */
async function sendImage(file) {
  let res;
  try {
    res = await fetch(`${base()}/images?name=${enc(file.name)}`, {
      method: 'POST',
      headers: { 'X-Requested-With': 'lkm-bo', 'X-Lang': getLang(), 'Content-Type': 'application/octet-stream' },
      credentials: 'same-origin',
      body: file,
    });
  } catch {
    throw new ApiError(0, t('errors.network'), 'errors.network');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error?.message ?? t('errors.generic'), data.error?.key, data.error?.detail);
  return data;
}

function buttonInput(value, onChange) {
  const v = value ?? {};
  return h(
    'div',
    { class: 'grid gap-2 sm:grid-cols-2' },
    field(t('design.btn_text'), richLine(v.text, (text) => onChange({ ...v, text }))),
    field(t('design.btn_url'), textInput(v.url, (url) => onChange({ ...v, url }), { placeholder: '/' })),
  );
}

/** Liste d'éléments répétables (chiffres clés, témoignages, questions…). */
function listInput(items, itemFields, onChange) {
  const list = Array.isArray(items) ? clone(items) : [];
  const wrap = h('div', { class: 'space-y-3' });
  const paint = () => {
    wrap.replaceChildren(
      ...list.map((item, index) =>
        h(
          'div',
          { class: 'rounded-xl border border-ink-100 p-3' },
          h(
            'div',
            { class: 'mb-2 flex items-center justify-between' },
            h('span', { class: 'text-xs font-semibold text-ink-500' }, `${index + 1}`),
            h(
              'div',
              { class: 'flex gap-1' },
              h('button', { type: 'button', class: 'icon-btn', title: t('design.move_up'), disabled: index === 0, onclick: () => { [list[index - 1], list[index]] = [list[index], list[index - 1]]; onChange(list); paint(); } }, icon('chevronRight', 'size-4 -rotate-90')),
              h('button', { type: 'button', class: 'icon-btn', title: t('design.move_down'), disabled: index === list.length - 1, onclick: () => { [list[index + 1], list[index]] = [list[index], list[index + 1]]; onChange(list); paint(); } }, icon('chevronRight', 'size-4 rotate-90')),
              h('button', { type: 'button', class: 'icon-btn hover:bg-red-50 hover:text-red-600', title: t('design.remove'), onclick: () => { list.splice(index, 1); onChange(list); paint(); } }, icon('trash')),
            ),
          ),
          h(
            'div',
            { class: 'grid gap-2 sm:grid-cols-2' },
            ...itemFields.map((f) =>
              field(
                t(`design.field.${f.key}`),
                f.type === 'image'
                  ? imageInput(item[f.key], (v) => { item[f.key] = v; onChange(list); })
                  : f.inline
                    ? richLine(item[f.key], (v) => { item[f.key] = v; onChange(list); }, { multiline: f.type === 'textarea' })
                    : f.type === 'textarea'
                      ? textArea(item[f.key], (v) => { item[f.key] = v; onChange(list); }, { rows: 3 })
                      : textInput(item[f.key], (v) => { item[f.key] = v; onChange(list); }),
              ),
            ),
          ),
        ),
      ),
      h('button', { type: 'button', class: 'btn btn-outline px-3 py-1.5', onclick: () => { list.push(Object.fromEntries(itemFields.map((f) => [f.key, '']))); onChange(list); paint(); } }, icon('plus'), t('design.add_item')),
    );
  };
  paint();
  return wrap;
}

// ───────────────────────── Onglet « Page d'accueil » ─────────────────────────

/**
 * Deux colonnes : à gauche la page bloc par bloc, à droite le bloc en cours de
 * modification. On ne montre qu'un bloc à la fois — l'agent voit toujours où il en
 * est, et la page ne se transforme jamais en formulaire à rallonge.
 */
function homeTab() {
  const sections = state.config.homepage_sections ?? [];
  state.config.homepage ??= {};
  if (typeof state.selected === 'number' && state.selected >= sections.length) state.selected = sections.length ? sections.length - 1 : 'seo';
  if (state.selected == null) state.selected = sections.length ? 0 : 'seo';

  return h(
    'div',
    { class: 'grid items-start gap-4 lg:grid-cols-[19rem_1fr]' },
    blockList(sections),
    state.selected === 'seo' ? seoEditor() : sections.length ? blockEditor(sections, state.selected) : emptyPage(),
  );
}

/** Colonne de gauche : la page, dans l'ordre où le visiteur la verra. */
function blockList(sections) {
  const editable = can('design.edit');
  return h(
    'aside',
    { class: 'space-y-2 lg:sticky lg:top-24' },
    h(
      'div',
      { class: 'flex items-baseline justify-between px-1' },
      h('h2', { class: 'text-sm font-semibold text-ink-700' }, t('design.your_page')),
      h('span', { class: 'text-xs text-ink-400' }, t('design.blocks_count', { count: sections.length })),
    ),
    h('div', { class: 'space-y-1.5' }, ...sections.map((section, index) => blockRow(section, index, sections.length, editable))),
    h(
      'button',
      {
        type: 'button',
        class: 'flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-ink-200 px-3 py-3 text-sm font-medium text-ink-500 transition hover:border-accent hover:bg-accent-50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50',
        onclick: addBlockMenu,
        disabled: !editable,
      },
      icon('plus'),
      t('design.add_section'),
    ),
    h(
      'button',
      {
        type: 'button',
        class: `flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-sm transition ${
          state.selected === 'seo' ? 'border-accent bg-accent-50 text-ink' : 'border-transparent text-ink-500 hover:bg-ink-50 hover:text-ink'
        }`,
        onclick: () => selectBlock('seo'),
      },
      icon('globe', 'size-4 shrink-0'),
      h('span', { class: 'flex-1' }, t('design.seo')),
      icon('chevronRight', 'size-4 text-ink-300'),
    ),
  );
}

/** Une ligne de la page : schéma de la mise en page, nom courant, début du contenu. */
function blockRow(section, index, total, editable) {
  const family = familyOf(section);
  const active = state.selected === index;
  const arrow = (name, delta, disabled) =>
    h(
      'button',
      {
        type: 'button',
        class: 'flex size-6 items-center justify-center rounded-md bg-white/90 text-ink-500 shadow-sm transition hover:bg-white hover:text-ink disabled:opacity-30',
        title: t(name),
        disabled: disabled || !editable,
        onclick: (e) => {
          e.stopPropagation();
          moveSection(index, delta);
        },
      },
      icon('chevronRight', `size-3.5 ${delta < 0 ? '-rotate-90' : 'rotate-90'}`),
    );

  return h(
    'div',
    { class: 'group relative' },
    h(
      'button',
      {
        type: 'button',
        class: `flex w-full items-center gap-3 rounded-xl border py-2.5 pr-9 pl-3 text-left transition ${
          active ? 'border-accent bg-accent-50 shadow-sm' : 'border-ink-100 bg-white hover:border-ink-200 hover:bg-ink-50'
        }`,
        onclick: () => selectBlock(index),
      },
      h('span', { class: 'shrink-0 overflow-hidden rounded-lg border border-ink-100 bg-white' }, wireframe(section, 'h-8 w-12')),
      h(
        'span',
        { class: 'min-w-0 flex-1' },
        h('span', { class: 'block truncate text-sm font-medium text-ink' }, family ? t(`design.family.${family.key}`) : section),
        h('span', { class: 'block truncate text-xs text-ink-400', 'data-excerpt': String(index) }, blockExcerpt(family, section)),
      ),
    ),
    h(
      'div',
      { class: `absolute top-1/2 right-1.5 -translate-y-1/2 flex-col gap-0.5 ${active ? 'flex' : 'hidden group-hover:flex'}` },
      arrow('design.move_up', -1, index === 0),
      arrow('design.move_down', 1, index === total - 1),
    ),
  );
}

const stripTags = (value) =>
  String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Premier texte réellement saisi dans le bloc : c'est ce qui permet de le reconnaître. */
function blockExcerpt(family, section) {
  const data = family ? (state.config.homepage?.[family.key] ?? {}) : {};
  const text = stripTags(data.title) || stripTags(data.text) || stripTags(data.badge);
  if (!text) return layoutLabel(section);
  return text.length > 52 ? `${text.slice(0, 52)}…` : text;
}

/** Le libellé du bloc dans la liste suit ce qu'on est en train d'écrire. */
function refreshExcerpt() {
  if (state.tab !== 'home' || typeof state.selected !== 'number') return;
  const section = state.config.homepage_sections?.[state.selected];
  const span = $(`#design-view [data-excerpt="${state.selected}"]`);
  if (section && span) span.textContent = blockExcerpt(familyOf(section), section);
}

function selectBlock(index) {
  state.selected = index;
  render();
  if (window.innerWidth < 1024) $('#design-view [data-block-editor]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Colonne de droite : tout ce qui concerne le bloc choisi, et rien d'autre. */
function blockEditor(sections, index) {
  const section = sections[index];
  const family = familyOf(section);
  const editable = can('design.edit');
  if (!family) {
    return h(
      'section',
      { class: 'card px-6 py-10 text-center text-sm text-red-600', 'data-block-editor': true },
      t('errors.design_section_unknown', { section }),
    );
  }
  const data = (state.config.homepage[family.key] ??= {});

  const header = h(
    'div',
    { class: 'flex flex-wrap items-center gap-3 border-b border-ink-100 px-5 py-4' },
    h('span', { class: 'shrink-0 overflow-hidden rounded-xl border border-ink-100 bg-white' }, wireframe(section, 'h-12 w-20')),
    h(
      'div',
      { class: 'min-w-0 flex-1' },
      h('h2', { class: 'truncate text-base font-semibold text-ink' }, t(`design.family.${family.key}`)),
      h(
        'p', { class: 'truncate text-xs text-ink-400' },
        `${t('design.block_position', { index: index + 1, total: sections.length })} · ${layoutLabel(section)}`,
      ),
    ),
    h(
      'button',
      { type: 'button', class: 'btn btn-outline px-3 py-1.5', onclick: () => chooseLayout(index), disabled: !editable },
      icon('image'),
      t('design.change_layout'),
    ),
    h(
      'button',
      { type: 'button', class: 'icon-btn hover:bg-red-50 hover:text-red-600', title: t('design.delete_block'), onclick: () => confirmRemoveSection(index), disabled: !editable },
      icon('trash'),
    ),
  );

  const groups = new Map();
  for (const key of GROUP_ORDER) {
    const fields = family.fields.filter((f) => groupOf(f) === key);
    if (fields.length) groups.set(key, fields);
  }
  const single = groups.size < 2;

  const body = h(
    'div',
    { class: 'space-y-6 px-5 py-5' },
    h('button', { type: 'button', class: 'btn btn-ghost -mt-1 px-2 py-1 text-xs lg:hidden', onclick: () => $('#design-view aside')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, icon('arrowLeft', 'size-3.5'), t('design.back_to_blocks')),
    ...[...groups].map(([key, fields]) =>
      h(
        'section',
        { class: 'space-y-3' },
        single ? null : h('h3', { class: 'text-xs font-semibold tracking-wide text-ink-400 uppercase' }, t(`design.group_${key}`)),
        h('div', { class: 'grid gap-4 sm:grid-cols-2' }, ...fields.map((f) => blockField(f, data, { bare: key === 'buttons' && fields.length === 1 }))),
      ),
    ),
  );

  return h('section', { class: 'card overflow-hidden', 'data-block-editor': true }, header, body);
}

/** Les champs sont regroupés par nature, toujours dans le même ordre de lecture. */
const GROUP_ORDER = ['content', 'image', 'buttons', 'items'];
const groupOf = (f) => (f.type === 'image' || f.key === 'image_alt' ? 'image' : f.type === 'button' ? 'buttons' : f.type === 'list' || f.type === 'strings' ? 'items' : 'content');

/** Libellé d'aide facultatif : absent du dictionnaire, il ne s'affiche pas. */
const hintOf = (key) => {
  const value = t(`design.hint.${key}`);
  return value === `design.hint.${key}` ? null : value;
};

function blockField(f, data, { bare = false } = {}) {
  const label = t(`design.field.${f.key}`);
  const hint = hintOf(f.key);
  const wide = ['textarea', 'rich', 'list', 'strings', 'button', 'image'].includes(f.type);
  const set = (value) => {
    data[f.key] = value;
    touch();
  };

  const control = (() => {
    switch (f.type) {
      case 'rich':
        return richLine(data[f.key], set);
      case 'textarea':
        // Le catalogue dit quels champs le site affiche en HTML : eux seuls peuvent être colorés.
        return f.inline ? richLine(data[f.key], set, { multiline: true }) : textArea(data[f.key], set, { rows: 4 });
      case 'image':
        return imageInput(data[f.key], set);
      case 'button':
        return buttonInput(data[f.key], set);
      case 'number':
        return textInput(data[f.key], (v) => set(Number(v) || 0));
      case 'strings':
        return listInput((data[f.key] ?? []).map((value) => ({ value })), [{ key: 'value', type: 'text' }], (rows) => set(rows.map((r) => r.value).filter(Boolean)));
      case 'list':
        return listInput(data[f.key], f.item, set);
      default:
        return f.inline ? richLine(data[f.key], set) : textInput(data[f.key], set);
    }
  })();

  // Un intitulé de groupe suffit quand il n'y a qu'un champ : on évite « Boutons › Bouton › Texte ».
  return h('div', { class: wide ? 'sm:col-span-2' : '' }, bare ? control : field(label, control, hint));
}

/**
 * Commutateur « Visuel / Texte », commun aux deux éditeurs.
 *
 * Le mode visuel montre le résultat, le mode texte montre le code : c'est le même
 * contenu vu de deux façons. Le passage de l'un à l'autre repasse par le même filtre
 * que l'enregistrement, donc ce qui est affiché est exactement ce qui sera écrit.
 */
function modeSwitch(onSwitch, initial = 'visual') {
  const buttons = new Map();
  const set = (key) => {
    for (const [name, button] of buttons) button.setAttribute('aria-pressed', String(name === key));
  };
  const btn = (key, label) => {
    const button = h(
      'button',
      {
        type: 'button',
        class: 'seg px-2 py-0.5 text-xs',
        'aria-pressed': String(initial === key),
        onmousedown: (e) => e.preventDefault(),
        onclick: () => {
          set(key);
          onSwitch(key);
        },
      },
      label,
    );
    buttons.set(key, button);
    return button;
  };
  return h(
    'div',
    { class: 'flex rounded-md bg-ink-100 p-0.5', role: 'group', 'aria-label': t('design.mode') },
    btn('visual', t('design.mode_visual')),
    btn('text', t('design.mode_text')),
  );
}

/** Le code d'un article se lit mieux avec une balise de bloc par ligne. */
const BLOCK_TAGS = 'h2|h3|p|ul|ol|li|blockquote';
const formatHtml = (html) =>
  html
    .replace(new RegExp(`<(${BLOCK_TAGS})>`, 'gi'), '\n<$1>')
    .replace(new RegExp(`</(${BLOCK_TAGS})>`, 'gi'), '</$1>\n')
    .replace(/\n{2,}/g, '\n')
    .trim();

/**
 * Champ de texte mis en forme, sans jamais montrer de balise : l'agent voit
 * « cooking » en italique ou en rouge, pas « <em> » ni « <span style=… > ».
 *
 * Trois gestes seulement — gras, italique, couleur — parce que ce sont les seuls que
 * le moteur du site sait rendre dans ces champs. Les liens déjà présents dans les
 * textes du parc sont conservés tels quels. Qui veut la main sur le code passe en
 * mode « Texte » : même contenu, même filtre, autre présentation.
 */
function richLine(html, onChange, { multiline = false } = {}) {
  const area = h('div', {
    class: `input leading-6 ${multiline ? 'min-h-24' : 'min-h-[2.4rem]'}`,
    contenteditable: 'true',
    spellcheck: 'true',
  });
  area.innerHTML = html ?? '';
  const emit = () => onChange(cleanInline(area.innerHTML));
  area.addEventListener('input', emit);
  area.addEventListener('paste', (e) => {
    // Un copier-coller venu d'un traitement de texte amène sa propre mise en forme :
    // on ne garde que le texte, la mise en forme se fait ici.
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData ?? window.clipboardData).getData('text/plain'));
  });
  area.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (multiline) document.execCommand('insertLineBreak');
  });

  // La sélection est perdue dès que le curseur va vers un bouton : on la retient.
  let saved = null;
  const remember = () => {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (area.contains(range.commonAncestorContainer)) saved = range.cloneRange();
  };
  for (const event of ['keyup', 'mouseup', 'blur']) area.addEventListener(event, remember);

  /** Sans sélection, la mise en forme s'applique à tout le champ : c'est ce qu'on attend d'un clic. */
  const restore = () => {
    if (!saved || saved.collapsed) {
      saved = document.createRange();
      saved.selectNodeContents(area);
    }
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(saved);
  };

  const run = (command, value = null) => {
    remember();
    restore();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(command, false, value);
    remember();
    emit();
  };

  const clearColors = () => {
    for (const node of [...area.querySelectorAll('span[style], font[color]')]) node.replaceWith(...node.childNodes);
    area.normalize();
    emit();
  };

  const cmd = (label, command, cls) =>
    h(
      'button',
      {
        type: 'button',
        class: `rounded-md px-2 py-0.5 text-xs text-ink-600 transition hover:bg-ink-100 ${cls}`,
        title: t(`design.rt_${command}`),
        onmousedown: (e) => e.preventDefault(),
        onclick: () => run(command),
      },
      label,
    );

  // Mode texte : le code source du champ, modifiable directement.
  const source = h('textarea', {
    class: 'input font-mono text-xs leading-5',
    rows: multiline ? '6' : '3',
    spellcheck: 'false',
    hidden: true,
  });
  source.addEventListener('input', () => onChange(cleanInline(source.value)));

  const tools = h(
    'div',
    { class: 'flex items-center gap-1' },
    cmd('B', 'bold', 'font-bold'),
    cmd('I', 'italic', 'italic'),
    colorTool({ palette: sitePalette(), onOpen: remember, onApply: (color) => run('foreColor', color), onClear: clearColors }),
    // L'aide ne s'affiche que sur le champ en cours : répétée sous chacun, elle encombre.
    h('span', { class: 'ml-1 hidden text-[11px] text-ink-400 group-focus-within:inline' }, t('design.rich_hint')),
  );
  const note = h('p', { class: 'mt-1 text-[11px] text-ink-400', hidden: true }, t('design.mode_text_hint'));

  // Le code affiché à l'entrée du mode texte sert de témoin : un aller-retour sans
  // modification ne doit pas marquer le brouillon comme modifié.
  let entered = null;
  const toMode = (mode) => {
    const asText = mode === 'text';
    if (asText) {
      source.value = cleanInline(area.innerHTML);
      entered = source.value;
    } else {
      area.innerHTML = cleanInline(source.value);
      if (source.value !== entered) emit();
    }
    area.hidden = asText;
    source.hidden = !asText;
    note.hidden = !asText;
    tools.hidden = asText;
    (asText ? source : area).focus();
  };

  return h(
    'div',
    { class: 'group' },
    h('div', { class: 'mb-1 flex items-center gap-1' }, tools, h('span', { class: 'flex-1' }), modeSwitch(toMode)),
    area,
    source,
    note,
  );
}

/** Couleurs de la charte du site, proposées avant toute autre : elles vont ensemble. */
const sitePalette = () =>
  Object.entries(state.style ?? {}).map(([name, value]) => {
    const label = t(`design.color.${name}`);
    return { name: label === `design.color.${name}` ? humanize(name) : label, value };
  });

/** Une adresse n'est gardée que si elle ne peut pas exécuter de code. */
const safeUrl = (href) => {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(String(href).trim());
  return !scheme || ['http', 'https', 'mailto', 'tel'].includes(scheme[1].toLowerCase());
};

/**
 * Ne garde que ce que le moteur du site sait rendre. Les balises sont reconstruites
 * à partir de leur seul attribut utile : rien de ce qui est collé n'est recopié tel quel.
 * Le serveur refait ce travail de son côté — celui-ci n'est là que pour l'affichage.
 */
function cleanHtml(html, { blocks = false } = {}) {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const keep = new Set(blocks ? ['H2', 'H3', 'P', 'STRONG', 'B', 'EM', 'I', 'UL', 'OL', 'LI', 'BR', 'BLOCKQUOTE'] : ['STRONG', 'B', 'EM', 'I', 'BR']);

  const walk = (node) => {
    for (const child of [...node.children]) {
      walk(child);
      const tag = child.tagName;

      if (tag === 'FONT') {
        // Certains navigateurs colorent encore avec <font color> : on normalise.
        const color = normalizeColor(child.getAttribute('color'));
        if (!color) {
          child.replaceWith(...child.childNodes);
          continue;
        }
        const span = document.createElement('span');
        span.setAttribute('style', `color:${color}`);
        span.append(...child.childNodes);
        child.replaceWith(span);
        continue;
      }
      if (tag === 'SPAN') {
        const color = normalizeColor(child.style?.color);
        for (const attr of [...child.attributes]) child.removeAttribute(attr.name);
        if (color) child.setAttribute('style', `color:${color}`);
        else child.replaceWith(...child.childNodes);
        continue;
      }
      if (tag === 'A') {
        const href = child.getAttribute('href') ?? '';
        for (const attr of [...child.attributes]) child.removeAttribute(attr.name);
        if (href && safeUrl(href)) child.setAttribute('href', href);
        else child.replaceWith(...child.childNodes);
        continue;
      }
      if (!keep.has(tag)) {
        // Un retour à la ligne collé arrive souvent sous forme de bloc : on le garde comme tel.
        if (!blocks && ['DIV', 'P'].includes(tag) && child.nextSibling) child.after(document.createElement('br'));
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attr of [...child.attributes]) child.removeAttribute(attr.name);
    }
  };

  const root = doc.body.firstElementChild;
  walk(root);
  return blocks
    ? root.innerHTML.replace(/<div>/g, '<p>').replace(/<\/div>/g, '</p>').trim()
    : root.innerHTML.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

const cleanInline = (html) => cleanHtml(html);
const clean = (html) => cleanHtml(html, { blocks: true });

/** Page vide : un seul geste possible, ajouter un bloc. */
function emptyPage() {
  return h(
    'section',
    { class: 'card flex flex-col items-center gap-3 px-6 py-16 text-center', 'data-block-editor': true },
    icon('home', 'size-10 text-ink-200'),
    h('p', { class: 'text-base font-semibold text-ink' }, t('design.empty_sections')),
    h('p', { class: 'max-w-sm text-sm text-ink-400' }, t('design.empty_hint')),
    h('button', { type: 'button', class: 'btn btn-primary', onclick: addBlockMenu, disabled: !can('design.edit') }, icon('plus'), t('design.add_section')),
  );
}

/** Le seul réglage technique de la page, isolé pour ne pas encombrer l'édition. */
function seoEditor() {
  const homepage = (state.config.homepage ??= {});
  return h(
    'section',
    { class: 'card overflow-hidden', 'data-block-editor': true },
    h(
      'div',
      { class: 'flex items-center gap-3 border-b border-ink-100 px-5 py-4' },
      h('span', { class: 'flex size-10 items-center justify-center rounded-xl bg-ink-50 text-ink-500' }, icon('globe', 'size-5')),
      h('div', {}, h('h2', { class: 'text-base font-semibold text-ink' }, t('design.seo')), h('p', { class: 'text-xs text-ink-400' }, t('design.seo_hint'))),
    ),
    h(
      'div',
      { class: 'px-5 py-5' },
      field(
        t('design.field.meta_description'),
        textArea(homepage.meta_description, (v) => {
          homepage.meta_description = v;
          touch();
        }, { rows: 3 }),
        hintOf('meta_description'),
      ),
    ),
  );
}

function moveSection(index, delta) {
  const list = state.config.homepage_sections;
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  [list[index], list[target]] = [list[target], list[index]];
  state.selected = target;
  touch();
  render();
}

const confirmRemoveSection = (index) => {
  const family = familyOf(state.config.homepage_sections[index]);
  return confirmDialog({
    title: t('design.delete_block'),
    warning: t('design.delete_block_warning', { name: family ? t(`design.family.${family.key}`) : state.config.homepage_sections[index] }),
    submitLabel: t('design.remove'),
    tone: 'btn-danger',
    iconName: 'trash',
    run: async () => {
      state.config.homepage_sections.splice(index, 1);
      state.selected = state.config.homepage_sections.length ? Math.max(0, index - 1) : 'seo';
      touch();
      render();
    },
  });
};

/** Choix de la mise en page : on compare des schémas, pas des noms de gabarits. */
function chooseLayout(index) {
  const current = state.config.homepage_sections[index];
  const family = familyOf(current);
  const available = state.site.available.sections ?? [];
  const variants = family.variants.filter((v) => available.includes(v));

  const grid = h(
    'div',
    { class: 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3' },
    ...variants.map((variant) =>
      h(
        'button',
        {
          type: 'button',
          class: `rounded-xl border p-2.5 text-left transition ${
            variant === current ? 'border-accent bg-accent-50 ring-2 ring-accent/30' : 'border-ink-100 hover:border-accent hover:bg-accent-50'
          }`,
          onclick: () => {
            state.config.homepage_sections[index] = variant;
            closeModal();
            touch();
            render();
            toast(t('design.layout_changed', { name: layoutLabel(variant) }));
          },
        },
        h('span', { class: 'mb-2 block overflow-hidden rounded-lg border border-ink-100 bg-white' }, wireframe(variant, 'h-24 w-full')),
        h('span', { class: 'block text-sm font-medium text-ink' }, layoutLabel(variant)),
        variant === current ? h('span', { class: 'badge mt-1 bg-accent-100 text-accent-700' }, icon('check', 'size-3'), t('design.current')) : null,
      ),
    ),
  );

  openModal(
    h(
      'div',
      {},
      modalHeader(t('design.choose_layout'), 'bg-accent-50 text-accent-700', 'image'),
      h('p', { class: 'mb-3 text-sm text-ink-500' }, t('design.choose_layout_hint', { family: t(`design.family.${family.key}`) })),
      grid,
    ),
    'max-w-4xl',
  );
}

/** Ajout d'un bloc : chaque famille est présentée par son rôle, pas par son nom technique. */
function addBlockMenu() {
  const available = state.site.available.sections ?? [];
  const cards = state.catalog.families.map((family) => {
    const variants = family.variants.filter((v) => available.includes(v));
    return h(
      'button',
      {
        type: 'button',
        class: 'flex gap-3 rounded-xl border border-ink-100 p-3 text-left transition hover:border-accent hover:bg-accent-50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-ink-100 disabled:hover:bg-white',
        disabled: !variants.length,
        onclick: () => {
          state.config.homepage_sections.push(variants[0]);
          closeModal();
          touch();
          selectBlock(state.config.homepage_sections.length - 1);
          toast(t('design.block_added', { name: t(`design.family.${family.key}`) }));
        },
      },
      h('span', { class: 'shrink-0 overflow-hidden rounded-lg border border-ink-100 bg-white' }, wireframe(variants[0] ?? family.variants[0], 'h-14 w-20')),
      h(
        'span',
        { class: 'min-w-0' },
        h('span', { class: 'block text-sm font-semibold text-ink' }, t(`design.family.${family.key}`)),
        h('span', { class: 'block text-xs text-ink-400' }, t(`design.purpose.${family.key}`)),
      ),
    );
  });

  openModal(
    h(
      'div',
      {},
      modalHeader(t('design.add_section'), 'bg-accent-50 text-accent-700', 'plus'),
      h('p', { class: 'mb-3 text-sm text-ink-500' }, t('design.add_block_hint')),
      h('div', { class: 'grid gap-2 sm:grid-cols-2' }, ...cards),
    ),
    'max-w-3xl',
  );
}

// ───────────────────────── Onglet « Couleurs » ─────────────────────────

function themeTab() {
  const entries = Object.entries(state.style);
  const demo = h('div', { class: 'card overflow-hidden' });
  const paintDemo = () => {
    const s = state.style;
    demo.replaceChildren(
      h(
        'div',
        { class: 'p-6', style: null },
        h('div', { class: 'rounded-xl p-6', 'data-demo': true }),
      ),
    );
    const box = demo.querySelector('[data-demo]');
    box.style.background = s.background ?? '#fff';
    box.style.color = s.text ?? '#000';
    const title = h('p', { class: 'text-lg font-bold' }, state.config.site_name ?? state.domain);
    const text = h('p', { class: 'mt-1 text-sm' }, state.config.site_tagline ?? '');
    text.style.color = s['text-light'] ?? '#666';
    const button = h('span', { class: 'mt-4 inline-block rounded-lg px-4 py-2 text-sm font-semibold' }, t('design.preview'));
    button.style.background = s.primary ?? '#000';
    button.style.color = s.surface ?? '#fff';
    const card = h('div', { class: 'mt-4 rounded-lg p-3 text-sm' }, t('design.tab_theme'));
    card.style.background = s.surface ?? '#fff';
    card.style.border = `1px solid ${s['primary-light'] ?? '#eee'}`;
    box.append(title, text, button, card);
  };
  paintDemo();

  return h(
    'div',
    { class: 'grid gap-4 lg:grid-cols-2' },
    h(
      'section',
      { class: 'card space-y-3 px-4 py-4' },
      h('h2', { class: 'text-sm font-semibold text-ink-600' }, t('design.tab_theme')),
      ...entries.map(([name, value]) =>
        field(
          t(`design.color.${name}`) === `design.color.${name}` ? humanize(name) : t(`design.color.${name}`),
          colorInput(value, (v) => {
            state.style[name] = v;
            touch();
            paintDemo();
          }),
        ),
      ),
    ),
    h('div', { class: 'space-y-3' }, h('h2', { class: 'text-sm font-semibold text-ink-600' }, t('design.preview')), demo),
  );
}

// ───────────────────────── Onglet « Identité » ─────────────────────────

function identityTab() {
  const c = state.config;
  const set = (key) => (v) => {
    c[key] = v;
    touch();
  };
  const presets = state.catalog.presets;
  const group = (title, ...children) => h('section', { class: 'card space-y-3 px-4 py-4' }, h('h2', { class: 'text-sm font-semibold text-ink-600' }, title), ...children);

  return h(
    'div',
    { class: 'grid gap-4 lg:grid-cols-2' },
    group(
      t('design.tab_identity'),
      field(t('design.identity_name'), textInput(c.site_name, set('site_name'))),
      field(t('design.identity_tagline'), textInput(c.site_tagline, set('site_tagline'))),
      field(t('design.identity_icon'), textInput(c.site_icon, set('site_icon'), { mono: true })),
      field(t('design.identity_lang'), selectInput(state.catalog.langs, c.site_lang, set('site_lang'), (v) => v)),
    ),
    group(
      t('design.header_nav'),
      field(t('design.header_nav'), selectInput(presets.header_nav, c.header_nav, set('header_nav'))),
      field(t('design.header_logo'), selectInput(presets.header_logo, c.header_logo, set('header_logo'))),
      field(t('design.header_cta'), selectInput(presets.header_cta, c.header_cta, (v) => { c.header_cta = v; touch(); render(); })),
      c.header_cta && c.header_cta !== 'none' ? field(t('design.header_cta_text'), textInput(c.header_cta_text, set('header_cta_text'))) : null,
      c.header_cta && c.header_cta !== 'none' ? field(t('design.header_cta_url'), textInput(c.header_cta_url, set('header_cta_url'))) : null,
    ),
    group(
      t('design.footer_style'),
      field(t('design.footer_style'), selectInput(presets.footer_style, c.footer_style, set('footer_style'))),
      h(
        'label',
        { class: 'flex items-center gap-2 text-sm' },
        checkbox(c.footer_show?.navigation, (v) => { c.footer_show = { ...c.footer_show, navigation: v }; touch(); }),
        t('design.footer_navigation'),
      ),
      h(
        'label',
        { class: 'flex items-center gap-2 text-sm' },
        checkbox(c.footer_show?.social, (v) => { c.footer_show = { ...c.footer_show, social: v }; touch(); }),
        t('design.footer_social'),
      ),
    ),
    group(
      t('design.category_style'),
      field(t('design.category_style'), selectInput(presets.category_style, c.category_style, set('category_style'))),
      field(t('design.article_style'), selectInput(presets.article_style, c.article_style, set('article_style'))),
    ),
  );
}

function checkbox(value, onChange) {
  const box = h('input', { type: 'checkbox', class: 'size-4 rounded border-ink-300 accent-accent', checked: Boolean(value) });
  box.addEventListener('change', () => onChange(box.checked));
  return box;
}

// ───────────────────────── Onglet « Articles » ─────────────────────────

/** Nom lisible d'une rubrique, tel qu'il est défini dans la configuration du site. */
const categoryName = (slug) => state.config?.categories?.[slug]?.name || humanize(slug);

/** Redessine la liste sans reconstruire la page : la frappe dans la recherche n'est pas interrompue. */
let repaintArticles = () => {};

/**
 * Liste des articles du domaine : compteurs par rubrique, recherche, et filtre.
 *
 * La liste et les compteurs se redessinent seuls quand un filtre change ou quand un
 * paquet de titres arrive du serveur ; les champs de recherche, eux, ne sont jamais
 * recréés — sinon le curseur sauterait à chaque lettre saisie.
 */
function articlesTab() {
  if (!state.articles.length && !state.articlesLoading) loadArticles();

  const stats = h('div', { class: 'flex flex-wrap items-center gap-1.5' });
  const rows = h('div', { class: 'max-h-[58vh] divide-y divide-ink-100 overflow-y-auto' });
  const count = h('p', { class: 'text-xs text-ink-400' });

  const matches = (a) => {
    if (state.articleCategory && a.category !== state.articleCategory) return false;
    const query = state.articleFilter.trim().toLowerCase();
    if (!query) return true;
    const title = String(state.metas.get(a.file)?.title ?? '').toLowerCase();
    return title.includes(query) || a.file.toLowerCase().includes(query);
  };

  const chip = (label, total, slug) =>
    h(
      'button',
      {
        type: 'button',
        class: `badge transition ${state.articleCategory === slug ? 'bg-accent-100 text-accent-700' : 'bg-ink-50 text-ink-600 hover:bg-ink-100'}`,
        'aria-pressed': String(state.articleCategory === slug),
        onclick: () => {
          state.articleCategory = state.articleCategory === slug ? '' : slug;
          paint();
        },
      },
      label,
      h('span', { class: 'font-semibold' }, String(total)),
    );

  function paint() {
    const byCategory = new Map();
    for (const a of state.articles) byCategory.set(a.category || '', (byCategory.get(a.category || '') ?? 0) + 1);

    const loaded = state.articles.filter((a) => state.metas.has(a.file)).length;
    // replaceChildren écrirait « null » : les enfants absents sont retirés avant.
    stats.replaceChildren(
      ...[
        chip(t('design.all_categories'), state.articles.length, ''),
      ...[...byCategory.entries()]
        .filter(([slug]) => slug)
        .sort((a, b) => b[1] - a[1])
        .map(([slug, total]) => chip(categoryName(slug), total, slug)),
      // Les titres arrivent par paquets : tant qu'ils ne sont pas tous là, on le dit.
        // Si le chargement s'est interrompu (coupure SSH par exemple), l'indicateur
        // devient un bouton : on reprend là où on s'était arrêté, sans tout refaire.
        loaded < state.articles.length
          ? state.metasStalled
            ? h(
                'button',
                { type: 'button', class: 'text-[11px] text-ink-500 underline decoration-dotted underline-offset-2 hover:text-ink', onclick: () => loadTitles() },
                t('design.titles_resume', { done: loaded, total: state.articles.length }),
              )
            : h('span', { class: 'text-[11px] text-ink-400' }, t('design.titles_loading', { done: loaded, total: state.articles.length }))
          : null,
      ].filter(Boolean),
    );

    const list = state.articles.filter(matches);
    count.textContent = list.length === state.articles.length
      ? t('design.articles_count', { count: state.articles.length })
      : t('design.articles_filtered', { count: list.length, total: state.articles.length });

    rows.replaceChildren(
      ...[...(list.length
        ? list.slice(0, 400).map((a) =>
            h(
              'button',
              {
                type: 'button',
                class: `flex w-full flex-col gap-0.5 px-4 py-2.5 text-left transition hover:bg-accent-50/50 ${state.article?.file === a.file ? 'bg-accent-50' : ''}`,
                onclick: () => openArticle(a.file),
              },
              h(
                'span',
                { class: 'flex items-baseline gap-2' },
                h('span', { class: 'min-w-0 flex-1 truncate text-sm font-medium' }, state.metas.get(a.file)?.title ?? a.file.split('/').pop().replace(/\.php$/, '')),
                a.category ? h('span', { class: 'shrink-0 text-[11px] text-ink-400' }, categoryName(a.category)) : null,
              ),
              h('span', { class: 'truncate font-mono text-[11px] text-ink-400' }, a.file),
            ),
          )
        : [
            h(
              'div',
              { class: 'px-4 py-10 text-center' },
              h('p', { class: 'text-sm text-ink-400' }, state.articles.length ? t('design.articles_no_match') : t('design.articles_none')),
              state.articles.length
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'btn btn-ghost mt-2 px-3 py-1',
                      onclick: () => {
                        state.articleFilter = '';
                        state.articleCategory = '';
                        search.value = '';
                        paint();
                      },
                    },
                    t('design.articles_reset'),
                  )
                : null,
            ),
          ])].filter(Boolean),
    );
  }

  const search = textInput(state.articleFilter, (v) => {
    state.articleFilter = v;
    paint();
  }, { placeholder: t('design.article_search') });

  repaintArticles = paint;
  paint();

  const picker = h(
    'section',
    { class: 'card overflow-hidden' },
    h('div', { class: 'space-y-2 border-b border-ink-100 px-4 py-3' }, stats, search, count),
    rows,
  );

  return h(
    'div',
    { class: 'grid gap-4 lg:grid-cols-[minmax(300px,1fr)_2fr]' },
    picker,
    state.article ? articleEditor() : h('div', { class: 'card px-6 py-16 text-center text-sm text-ink-400' }, t('design.articles_pick')),
  );
}

/**
 * Charge la liste, puis les titres par paquets de soixante.
 * La liste s'affiche dès qu'elle est connue ; les titres, qui demandent d'ouvrir
 * chaque article sur le serveur, arrivent ensuite sans bloquer l'écran.
 */
async function loadArticles() {
  if (state.articlesLoading) return;
  state.articlesLoading = true;
  const domain = state.domain;
  try {
    const { articles } = await api(`${base()}/articles`);
    if (state.domain !== domain) return;
    state.articles = articles;
    render();
    loadTitles();
  } catch (err) {
    toastError(err);
  } finally {
    if (state.domain === domain) state.articlesLoading = false;
  }
}

/**
 * Titres manquants, par paquets de soixante.
 *
 * Connaître un titre demande d'ouvrir l'article sur le serveur : c'est un confort de
 * recherche, pas le cœur de l'onglet. Un incident — une session SSH qui tombe, par
 * exemple — arrête donc la série sans message d'erreur : la liste reste utilisable, et
 * l'indicateur propose de reprendre.
 */
async function loadTitles() {
  if (state.titlesLoading) return;
  state.titlesLoading = true;
  state.metasStalled = false;
  const domain = state.domain;
  try {
    const restants = state.articles.filter((a) => !state.metas.has(a.file));
    for (let i = 0; i < restants.length; i += 60) {
      const files = restants.slice(i, i + 60).map((a) => a.file);
      const { metas } = await api(`${base()}/articles/metas`, { method: 'POST', body: { files } });
      // Le domaine a pu changer entre deux paquets : on ne mélange jamais deux sites.
      if (state.domain !== domain) return;
      for (const m of metas) if (m.meta) state.metas.set(m.file, m.meta);
      repaintArticles();
    }
  } catch {
    state.metasStalled = true;
    repaintArticles();
  } finally {
    if (state.domain === domain) state.titlesLoading = false;
  }
}

async function openArticle(file) {
  try {
    const article = await api(`${base()}/article?path=${enc(file)}`);
    state.article = {
      file,
      meta: clone(article.draft?.meta ?? article.meta),
      content: article.draft?.content ?? article.content,
      hasDraft: Boolean(article.draft),
      dirty: false,
    };
    render();
  } catch (err) {
    toastError(err);
  }
}

function articleEditor() {
  const a = state.article;
  const set = (key) => (v) => {
    a.meta[key] = v;
    a.dirty = true;
    renderArticleBar();
  };

  const editor = richEditor(a.content, (html) => {
    a.content = html;
    a.dirty = true;
    renderArticleBar();
  });

  return h(
    'section',
    { class: 'card space-y-4 px-4 py-4' },
    h('div', { class: 'flex flex-wrap items-center gap-2', 'data-article-bar': true }, ...articleBarChildren()),
    h(
      'div',
      { class: 'grid gap-3 sm:grid-cols-2' },
      field(t('design.article_title'), textInput(a.meta.title, set('title'))),
      field(t('design.article_author'), textInput(a.meta.author_name, set('author_name'))),
      field(t('design.article_date'), textInput(a.meta.date, set('date'))),
      field(t('design.article_read_time'), textInput(a.meta.read_time, set('read_time'))),
    ),
    field(t('design.article_intro'), textArea(a.meta.intro, set('intro'), { rows: 3 })),
    field(t('design.article_image'), imageInput(a.meta.image, set('image'))),
    h('div', {}, h('span', { class: 'label' }, t('design.article_content')), editor),
  );
}

function articleBarChildren() {
  const a = state.article;
  const chip = a.dirty || a.hasDraft ? h('span', { class: 'badge bg-amber-100 text-amber-800' }, t('design.draft_pending')) : h('span', { class: 'badge bg-ink-100 text-ink-600' }, t('design.no_draft'));
  return [
    h('span', { class: 'min-w-0 flex-1 truncate font-mono text-xs text-ink-400' }, a.file),
    chip,
    h('button', { type: 'button', class: 'btn btn-outline px-3 py-1.5', disabled: !can('design.edit') || !a.dirty, onclick: saveArticleDraft }, icon('save'), t('design.save_draft')),
    h('button', { type: 'button', class: 'btn btn-dark px-3 py-1.5', disabled: !can('design.edit'), onclick: () => previewSite(a.file) }, icon('eye'), t('design.article_preview')),
    h('button', { type: 'button', class: 'btn btn-primary px-3 py-1.5', disabled: !can('design.publish') || (!a.hasDraft && !a.dirty), onclick: confirmPublishArticle }, icon('upload'), t('design.publish')),
  ];
}

function renderArticleBar() {
  const bar = $('#design-view [data-article-bar]');
  if (bar) bar.replaceChildren(...articleBarChildren());
}

/** Éditeur de texte simple : mise en forme par boutons, sans balises visibles. */
/**
 * Le même outil de couleur, posé sur le corps d'un article.
 * Différence avec un champ court : un article est long, on ne colore donc que ce qui
 * est sélectionné — colorer tout le texte par mégarde ne se rattrape pas facilement.
 */
function articleColorTool(area, onChange) {
  let saved = null;
  const remember = () => {
    const selection = document.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (area.contains(range.commonAncestorContainer) && !range.collapsed) saved = range.cloneRange();
  };
  for (const event of ['keyup', 'mouseup', 'blur']) area.addEventListener(event, remember);

  const apply = (color) => {
    remember();
    if (!saved) return toast(t('design.color_select_first'), 'info');
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(saved);
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, color);
    remember();
    onChange(clean(area.innerHTML));
  };

  return colorTool({
    palette: sitePalette(),
    onOpen: remember,
    onApply: apply,
    onClear: () => {
      for (const node of [...area.querySelectorAll('span[style], font[color]')]) node.replaceWith(...node.childNodes);
      area.normalize();
      onChange(clean(area.innerHTML));
    },
  });
}

function richEditor(html, onChange) {
  const area = h('div', {
    class: 'min-h-64 max-h-[50vh] space-y-3 overflow-y-auto rounded-xl border border-ink-200 bg-white p-4 text-sm leading-6 focus:border-accent focus:outline-none',
    contenteditable: 'true',
    spellcheck: 'true',
  });
  area.innerHTML = html ?? '';
  area.addEventListener('input', () => onChange(clean(area.innerHTML)));

  const cmd = (label, action) =>
    h(
      'button',
      {
        type: 'button',
        class: 'rounded-md px-2 py-1 text-xs font-medium text-ink-600 transition hover:bg-ink-100',
        onmousedown: (e) => e.preventDefault(),
        onclick: () => {
          action();
          area.focus();
          onChange(clean(area.innerHTML));
        },
      },
      label,
    );

  // Mode texte : le code de l'article, une balise de bloc par ligne.
  const source = h('textarea', {
    class: 'input max-h-[50vh] min-h-64 font-mono text-xs leading-5',
    rows: '18',
    spellcheck: 'false',
    hidden: true,
  });
  source.addEventListener('input', () => onChange(clean(source.value)));

  let entered = null;
  const toMode = (mode) => {
    const asText = mode === 'text';
    if (asText) {
      source.value = formatHtml(clean(area.innerHTML));
      entered = source.value;
    } else {
      area.innerHTML = clean(source.value);
      // Regarder le code sans y toucher ne doit pas marquer l'article comme modifié.
      if (source.value !== entered) onChange(clean(area.innerHTML));
    }
    area.hidden = asText;
    source.hidden = !asText;
    tools.hidden = asText;
    note.hidden = !asText;
    (asText ? source : area).focus();
  };

  const note = h('p', { class: 'mt-1 text-[11px] text-ink-400', hidden: true }, t('design.mode_text_hint'));

  const tools = h(
    'div',
    { class: 'flex flex-wrap items-center gap-1' },
    cmd(t('design.rt_h2'), () => document.execCommand('formatBlock', false, 'h2')),
    cmd(t('design.rt_p'), () => document.execCommand('formatBlock', false, 'p')),
    cmd(t('design.rt_bold'), () => document.execCommand('bold')),
    cmd(t('design.rt_italic'), () => document.execCommand('italic')),
    articleColorTool(area, onChange),
    cmd(t('design.rt_link'), () => {
      const url = prompt(t('design.btn_url'));
      if (url) document.execCommand('createLink', false, url);
    }),
    h('span', { class: 'ml-1 text-[11px] text-ink-400' }, t('design.rt_hint')),
  );

  const toolbar = h(
    'div',
    { class: 'mb-2 flex flex-wrap items-center gap-1 rounded-lg bg-ink-50 px-2 py-1' },
    tools,
    h('span', { class: 'flex-1' }),
    modeSwitch(toMode),
  );

  return h('div', {}, toolbar, area, source, note);
}


// ───────────────────────── Onglet « Sauvegardes » ─────────────────────────

function backupsTab() {
  if (!state.backups.length) loadBackups();
  return h(
    'section',
    { class: 'card overflow-hidden' },
    h('h2', { class: 'border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-600' }, t('design.backups_title')),
    state.backups.length
      ? h(
          'div',
          { class: 'divide-y divide-ink-100' },
          ...state.backups.map((b) =>
            h(
              'div',
              { class: 'flex flex-wrap items-center gap-3 px-4 py-2.5' },
              h('span', { class: 'flex-1 font-mono text-xs' }, b.name),
              h('span', { class: 'text-xs text-ink-400' }, fmtDate(b.mtime)),
              h('button', { type: 'button', class: 'btn btn-outline px-3 py-1', disabled: !can('design.publish'), onclick: () => confirmRestore(b) }, t('design.restore')),
            ),
          ),
        )
      : h('p', { class: 'px-4 py-10 text-center text-sm text-ink-400' }, t('design.backups_empty')),
  );
}

async function loadBackups() {
  try {
    const { backups } = await api(`${base()}/backups`);
    state.backups = backups;
    render();
  } catch (err) {
    toastError(err);
  }
}

// ───────────────────────── Actions ─────────────────────────

async function saveDraft({ silent = false } = {}) {
  clearTimeout(state.saveTimer);
  if (!state.dirty && silent) return;
  state.saving = true;
  renderToolbar();
  try {
    await api(`${base()}/draft`, { method: 'PUT', body: { config: state.config, style: state.style } });
    state.dirty = false;
    state.hasDraft = true;
    state.savedAt = new Date();
    if (!silent) toast(t('design.draft_saved'));
  } catch (err) {
    toastError(err);
  } finally {
    state.saving = false;
    renderToolbar();
  }
}

/**
 * Prévisualisation affichée DANS l'application.
 *
 * Elle ouvrait auparavant un onglet après deux appels réseau : le navigateur ne
 * rattachait plus l'ouverture au clic et la bloquait sans rien dire. Le résultat
 * s'affiche donc ici, avec un lien pour l'ouvrir dans un onglet si on le souhaite.
 */
async function previewSite(articleFile = null) {
  const buttons = [...document.querySelectorAll('#design-view button')].filter((b) => b.textContent.includes(t('design.preview')));
  for (const b of buttons) b.disabled = true;
  try {
    if (state.dirty) await saveDraft();
    if (articleFile && state.article?.dirty) await saveArticleDraft();
    const res = await api(`${base()}/preview`, { method: 'POST', body: articleFile ? { article: articleFile } : {} });
    openPreviewModal(res.url, res.expiresInMinutes);
  } catch (err) {
    toastError(err);
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

function openPreviewModal(url, minutes = 20) {
  const frame = h('iframe', {
    src: url,
    class: 'h-[68vh] w-full rounded-xl border border-ink-100 bg-white transition-all',
    title: t('design.preview'),
  });
  const holder = h('div', { class: 'flex justify-center' }, frame);

  const widthBtn = (label, width) =>
    h(
      'button',
      {
        type: 'button',
        class: 'seg',
        'aria-pressed': String(width === null),
        onclick: (e) => {
          frame.style.maxWidth = width ? `${width}px` : '';
          for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget));
        },
      },
      label,
    );

  openModal(
    h(
      'div',
      {},
      h(
        'div',
        { class: 'mb-3 flex flex-wrap items-center gap-2' },
        h('span', { class: 'flex size-9 items-center justify-center rounded-xl bg-accent-50 text-accent-700' }, icon('eye', 'size-5')),
        h('h2', { class: 'flex-1 text-lg font-semibold' }, t('design.preview')),
        h('div', { class: 'flex rounded-lg bg-ink-50 p-1' }, widthBtn(t('design.preview_desktop'), null), widthBtn(t('design.preview_mobile'), 390)),
        h('a', { href: url, target: '_blank', rel: 'noopener', class: 'btn btn-outline px-3 py-1.5' }, icon('upload'), t('design.preview_open')),
        h('button', { type: 'button', class: 'btn btn-ghost px-3 py-1.5', onclick: closeModal }, t('action.close')),
      ),
      holder,
      h('p', { class: 'mt-2 text-xs text-ink-400' }, t('design.preview_note', { minutes })),
    ),
    'max-w-6xl',
  );
}

async function saveArticleDraft() {
  const a = state.article;
  try {
    await api(`${base()}/article/draft`, { method: 'PUT', body: { path: a.file, meta: a.meta, content: a.content } });
    a.dirty = false;
    a.hasDraft = true;
    toast(t('design.draft_saved'));
    renderArticleBar();
  } catch (err) {
    toastError(err);
  }
}

function confirmDialog({ title, warning, submitLabel, tone = 'btn-primary', iconName = 'alert', run }) {
  const error = h('div', { class: 'mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', hidden: true, role: 'alert' });
  const submit = h('button', { type: 'submit', class: `btn ${tone}` }, submitLabel);
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        submit.textContent = t('action.working');
        try {
          await run();
          closeModal();
        } catch (err) {
          formError(err, error);
          submit.disabled = false;
          submit.textContent = submitLabel;
        }
      },
    },
    modalHeader(title, tone === 'btn-danger' ? 'bg-red-50 text-red-600' : 'bg-accent-50 text-accent-700', iconName),
    h('p', { class: 'rounded-lg bg-ink-50 px-3 py-2 text-sm text-ink-600' }, warning),
    error,
    h('div', { class: 'mt-6 flex justify-end gap-2' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: closeModal }, t('action.cancel')), submit),
  );
  openModal(form);
}

const confirmPublish = () =>
  confirmDialog({
    title: t('design.publish_title'),
    warning: t('design.publish_warning', { domain: state.domain }),
    submitLabel: t('design.publish'),
    iconName: 'upload',
    run: async () => {
      if (state.dirty) await saveDraft();
      const res = await api(`${base()}/publish`, { method: 'POST' });
      toast(t('design.publish_ok', { stamp: res.stamp }), 'success', `${t('design.publish_cache')}\nhttps://${state.domain}/?lkm=${Date.now()}`);
      await load();
    },
  });

const confirmPublishArticle = () =>
  confirmDialog({
    title: t('design.publish_title'),
    warning: t('design.publish_warning', { domain: state.domain }),
    submitLabel: t('design.publish'),
    iconName: 'upload',
    run: async () => {
      if (state.article.dirty) await saveArticleDraft();
      const res = await api(`${base()}/article/publish`, { method: 'POST', body: { path: state.article.file } });
      toast(t('design.article_published', { stamp: res.stamp }));
      await openArticle(state.article.file);
    },
  });

const confirmDiscard = () =>
  confirmDialog({
    title: t('design.discard_title'),
    warning: t('design.discard_warning'),
    submitLabel: t('design.discard'),
    tone: 'btn-danger',
    iconName: 'trash',
    run: async () => {
      await api(`${base()}/draft`, { method: 'DELETE' });
      toast(t('design.draft_discarded'), 'info');
      await load();
    },
  });

const confirmRestore = (backup) =>
  confirmDialog({
    title: t('design.restore_title'),
    warning: t('design.restore_warning', { name: backup.name }),
    submitLabel: t('design.restore'),
    iconName: 'refresh',
    run: async () => {
      await api(`${base()}/backups/restore`, { method: 'POST', body: { name: backup.name } });
      toast(t('design.restored', { name: backup.name }));
      state.backups = [];
      await load();
    },
  });
