/**
 * Vocabulaire visuel des blocs de la page d'accueil.
 *
 * Le moteur du parc nomme ses gabarits en interne (« hero_split », « cta_gradient »…).
 * Ces noms ne disent rien à un agent : ce module les traduit en deux choses qu'on
 * comprend sans formation — un petit schéma de la mise en page et un intitulé en
 * langage courant (« Texte à gauche, image à droite »).
 *
 * Les formes sont déduites de la structure réelle des gabarits du parc.
 */

import { t } from './i18n.js';

const NS = 'http://www.w3.org/2000/svg';

const TONES = {
  page: '#f8fafc',
  bg: '#e5e9ef',
  img: '#cbd3de',
  soft: '#a3afbf',
  ink: '#3b4b60',
  light: '#ffffff',
  accent: '#7bc9a9',
  dark: '#182433',
};

/** Rectangle du schéma : coordonnées dans un cadre de 48 × 32. */
const r = (x, y, w, h, tone = 'soft', rad = 1) => ({ x, y, w, h, tone, rad });
const c = (cx, cy, rad, tone = 'img') => ({ cx, cy, rad, tone });

/** Titre et sous-titre centrés, présents en tête de la plupart des sections. */
const head = [r(17, 4, 14, 2.2, 'ink'), r(13, 8.6, 22, 1.4)];

const row = (y, xs, w, h, tone = 'img') => xs.map((x) => r(x, y, w, h, tone, 1.5));

