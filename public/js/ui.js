import { getLang, t } from './i18n.js';

/** Briques d'interface communes au tableau de bord et au gestionnaire de fichiers. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const enc = encodeURIComponent;

/** Construction DOM sûre : tout texte passe par des nœuds texte (aucune injection HTML possible). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export const ICONS = {
  eye: ['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'],
  lock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  unlock: ['M6 11h12v9H6z', 'M8 11V8a4 4 0 0 1 7.5-2'],
  wrench: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4Z'],
  trash: ['M4 7h16', 'M10 11v6M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  disk: ['M4 6h16v12H4z', 'M8 14h.01M12 14h4'],
  alert: ['M12 3 2 20h20L12 3Z', 'M12 10v4M12 17h.01'],
  check: ['M5 12l5 5L20 7'],
  plug: ['M9 2v6M15 2v6', 'M6 8h12v3a6 6 0 0 1-12 0V8Z', 'M12 17v5'],
  globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'],
  folder: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z'],
  folderPlus: ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z', 'M12 11v6M9 14h6'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z', 'M14 3v5h5'],
  code: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z', 'M14 3v5h5', 'm10 12-2 2 2 2M14 12l2 2-2 2'],
  image: ['M4 5h16v14H4z', 'M8 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z', 'm5 17 5-5 4 4 2-2 3 3'],
  archive: ['M3 5h18v4H3z', 'M5 9v10h14V9', 'M11 12h2M11 15h2'],
  download: ['M12 3v12', 'm7 11 5 5 5-5', 'M4 20h16'],
  upload: ['M12 16V4', 'm7 9 5-5 5 5', 'M4 20h16'],
  pencil: ['M4 20h4l11-11a2.5 2.5 0 0 0-3.5-3.5L4 16v4Z'],
  compress: ['M4 5h16v4H4z', 'M6 9v10h12V9', 'M12 11v5', 'm9.5 13.5 2.5-2.5 2.5 2.5'],
  expand: ['M4 5h16v4H4z', 'M6 9v10h12V9', 'M12 16v-5', 'm9.5 13.5 2.5 2.5 2.5-2.5'],
  home: ['m3 11 9-8 9 8', 'M5 10v10h14V10'],
  chevronRight: ['m9 6 6 6-6 6'],
  arrowLeft: ['M19 12H5', 'm11 6-6 6 6 6'],
  arrowRight: ['M5 12h14', 'm13 6 6 6-6 6'],
  arrowUp: ['M12 19V5', 'm6 11 6-6 6 6'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6'],
  save: ['M5 5h11l3 3v11H5z', 'M8 5v5h7V5M8 19v-6h8v6'],
  plus: ['M12 5v14M5 12h14'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M4 20a8 8 0 0 1 16 0'],
  shield: ['M12 3l8 3v6c0 4.5-3.2 7.9-8 9-4.8-1.1-8-4.5-8-9V6l8-3Z', 'm9 12 2 2 4-4'],
  palette: ['M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.6-1.4-.3-.4-.4-.8-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7Z', 'M7.5 11.5h.01M10.5 8h.01M14.5 8h.01'],
};

export function icon(name, cls = 'size-4') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const attrs = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: cls };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
  for (const d of ICONS[name] ?? ICONS.file) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

export const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

// ───────────────────────── Formatage ─────────────────────────
export const fmtNum = (n) => new Intl.NumberFormat(getLang()).format(n);
export const fmtDate = (ms) => (ms ? new Intl.DateTimeFormat(getLang(), { dateStyle: 'medium', timeStyle: 'short' }).format(ms) : t('details.none'));

export function fmtSize(bytes) {
  if (bytes == null) return t('details.none');
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${new Intl.NumberFormat(getLang(), { maximumFractionDigits: i ? 1 : 0 }).format(v)} ${units[i]}`;
}

// ───────────────────────── Notifications ─────────────────────────
export function toast(message, type = 'success', detail) {
  const border = { success: 'border-accent', error: 'border-red-500', info: 'border-ink-300' }[type];
  const tint = { success: 'size-5 shrink-0 text-accent-700', error: 'size-5 shrink-0 text-red-600', info: 'size-5 shrink-0 text-ink-500' }[type];
  const el = h(
    'div',
    { class: `pointer-events-auto flex gap-3 rounded-xl border-l-4 bg-white px-4 py-3 shadow-lg ring-1 ring-ink-100 ${border}`, role: type === 'error' ? 'alert' : 'status' },
    icon(type === 'error' ? 'alert' : 'check', tint),
    h(
      'div',
      { class: 'min-w-0 flex-1 text-sm' },
      h('p', { class: 'font-medium text-ink' }, message),
      detail ? h('pre', { class: 'mt-1 max-h-32 overflow-auto font-mono text-xs whitespace-pre-wrap text-ink-500' }, detail) : null,
    ),
  );
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 9000 : 5000);
}

export const toastError = (err) => toast(err.message, 'error', err.detail);

// ───────────────────────── Modale générique ─────────────────────────
export function openModal(content, width = 'max-w-md') {
  const panel = $('#modal-panel');
  panel.className = `relative w-full ${width} rounded-2xl bg-white p-6 shadow-2xl`;
  panel.replaceChildren(content);
  $('#modal').hidden = false;
  setTimeout(() => $('#modal-panel input, #modal-panel textarea')?.focus(), 30);
}

export function closeModal() {
  $('#modal').hidden = true;
  $('#modal-panel').replaceChildren();
}

export const modalHeader = (title, tone = 'bg-accent-50 text-accent-700', iconName = 'globe') =>
  h(
    'div',
    { class: 'mb-5 flex items-center gap-3' },
    h('span', { class: `flex size-10 items-center justify-center rounded-xl ${tone}` }, icon(iconName, 'size-5')),
    h('h2', { class: 'text-lg font-semibold' }, title),
  );

/**
 * En-tête d'une étape : son numéro, son titre, et ce qu'elle attend.
 *
 * Un agent doit pouvoir dire où il en est sans lire une phrase : le numéro le situe,
 * le titre lui dit quoi faire, la note grise lui dit ce qui se passera ensuite.
 */
export const stepTitle = (n, title, hint) =>
  h(
    'div',
    { class: 'flex flex-wrap items-baseline gap-x-3 gap-y-1' },
    h('span', { class: 'flex size-7 shrink-0 items-center justify-center self-center rounded-full bg-ink text-xs font-bold text-white' }, String(n)),
    h('h2', { class: 'text-base font-semibold' }, title),
    hint ? h('p', { class: 'text-sm text-ink-400' }, hint) : null,
  );

export function formError(err, box) {
  box.replaceChildren(err.message, err.detail ? h('pre', { class: 'mt-2 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap' }, err.detail) : '');
  box.hidden = false;
}
