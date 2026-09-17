/**
 * Choix d'une couleur de texte.
 *
 * Deux exigences guident cette pièce : l'agent doit voir le résultat au moment où il
 * choisit la couleur, et il ne doit jamais avoir à taper un code s'il n'en a pas envie.
 * D'où l'ordre de lecture : couleurs du site d'abord, neutres ensuite, code seulement
 * pour qui en a besoin.
 */

import { t } from './i18n.js';
import { h, icon } from './ui.js';

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i;

/** Même règle que le serveur : hex ou rgb, ramenés à `#rrggbb`. */
export function normalizeColor(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  if (HEX_RE.test(raw)) {
    const hex = raw.slice(1);
    return hex.length === 3 ? `#${[...hex].map((c) => c + c).join('')}` : `#${hex}`;
  }
  const rgb = RGB_RE.exec(raw);
  if (!rgb) return null;
  const parts = rgb.slice(1, 4).map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Gris de repli, toujours proposés : ils vont avec n'importe quelle charte. */
const NEUTRALS = ['#182433', '#3b4b60', '#7b889b', '#ffffff', '#000000'];

const swatch = (color, label, onPick) =>
  h('button', {
    type: 'button',
    class: 'size-6 rounded-md border border-ink-200 transition hover:scale-110 focus-visible:scale-110',
    style: `background:${color}`,
    title: `${label} · ${color}`,
    'aria-label': `${label} · ${color}`,
    onmousedown: (e) => e.preventDefault(),
    onclick: () => onPick(color),
  });

/**
 * Bouton « couleur du texte » et son panneau.
 * `palette` : couleurs de la charte du site, `[{ name, value }]`.
 */
export function colorTool({ palette = [], onOpen, onApply, onClear }) {
  const panel = h('div', {
    class: 'absolute top-full left-0 z-30 mt-1 w-64 rounded-xl border border-ink-100 bg-white p-3 shadow-lg',
    hidden: true,
  });

  const bar = h('span', { class: 'block h-1 w-4 rounded-sm bg-ink', style: 'background:#182433' });
  const button = h(
    'button',
    {
      type: 'button',
      class: 'flex flex-col items-center gap-0.5 rounded-md px-2 py-1 text-xs font-semibold text-ink-600 transition hover:bg-ink-100',
      title: t('design.rt_color'),
      'aria-haspopup': 'true',
      onmousedown: (e) => e.preventDefault(),
      onclick: () => (panel.hidden ? open() : close()),
    },
    h('span', { class: 'leading-none' }, 'A'),
    bar,
  );

  const pick = (value) => {
    const color = normalizeColor(value);
    if (!color) return;
    bar.style.background = color;
    onApply(color);
  };

  const hex = h('input', {
    class: 'input px-2 py-1 font-mono text-xs',
    placeholder: '#7bc9a9',
    'aria-label': t('design.color_code'),
    autocomplete: 'off',
    maxlength: '25',
  });
  hex.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    pick(hex.value);
  });

  // Le sélecteur natif applique la couleur pendant le déplacement : l'aperçu est immédiat.
  const native = h('input', { type: 'color', class: 'h-8 w-9 cursor-pointer rounded-md border border-ink-200 bg-white p-0.5', value: '#7bc9a9' });
  native.addEventListener('input', () => pick(native.value));

  const section = (label, children) =>
    h('div', { class: 'mb-2' }, h('p', { class: 'mb-1 text-[11px] font-semibold tracking-wide text-ink-400 uppercase' }, label), h('div', { class: 'flex flex-wrap gap-1.5' }, ...children));

  panel.append(
    palette.length ? section(t('design.color_site'), palette.map((c) => swatch(c.value, c.name, pick))) : null,
    section(t('design.color_neutral'), NEUTRALS.map((c) => swatch(c, t('design.color_neutral'), pick))),
    h('div', { class: 'flex items-center gap-1.5' }, native, hex),
    h(
      'button',
      {
        type: 'button',
        class: 'mt-2 flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink-500 transition hover:bg-red-50 hover:text-red-600',
        onmousedown: (e) => e.preventDefault(),
        onclick: () => {
          onClear();
          close();
        },
      },
      icon('refresh', 'size-3.5'),
      t('design.color_clear'),
    ),
  );

  const outside = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  const escape = (e) => e.key === 'Escape' && close();

  function open() {
    onOpen?.();
    panel.hidden = false;
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
  }
  function close() {
    panel.hidden = true;
    document.removeEventListener('mousedown', outside);
    document.removeEventListener('keydown', escape);
  }

  const wrap = h('div', { class: 'relative' }, button, panel);
  return wrap;
}