const SHAPES = {
  textOnly: [r(14, 9, 20, 3, 'ink'), r(9, 15, 30, 1.8), r(13, 19, 22, 1.8), r(19, 24, 10, 4, 'accent', 2)],
  imageRight: [r(4, 8, 16, 3, 'ink'), r(4, 14, 15, 1.8), r(4, 18, 12, 1.8), r(4, 23, 10, 4, 'accent', 2), r(26, 3, 19, 26, 'img', 2)],
  imageLeft: [r(3, 3, 19, 26, 'img', 2), r(27, 8, 16, 3, 'ink'), r(27, 14, 15, 1.8), r(27, 18, 12, 1.8), r(27, 23, 10, 4, 'accent', 2)],
  overlay: [r(2, 2, 44, 28, 'img', 2), r(14, 11, 20, 3, 'light'), r(11, 17, 26, 1.8, 'light'), r(19, 22, 10, 4, 'accent', 2)],
  bottom: [r(2, 2, 44, 28, 'img', 2), r(5, 18, 20, 3, 'light'), r(5, 23, 26, 1.8, 'light')],
  grid4: [...head, ...row(14, [3, 14.5, 26, 37.5], 9.5, 13)],
  grid3: [...head, ...row(14, [4, 18, 32], 12, 13)],
  grid2: [...head, ...row(14, [6, 25], 17, 13)],
  grid3img: [...head, ...row(13, [4, 18, 32], 12, 9), ...row(24, [4, 18, 32], 8, 1.8, 'soft')],
  listRows: [...head, ...row(13, [4], 40, 4.5), ...row(19.5, [4], 40, 4.5), ...row(26, [4], 40, 4.5)],
  listCompact: [...head, r(6, 14, 36, 1.8), r(6, 19, 36, 1.8), r(6, 24, 36, 1.8), r(6, 29, 24, 1.8)],
  cardsRow: [...head, r(4, 13, 12, 7, 'img', 1.5), r(18, 14, 26, 1.8), r(18, 18, 20, 1.8), r(4, 22, 12, 7, 'img', 1.5), r(18, 23, 26, 1.8), r(18, 27, 20, 1.8)],
  featured: [...head, r(3, 13, 25, 16, 'img', 1.5), r(30, 13, 15, 7, 'img', 1.5), r(30, 22, 15, 7, 'img', 1.5)],
  magazine: [...head, r(3, 13, 20, 16, 'img', 1.5), r(25, 13, 20, 7.5, 'img', 1.5), r(25, 22, 9.5, 7, 'img', 1.5), r(35.5, 22, 9.5, 7, 'img', 1.5)],
  pills: [...head, r(5, 15, 8, 4.5, 'img', 2.5), r(15, 15, 10, 4.5, 'accent', 2.5), r(27, 15, 7, 4.5, 'img', 2.5), r(36, 15, 8, 4.5, 'img', 2.5)],
  minimalList: [...head, r(7, 16, 7, 2, 'ink'), r(17, 16, 9, 2, 'ink'), r(29, 16, 6, 2, 'ink'), r(38, 16, 5, 2, 'ink')],
  bannerWide: [r(2, 6, 44, 20, 'ink', 2), r(13, 11, 22, 2.6, 'light'), r(10, 16, 28, 1.6, 'light'), r(19, 20.5, 10, 3.6, 'accent', 1.8)],
  cardCenter: [r(9, 5, 30, 22, 'bg', 2.5), r(15, 10, 18, 2.6, 'ink'), r(13, 15, 22, 1.6), r(19, 19.5, 10, 3.6, 'accent', 1.8)],
  wave: [r(2, 3, 44, 18, 'ink', 2), { wave: true }, r(14, 8, 20, 2.6, 'light'), r(11, 13, 26, 1.6, 'light'), r(19, 24, 10, 4, 'accent', 2)],
  barRow: [r(2, 9, 44, 14, 'bg', 2), r(6, 12, 6, 3, 'ink'), r(6, 17, 6, 1.6), r(18, 12, 6, 3, 'ink'), r(18, 17, 6, 1.6), r(30, 12, 6, 3, 'ink'), r(30, 17, 6, 1.6), r(39, 12, 5, 3, 'ink'), r(39, 17, 5, 1.6)],
  rowPlain: [...head, r(6, 15, 6, 3, 'ink'), r(6, 20, 6, 1.6), r(18, 15, 6, 3, 'ink'), r(18, 20, 6, 1.6), r(30, 15, 6, 3, 'ink'), r(30, 20, 6, 1.6), r(39, 15, 5, 3, 'ink'), r(39, 20, 5, 1.6)],
  circles: [...head, c(9, 20, 5), c(21, 20, 5), c(33, 20, 5), c(43, 20, 4)],
  highlight: [...head, r(3, 13, 15, 16, 'accent', 2), r(20, 13, 7.5, 16, 'img', 1.5), r(29, 13, 7.5, 16, 'img', 1.5), r(38, 13, 7, 16, 'img', 1.5)],
  twoCols: [r(3, 7, 17, 3, 'ink'), r(3, 13, 15, 1.8), r(3, 17, 12, 1.8), r(3, 21, 14, 1.8), r(25, 7, 9, 9, 'img', 1.5), r(36, 7, 9, 9, 'img', 1.5), r(25, 18, 9, 9, 'img', 1.5), r(36, 18, 9, 9, 'img', 1.5)],
  accordion: [...head, r(6, 13, 36, 5, 'bg', 1.5), r(38, 15, 2, 1.4, 'soft'), r(6, 20, 36, 5, 'bg', 1.5), r(38, 22, 2, 1.4, 'soft'), r(6, 27, 36, 5, 'bg', 1.5), r(38, 29, 2, 1.4, 'soft')],
  accordionCenter: [...head, r(11, 13, 26, 5, 'bg', 1.5), r(11, 20, 26, 5, 'bg', 1.5), r(11, 27, 26, 5, 'bg', 1.5)],
  quote: [r(12, 7, 24, 3, 'ink'), r(7, 14, 34, 1.8), r(11, 18, 26, 1.8), c(24, 25, 3.5)],
  form: [...head, r(7, 15, 24, 5.5, 'bg', 2.5), r(33, 15, 9, 5.5, 'accent', 2.5)],
  cardSplit: [r(4, 5, 40, 22, 'bg', 2.5), r(7, 8, 15, 16, 'img', 1.5), r(25, 10, 15, 2.6, 'ink'), r(25, 15, 12, 1.6), r(25, 19, 9, 3.4, 'accent', 1.7)],
};

/**
 * Chaque gabarit du parc, ramené à une forme et, si besoin, à une nuance
 * (fond sombre, dégradé, épuré) qui le distingue de ses voisins.
 */
