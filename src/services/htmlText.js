/**
 * Filtrage du HTML écrit dans les fichiers du site.
 *
 * Les gabarits du parc affichent les textes de `config.php` **sans échappement**
 * (`<?php echo $homepage['hero']['title']; ?>`). Tout ce que le back-office y écrit
 * est donc du HTML exécuté par le navigateur du visiteur : il doit être filtré ici,
 * et pas seulement dans l'interface, qui n'est qu'un client parmi d'autres.
 *
 * Principe retenu — liste blanche et reconstruction : on n'essaie jamais de
 * « nettoyer » une balise reçue, on la rejette ou on la réécrit soi-même. Aucun
 * attribut venu de l'extérieur n'est recopié, donc aucun `onerror`, `href`
 * `javascript:` ou guillemet mal fermé ne peut traverser.
 */

const TAG_RE = /<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)|<![\s\S]*?(?:>|$)|<\?[\s\S]*?(?:\?>|$)/g;

/**
 * Mise en valeur d'un mot, couleur, et lien : ce que le moteur du site sait rendre
 * dans un texte court. Le lien fait partie de la liste parce que les textes du parc
 * en contiennent déjà — un filtre plus strict effacerait du contenu en place.
 */
const INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'br', 'span', 'a']);
const REL_VALUES = new Set(['noopener', 'noreferrer', 'nofollow', 'sponsored', 'ugc']);

const ESCAPE = { '<': '&lt;', '>': '&gt;' };
const escapeAngles = (text) => text.replace(/[<>]/g, (ch) => ESCAPE[ch]);

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i;

/** Caractères de contrôle : ils servent à masquer un « javascript: » découpé. */
const withoutControls = (text) => [...text].filter((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127).join('');

/**
 * Couleur ramenée à `#rrggbb`, ou null si ce n'en est pas une.
 * Seule cette forme est réécrite dans les fichiers : jamais la chaîne reçue.
 */
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

/** Lecture d'un attribut reçu — sa valeur est examinée, jamais recopiée telle quelle. */
const attrOf = (attrs, name) => {
  const found = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return found ? (found[2] ?? found[3] ?? found[4] ?? '') : null;
};

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);

/**
 * Adresse acceptable : chemin du site, ancre, courriel ou adresse web.
 * Un protocole exécutable — `javascript:`, `data:`, `vbscript:` — est refusé ;
 * ces adresses finissent dans un `href`, où elles seraient cliquables.
 */
