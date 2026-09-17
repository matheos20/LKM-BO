// i18n côté navigateur : mêmes fichiers JSON que le serveur (servis par /api/i18n/:lang).
const STORE = 'lkm.lang';
let lang = 'fr';
let dict = {};
let languages = [];
const listeners = new Set();

export const getLang = () => lang;
export const getLanguages = () => languages;
export const onLangChange = (fn) => listeners.add(fn);

const lookup = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);

export function t(key, vars = {}) {
  const s = lookup(dict, key);
  if (typeof s !== 'string') return key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export async function initI18n() {
  const meta = await fetch('/api/i18n').then((r) => r.json());
  languages = meta.languages;
  let saved = null;
  try {
    saved = localStorage.getItem(STORE);
  } catch {}
  const pick = languages.some((l) => l.code === saved) ? saved : meta.detected || meta.default;
  await setLang(pick, { silent: true });
}

export async function setLang(code, { silent = false } = {}) {
  const res = await fetch(`/api/i18n/${encodeURIComponent(code)}`);
  if (!res.ok) return;
  dict = await res.json();
  lang = code;
  try {
    localStorage.setItem(STORE, code);
  } catch {}
  document.documentElement.lang = code;
  applyI18n(document);
  if (!silent) listeners.forEach((fn) => fn(code));
}

/** Traduit les éléments marqués data-i18n, data-i18n-placeholder, data-i18n-title, data-i18n-aria-label. */
export function applyI18n(root) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    root.querySelectorAll(`[data-i18n-${attr}]`).forEach((el) => el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`))));
  }
  document.title = t('app.title');
}