const LAYOUTS = {
  hero_split: { shape: 'imageRight' },
  hero_split_reverse: { shape: 'imageLeft' },
  hero_centered: { shape: 'overlay' },
  hero_full: { shape: 'bottom' },
  hero_minimal: { shape: 'textOnly' },
  hero_overlay: { shape: 'overlay', tone: 'dark' },

  categories_pills: { shape: 'pills' },
  categories_grid: { shape: 'grid4' },
  categories_banner: { shape: 'bannerWide' },
  categories_images: { shape: 'grid3img' },
  categories_list: { shape: 'listRows' },
  categories_minimal: { shape: 'minimalList' },
  categories_split: { shape: 'twoCols' },

  articles_list: { shape: 'listRows' },
  articles_minimal: { shape: 'listCompact' },
  articles_preview: { shape: 'grid3img' },
  articles_featured: { shape: 'featured' },
  articles_magazine: { shape: 'magazine' },
  articles_cards_horizontal: { shape: 'cardsRow' },

  split_content: { shape: 'imageLeft' },
  split_content_reverse: { shape: 'imageRight' },
  split_content_card: { shape: 'cardSplit' },
  split_content_dark: { shape: 'imageLeft', tone: 'dark' },
  split_content_minimal: { shape: 'imageLeft', tone: 'minimal' },

  stats_bar: { shape: 'barRow' },
  stats_cards: { shape: 'grid4' },
  stats_circles: { shape: 'circles' },
  stats_columns: { shape: 'twoCols' },
  stats_gradient: { shape: 'barRow', tone: 'gradient' },
  stats_highlight: { shape: 'highlight' },
  stats_minimal: { shape: 'rowPlain' },

  testimonials_grid: { shape: 'grid3' },
  testimonials_highlight: { shape: 'highlight' },
  testimonials_list: { shape: 'listRows' },
  testimonials_minimal: { shape: 'listCompact' },
  testimonials_single: { shape: 'quote' },

  cta_gradient: { shape: 'bannerWide', tone: 'gradient' },
  cta_banner: { shape: 'bannerWide' },
  cta_card: { shape: 'cardCenter' },
  cta_dark: { shape: 'bannerWide', tone: 'dark' },
  cta_minimal: { shape: 'textOnly' },
  cta_split: { shape: 'imageRight' },
  cta_wave: { shape: 'wave' },

  faq_accordion: { shape: 'accordion' },
  faq_cards: { shape: 'grid2' },
  faq_centered: { shape: 'accordionCenter' },
  faq_columns: { shape: 'twoCols' },
  faq_minimal: { shape: 'listCompact' },

  newsletter: { shape: 'form' },
  newsletter_banner: { shape: 'bannerWide' },
  newsletter_card: { shape: 'cardCenter' },
  newsletter_dark: { shape: 'bannerWide', tone: 'dark' },
  newsletter_minimal: { shape: 'form', tone: 'minimal' },
};

/** Intitulé lisible d'un gabarit : « Texte à gauche, image à droite · fond sombre ». */
export function layoutLabel(section) {
  const layout = LAYOUTS[section];
  if (!layout) return String(section).replace(/_/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
  const base = t(`design.layout.${layout.shape}`);
  return layout.tone ? `${base} · ${t(`design.tone.${layout.tone}`)}` : base;
}

let gradientSeq = 0;

/** Schéma de la mise en page, en SVG : la forme se lit d'un coup d'œil, sans texte. */
export function wireframe(section, cls = 'h-9 w-14') {
  const layout = LAYOUTS[section] ?? { shape: 'textOnly' };
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 48 32', class: cls, 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' })) svg.setAttribute(k, v);

  const back = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: 0, y: 0, width: 48, height: 32, rx: 3, fill: TONES.page })) back.setAttribute(k, String(v));
  svg.append(back);

  const dark = layout.tone === 'dark';
  // Le dégradé n'habille que le grand aplat du schéma : la nuance se voit sans brouiller la forme.
  let gradientFill = null;
  if (layout.tone === 'gradient') {
    const id = `lkm-wire-${++gradientSeq}`;
    const defs = document.createElementNS(NS, 'defs');
    const lg = document.createElementNS(NS, 'linearGradient');
    for (const [k, v] of Object.entries({ id, x1: '0', y1: '0', x2: '1', y2: '1' })) lg.setAttribute(k, v);
    for (const [offset, color] of [['0%', TONES.ink], ['100%', TONES.accent]]) {
      const stop = document.createElementNS(NS, 'stop');
      stop.setAttribute('offset', offset);
      stop.setAttribute('stop-color', color);
      lg.append(stop);
    }
    defs.append(lg);
    svg.append(defs);
    gradientFill = `url(#${id})`;
  }

  let first = true;
  for (const part of SHAPES[layout.shape] ?? []) {
    if (part.wave) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', 'M2 19c8 4 14 -4 22 0s14 4 22 0v4H2z');
      path.setAttribute('fill', TONES.ink);
      svg.append(path);
      continue;
    }
    const node = document.createElementNS(NS, part.cx === undefined ? 'rect' : 'circle');
    const fill = gradientFill && first ? gradientFill : dark && (part.tone === 'ink' || part.tone === 'bg') ? TONES.dark : TONES[part.tone];
    first = false;
    if (part.cx === undefined) {
      for (const [k, v] of Object.entries({ x: part.x, y: part.y, width: part.w, height: part.h, rx: part.rad, fill })) node.setAttribute(k, String(v));
    } else {
      for (const [k, v] of Object.entries({ cx: part.cx, cy: part.cy, r: part.rad, fill })) node.setAttribute(k, String(v));
    }
    svg.append(node);
  }
  return svg;
}