export function sanitizeUrl(value) {
  // L'adresse est recopiée dans un `href="…"` que le gabarit n'échappe pas : un
  // guillemet ou un chevron permettrait d'en sortir. On s'arrête juste avant.
  const url = withoutControls(String(value ?? '').trim())
    .split(/["'<>\s]/)[0]
    .slice(0, 500);
  if (!url) return '';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (scheme && !SAFE_SCHEMES.has(scheme[1].toLowerCase())) return '';
  return url;
}

const safeHref = (value) => sanitizeUrl(value) || null;

/** Ouverture d'un lien : seul `_blank` a un sens ici. */
const safeTarget = (value) => (String(value ?? '').trim().toLowerCase() === '_blank' ? '_blank' : null);

const safeRel = (value) => {
  const kept = String(value ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => REL_VALUES.has(word));
  return kept.length ? [...new Set(kept)].join(' ') : null;
};

/**
 * Ce qu'un attribut `style` demande, parmi ce que nos champs savent garder : une
 * couleur, du gras, de l'italique.
 *
 * Le gras et l'italique arrivent ici parce qu'un navigateur peut les écrire en CSS
 * plutôt qu'en balise — « <span style="font-weight: bold"> » au lieu de « <b> ». Un tel
 * span n'était pas conservé, et le gras disparaissait sans bruit. On le traduit
 * désormais en balise plutôt que de le perdre. C'est aussi ce qui sauve un texte collé
 * depuis un traitement de texte, qui ne met jamais de balises.
 */
function styleOf(attrs) {
  const style = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs);
  const out = { color: null, bold: false, italic: false };
  if (!style) return out;
  for (const declaration of (style[2] ?? style[3] ?? '').split(';')) {
    const [name, ...rest] = declaration.split(':');
    const key = name?.trim().toLowerCase();
    const raw = rest.join(':').trim().toLowerCase();
    if (key === 'color') out.color = normalizeColor(raw);
    // « bolder » et les graisses numériques comptent autant que « bold » : les
    // traitements de texte emploient volontiers « 700 ».
    else if (key === 'font-weight') out.bold = raw === 'bold' || raw === 'bolder' || Number.parseInt(raw, 10) >= 600;
    else if (key === 'font-style') out.italic = raw === 'italic' || raw === 'oblique';
  }
  return out;
}

/**
 * Texte enrichi d'un champ : mise en valeur, couleur et lien, rien d'autre.
 * Les balises inconnues disparaissent, leur contenu textuel est conservé.
 */
export function sanitizeInline(value) {
  if (typeof value !== 'string') return '';
  const source = value.replace(COMMENT_RE, '');
  const open = [];
  let out = '';
  let last = 0;

  TAG_RE.lastIndex = 0;
  for (let match = TAG_RE.exec(source); match; match = TAG_RE.exec(source)) {
    out += escapeAngles(source.slice(last, match.index));
    last = TAG_RE.lastIndex;

    const tag = match[1].toLowerCase();
    const closing = match[0][1] === '/';
    if (!INLINE_TAGS.has(tag)) continue;

    if (tag === 'br') {
      if (!closing) out += '<br>';
      continue;
    }
    if (closing) {
      // Une fermeture orpheline n'a rien à fermer : on l'ignore.
      const at = open.findLastIndex((e) => e.name === tag);
      if (at === -1) continue;
      while (open.length > at) out += open.pop().close;
      continue;
    }
    if (open.length >= 8) continue; // imbrication déraisonnable : on s'arrête là

    if (tag === 'span') {
      const { color, bold, italic } = styleOf(match[2]);
      // Un span n'a de valeur que par ce qu'il porte. S'il ne porte rien de ce que nous
      // gardons, on laisse passer son texte sans lui. S'il porte du gras ou de
      // l'italique écrits en CSS, ils deviennent des balises — sans quoi ils seraient
      // perdus, comme ils l'étaient.
      let ouvert = '';
      let ferme = '';
      if (color) { ouvert += `<span style="color:${color}">`; ferme = `</span>${ferme}`; }
      if (bold) { ouvert += '<strong>'; ferme = `</strong>${ferme}`; }
      if (italic) { ouvert += '<em>'; ferme = `</em>${ferme}`; }
      if (!ouvert) continue;
      out += ouvert;
      // La pile retient « span » pour que « </span> » referme bien tout ce bloc.
      open.push({ name: 'span', close: ferme });
      continue;
    }

    if (tag === 'a') {
      const href = safeHref(attrOf(match[2], 'href'));
      if (!href) continue; // lien non recevable : le libellé reste, l'adresse part
      const target = safeTarget(attrOf(match[2], 'target'));
      const rel = safeRel(attrOf(match[2], 'rel'));
      out += `<a href="${href.replace(/"/g, '&quot;')}"${target ? ` target="${target}"` : ''}${rel ? ` rel="${rel}"` : ''}>`;
    } else {
      out += `<${tag}>`;
    }
    open.push({ name: tag, close: `</${tag}>` });
  }
  out += escapeAngles(source.slice(last));
  while (open.length) out += open.pop().close;
  return out;
}

/** Champ qui finit dans un attribut HTML ou une adresse : texte brut, sans aucune balise. */
export function sanitizePlain(value) {
  if (typeof value !== 'string') return '';
  return withoutControls(value.replace(COMMENT_RE, '').replace(TAG_RE, ''))
    .replace(/[<>]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
