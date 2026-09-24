import crypto from 'node:crypto';
import { AppError } from '../errors.js';
import { assertDomain } from '../ssh/shell.js';
import { deleteDraft, getDraft, saveDraft, setDraftPreview } from '../db/drafts.js';
import { READ_ARTICLE, READ_ARTICLE_METAS, READ_SITE, RENDER_PAGE, WRITE_IMAGE } from './phpScripts.js';
import {
  EXIT_MESSAGES,
  dropImageCommand,
  dropRenderCommand,
  imageTmpPath,
  listBackupsCommand,
  phpCommand,
  prepareRenderCommand,
  publishCommand,
  renderDirFor,
  renderPageCommand,
  restoreCommand,
  stageImageCommand,
  writeArticleCommand,
} from './siteDriver.js';
import { buildArticleMetaBlock, buildConfigPhp, buildStyleCss, spliceArticle } from './phpWriter.js';
import { validateArticleContent, validateArticleMeta, validateConfig, validateStyle } from './siteCatalog.js';

const LONG = 120000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const PREVIEW_TTL_MS = 20 * 60 * 1000;
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** Reconnaissance par les premiers octets : l'extension d'un fichier ne prouve rien. */
export function imageKind(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  return null;
}

/** Identifiant tiré du nom d'origine, dans la forme utilisée par le parc, et libre. */
export function uniqueImageId(name, existing) {
  const base = String(name ?? '')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70);
  const root = base || `image-${Date.now().toString(36)}`;
  const taken = new Set(existing);
  if (!taken.has(root)) return root;
  for (let n = 2; n < 500; n += 1) if (!taken.has(`${root}-${n}`)) return `${root}-${n}`;
  return `${root}-${Date.now().toString(36)}`;
}

/**
 * Métadonnées à écrire : celles du fichier, dans leur ordre, avec les valeurs modifiées.
 *
 * Le formulaire envoie tous ses champs, y compris ceux que le fichier n'avait pas : sans
 * cette fusion, changer une image ajoutait un « intro » vide et déplaçait des lignes. Une
 * publication ne doit toucher que ce que l'agent a changé — le reste du fichier, à l'octet
 * près, reste celui d'origine.
 */
export function mergeArticleMeta(original, edited) {
  const vide = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  const base = original && typeof original === 'object' ? original : {};
  const next = edited && typeof edited === 'object' ? edited : {};
  const out = {};
  for (const key of Object.keys(base)) out[key] = key in next ? next[key] : base[key];
  for (const [key, value] of Object.entries(next)) if (!(key in out) && !vide(value)) out[key] = value;
  return out;
}

/**
 * Chemins de configuration qu'une traduction a le droit de toucher.
 * Le reste — rubriques, adresses, présélections — n'est pas de la prose : le modifier
 * changerait des adresses d'articles ou casserait le rendu.
 */
export const TRANSLATABLE_ROOTS = ['site_tagline', 'header_cta_text', 'homepage'];

const PATH_SEG = /^[A-Za-z0-9_-]{1,64}$/;

/** Découpe « homepage.faq.items.0.q » en segments, ou `null` si le chemin est hors sujet. */
function pathSegments(path) {
  const segs = String(path ?? '').split('.');
  if (!segs.length || !TRANSLATABLE_ROOTS.includes(segs[0])) return null;
  return segs.every((s) => PATH_SEG.test(s)) ? segs : null;
}

/**
 * Lit la valeur désignée par un chemin, sans jamais emprunter la chaîne de prototypes
 * ni créer de clé : un chemin qui ne correspond à rien renvoie `undefined`.
 */
export function readPath(root, path) {
  const segs = pathSegments(path);
  if (!segs) return undefined;
  let cur = root;
  for (const seg of segs) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined;
      cur = cur[i];
    } else {
      if (!Object.hasOwn(cur, seg)) return undefined;
      cur = cur[seg];
    }
  }
  return cur;
}

/** Remplace un TEXTE existant à ce chemin. Renvoie false si le chemin n'existe pas ou n'est pas un texte. */
export function writePath(root, path, value) {
  const segs = pathSegments(path);
  if (!segs) return false;
  const parent = segs.length === 1 ? root : readPath(root, segs.slice(0, -1).join('.'));
  if (parent === null || typeof parent !== 'object') return false;
  const last = segs[segs.length - 1];
  const key = Array.isArray(parent) ? Number(last) : last;
  const current = Array.isArray(parent) ? parent[key] : Object.hasOwn(parent, last) ? parent[last] : undefined;
  if (typeof current !== 'string') return false;
  parent[key] = value;
  return true;
}

const FONT_MIME = { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' };

/**
 * Prépare le HTML de prévisualisation servi par le back-office :
 *   - les scripts et gestionnaires d'événements sont retirés (la page provient d'un site
 *     tiers : elle ne doit rien pouvoir exécuter dans l'origine du back-office) ;
 *   - les adresses racines pointent vers la production, pour que styles, images et polices
 *     se chargent normalement ;
 *   - la charte du brouillon est injectée en dernier, donc prioritaire, et un bandeau
 *     rappelle en permanence qu'il s'agit d'un brouillon.
 */
export function preparePreviewHtml(html, domain, style = {}, isDraft = true, fonts = {}) {
  const withoutScripts = String(html)
    // Le moteur charge certaines feuilles par « preload + onload » : sans script, elles ne
    // s'appliqueraient jamais. On les convertit en feuilles de style ordinaires.
    .replace(/<link\b[^>]*\brel=(["'])preload\1[^>]*\bas=(["'])style\2[^>]*>/gi, (tag) =>
      tag.replace(/\brel=(["'])preload\1/i, 'rel="stylesheet"').replace(/\s(onload|onerror)\s*=\s*(["'])[^"']*\2/gi, ''),
    )
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*>/gi, '')
    .replace(/<noscript>|<\/noscript>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');

  const base = `https://${domain}`;
  const absolute = withoutScripts
    .replace(/\b(href|src|poster|action)=(["'])\/(?!\/)/gi, `$1=$2${base}/`)
    .replace(/\bsrcset=(["'])([^"']+)\1/gi, (_m, q, value) => `srcset=${q}${value.replace(/(^|,\s*)\/(?!\/)/g, `$1${base}/`)}${q}`);

  // Les polices du site sont embarquées dans la page : servie depuis l'origine du
  // back-office, une police téléchargée depuis le domaine serait refusée par le
  // navigateur (les fichiers de police exigent une autorisation d'origine croisée).
  const embedded = absolute
    .replace(/<link\b[^>]*\bas=["']?font["']?[^>]*>/gi, '')
    .replace(/(?:https?:\/\/[^\s"'()]+?)?\/fonts\/([\w.-]+\.(woff2|woff|ttf|otf))/gi, (match, file, ext) =>
      fonts[file] ? `data:${FONT_MIME[ext.toLowerCase()]};base64,${fonts[file]}` : match,
    );

  const vars = Object.entries(style)
    .map(([name, value]) => `--${name}: ${value};`)
    .join('');
  // Bandeau toujours présent : on doit pouvoir distinguer d'un coup d'œil une
  // prévisualisation de la page réellement en ligne.
  const label = isDraft ? 'PRÉVISUALISATION — brouillon non publié' : 'PRÉVISUALISATION — état actuellement en ligne';
  const banner = `<style>body::before{content:"${label}";position:fixed;inset:0 0 auto 0;z-index:2147483647;background:#182433;color:#7bc9a9;font:600 12px/28px system-ui,sans-serif;text-align:center;letter-spacing:.04em}body{padding-top:28px !important}</style>`;
  const inject = `<meta name="robots" content="noindex,nofollow">${vars ? `<style id="lkm-draft-theme">:root{${vars}}</style>` : ''}${banner}`;
  return embedded.includes('</head>') ? embedded.replace('</head>', `${inject}</head>`) : inject + embedded;
}

/** Comparaison structurelle tolérante à l'ordre des clés (PHP et JSON ne le garantissent pas). */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, normalize(value[k])]),
    );
  }
  if (typeof value === 'number') return String(value);
  return value;
}
const sameConfig = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/**
 * Éditeur de design et de contenu d'un site du parc.
 *
 * Trois garanties tenues par ce service :
 *   1. un brouillon ne touche jamais la production ;
 *   2. une prévisualisation est un dossier jetable, relié par liens physiques ;
 *   3. une publication est sauvegardée, vérifiée après écriture, et annulée
 *      automatiquement si la relecture ne correspond pas à l'intention.
 */
export class SiteService {
  constructor(ssh) {
    this.ssh = ssh;
    /** Prévisualisations rendues, conservées en mémoire quelques minutes. */
    this.previews = new Map();
  }

  context(serverId, domain) {
    const server = this.ssh.server(serverId);
    assertDomain(domain);
    return { server, docroot: `${server.wwwRoot}/${domain}/public_html` };
  }

  /** Exécute une commande, contenu volumineux transmis sur l'entrée standard. */
  async #run(serverId, command, { stdin, timeout = LONG, maxBytes = 8 * 1024 * 1024 } = {}) {
    const { stream, done } = await this.ssh.spawn(serverId, command, { timeout });
    const chunks = [];
    let size = 0;
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    stream.end(stdin);
    const res = await done;
    return { ...res, stdout: Buffer.concat(chunks).toString('utf8') };
  }

  #check(res, server) {
    if (res.code === 0) return res;
    const key = EXIT_MESSAGES[res.code];
    if (key) throw new AppError(key, { status: key === 'errors.design_conflict' ? 409 : 400, vars: { server: server.label }, detail: res.stderr?.trim().slice(-800) || undefined });
    throw new AppError('errors.ssh_command_failed', { status: 502, vars: { server: server.label, code: res.code }, detail: res.stderr?.trim().slice(-800) || undefined });
  }

  /** Lance un script PHP côté site et renvoie le JSON produit. */
  async #php(serverId, docroot, script, env = {}, { timeout = LONG } = {}) {
    const server = this.ssh.server(serverId);
    const res = await this.#run(serverId, phpCommand(docroot, env), { stdin: script, timeout });
    this.#check(res, server);
    const text = res.stdout.trim();
    if (!text.startsWith('{') && !text.startsWith('[')) {
      throw new AppError('errors.design_read_failed', { status: 502, vars: { server: server.label }, detail: text.slice(0, 500) });
    }
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new AppError('errors.design_read_failed', { status: 502, vars: { server: server.label }, detail: err.message });
    }
  }

  /**
   * Exécute un script PHP d'un autre service (analyse de langue, par exemple) dans le
   * contexte d'un serveur, sans passer par un domaine : même transport, mêmes contrôles.
   */
  runPhp(serverId, docroot, script, env = {}, options = {}) {
    return this.#php(serverId, docroot, script, env, options);
  }

  // ───────────────────────── Lecture ─────────────────────────

  async readSite(serverId, domain) {
    const { docroot } = this.context(serverId, domain);
    const site = await this.#php(serverId, docroot, READ_SITE);
    if (!site.config) throw new AppError('errors.design_not_supported', { status: 400, vars: { domain } });
    return site;
  }

  /** Vue complète pour l'éditeur : état publié, brouillon éventuel, catalogue du site. */
  async editorState(serverId, domain) {
    const site = await this.readSite(serverId, domain);
    const draft = getDraft(serverId, domain, 'site', '');
    return {
      server: serverId,
      domain,
      published: { config: site.config, style: site.style },
      draft: draft ? { ...draft.data, updatedAt: draft.updatedAt, stale: draft.baseHash !== site.configMeta?.md5 } : null,
      available: { sections: site.sections, images: site.images },
      counts: { articles: site.articles.length, images: site.images.length },
      extraVars: Object.keys(site.extraVars ?? {}),
      meta: { config: site.configMeta, style: site.styleMeta },
    };
  }

  // ───────────────────────── Images ─────────────────────────

  /**
   * Import d'une image depuis le poste de l'agent.
   *
   * Le moteur du parc n'affiche jamais le fichier d'origine : il ne connaît que des
   * déclinaisons `<id>-<largeur>.<ext>`, en 400, 600, 900 et 1920, WebP et JPEG. Elles
   * sont fabriquées par le PHP du site lui-même, et `manifest.json` en garde l'index.
   */
  async uploadImage(serverId, domain, { name, data }) {
    const { server, docroot } = this.context(serverId, domain);
    if (!Buffer.isBuffer(data) || data.length === 0) throw new AppError('errors.file_upload_empty', { status: 400 });
    if (data.length > MAX_IMAGE_BYTES) throw new AppError('errors.file_too_big', { status: 413 });
    // Le nom d'un fichier ne prouve rien : c'est son contenu qui décide.
    if (!imageKind(data)) throw new AppError('errors.design_image_invalid', { status: 400 });

    const site = await this.readSite(serverId, domain);
    const id = uniqueImageId(name, site.images ?? []);
    const token = crypto.randomBytes(8).toString('hex');
    try {
      this.#check(await this.#run(serverId, stageImageCommand(token), { stdin: data, timeout: LONG }), server);
      const out = await this.#php(serverId, docroot, WRITE_IMAGE, { LKM_SRC: imageTmpPath(token), LKM_ID: id });
      if (out.error) throw new AppError('errors.design_image_failed', { status: 502, vars: { server: server.label }, detail: out.error });
      return out;
    } finally {
      // Le fichier déposé ne sert qu'à la fabrication : il ne doit pas traîner.
      await this.#run(serverId, dropImageCommand(token)).catch(() => {});
    }
  }

  async listArticles(serverId, domain) {
    const site = await this.readSite(serverId, domain);
    return site.articles;
  }

  async articleMetas(serverId, domain, files) {
    const { docroot } = this.context(serverId, domain);
    const list = (Array.isArray(files) ? files : []).slice(0, 60).map((f) => String(f));
    if (!list.length) return [];
    return this.#php(serverId, docroot, READ_ARTICLE_METAS, { LKM_B64: b64(JSON.stringify(list)) });
  }

  /** Lecture brute d'un article (contenu du fichier compris), usage interne. */
  async #articleRaw(serverId, domain, rel) {
    const { docroot } = this.context(serverId, domain);
    return this.#php(serverId, docroot, READ_ARTICLE, { LKM_B64: b64(String(rel)) });
  }

  async readArticle(serverId, domain, rel) {
    const article = await this.#articleRaw(serverId, domain, rel);
    if (article.missing) throw new AppError('errors.file_not_found', { status: 404 });
    if (article.content === null || article.offsets?.metaStart === null) {
      throw new AppError('errors.design_article_unsupported', { status: 400, vars: { file: String(rel).slice(0, 120) } });
    }
    const draft = getDraft(serverId, domain, 'article', rel);
    return {
      ...article,
      raw: undefined,
      draft: draft ? { ...draft.data, updatedAt: draft.updatedAt, stale: draft.baseHash !== article.md5 } : null,
    };
  }

  // ───────────────────────── Brouillons ─────────────────────────

  async saveSiteDraft(serverId, domain, { config, style }, userId) {
    const site = await this.readSite(serverId, domain);
    const data = {
      config: validateConfig({ ...site.config, ...config }, { available: site.sections }),
      style: validateStyle({ ...site.style, ...style }),
    };
    const draft = saveDraft({ server: serverId, domain, data, baseHash: site.configMeta?.md5 ?? '', userId });
    return { updatedAt: draft.updatedAt, ...data };
  }

  async saveArticleDraft(serverId, domain, rel, { meta, content }, userId) {
    const article = await this.readArticle(serverId, domain, rel);
    const data = {
      meta: validateArticleMeta({ ...article.meta, ...meta }),
      content: validateArticleContent(content ?? article.content),
    };
    const draft = saveDraft({ server: serverId, domain, kind: 'article', target: rel, data, baseHash: article.md5, userId });
    return { updatedAt: draft.updatedAt, ...data };
  }

  discardDraft(serverId, domain, kind = 'site', target = '') {
    return { removed: deleteDraft(serverId, domain, kind, target) > 0 };
  }

  // ───────────────────────── Prévisualisation ─────────────────────────

  /**
   * Rend la page telle qu'elle serait publiée, SANS rien écrire dans le site.
   *
   * Le moteur est recopié dans un dossier de travail sous /tmp du serveur, la page y est
   * produite avec le brouillon, puis le dossier est supprimé aussitôt. Le HTML obtenu est
   * conservé quelques minutes en mémoire du back-office et servi par lui : le site en
   * production n'est ni modifié, ni exposé, et un domaine verrouillé reste prévisualisable.
   */
  async preview(serverId, domain, { article: articleRel = null, userId = null } = {}) {
    const { server, docroot } = this.context(serverId, domain);
    const site = await this.readSite(serverId, domain);
    const draft = getDraft(serverId, domain, 'site', '');
    const config = draft ? validateConfig({ ...site.config, ...draft.data.config }, { available: site.sections }) : site.config;
    const style = draft ? validateStyle({ ...site.style, ...draft.data.style }) : site.style;
    const token = crypto.randomBytes(16).toString('hex');

    try {
      this.#check(
        await this.#run(serverId, prepareRenderCommand(docroot, token, { styleB64: b64(buildStyleCss(style)) }), {
          stdin: b64(buildConfigPhp(config, site.extraVars)),
        }),
        server,
      );

      let pageName = 'home.php';
      let pageDir = 'page';
      let pageSource = `<?php include __DIR__ . '/../homepage.php';\n`;
      if (articleRel) {
        const article = await this.#articleRaw(serverId, domain, articleRel);
        if (article.missing) throw new AppError('errors.file_not_found', { status: 404 });
        const draftArticle = getDraft(serverId, domain, 'article', articleRel);
        // Le fichier reste un tampon d'octets de bout en bout : les positions de PHP sont des octets.
        pageSource = spliceArticle(Buffer.from(article.raw, 'base64'), article.offsets, {
          metaBlock: buildArticleMetaBlock(draftArticle ? mergeArticleMeta(article.meta, draftArticle.data.meta) : article.meta),
          content: draftArticle ? draftArticle.data.content : article.content,
        });
        pageName = articleRel.split('/').pop();
        pageDir = renderDirFor(articleRel);
      }
      this.#check(await this.#run(serverId, renderPageCommand(token, pageName, pageDir), { stdin: b64(pageSource) }), server);

      const rendered = await this.#php(serverId, docroot, RENDER_PAGE, {
        LKM_TMP: `/tmp/lkm-render-${token}`,
        LKM_PAGE: `${pageDir}/${pageName}`,
        // L'adresse demandée est celle de l'article, comme en production.
        LKM_URI: articleRel ? `/${articleRel}` : '/',
        LKM_HOST: domain,
      });
      if (!rendered.html) throw new AppError('errors.design_preview_failed', { status: 502, vars: { server: server.label }, detail: rendered.error });

      const id = crypto.randomBytes(16).toString('hex');
      this.previews.set(id, {
        html: preparePreviewHtml(rendered.html, domain, style, Boolean(draft), rendered.fonts ?? {}),
        domain,
        userId,
        expires: Date.now() + PREVIEW_TTL_MS,
      });
      this.#sweepPreviews();
      if (draft) setDraftPreview(draft.id, id);
      return { id, page: articleRel ?? 'homepage', expiresInMinutes: PREVIEW_TTL_MS / 60000 };
    } finally {
      // Le dossier de travail ne sert qu'au rendu : on l'efface immédiatement.
      await this.#run(serverId, dropRenderCommand(token)).catch(() => {});
    }
  }

  /** Récupère une prévisualisation en mémoire (servie ensuite par le back-office). */
  getPreview(id, { domain, userId } = {}) {
    this.#sweepPreviews();
    const entry = this.previews.get(String(id));
    if (!entry || (domain && entry.domain !== domain) || (entry.userId && userId && entry.userId !== userId)) {
      throw new AppError('errors.design_preview_expired', { status: 404 });
    }
    return entry.html;
  }

  #sweepPreviews() {
    const now = Date.now();
    for (const [id, entry] of this.previews) if (entry.expires <= now) this.previews.delete(id);
  }

  // ───────────────────────── Publication ─────────────────────────

  /**
   * Écrit `config.php` : sauvegarde horodatée, contrôle de syntaxe, écriture sur place,
   * puis relecture. Si le site ne relit pas exactement ce qui a été demandé, la
   * sauvegarde est restaurée et l'opération est déclarée en échec.
   *
   * `styleB64` vide laisse `style.css` intact — une traduction ne touche pas à la charte.
   */
  async #commitConfig(serverId, domain, { site, config, styleB64 = '' }) {
    const { server, docroot } = this.context(serverId, domain);
    const res = await this.#run(serverId, publishCommand(docroot, { styleB64, expectMd5: site.configMeta?.md5 ?? '' }), {
      stdin: b64(buildConfigPhp(config, site.extraVars)),
    });
    this.#check(res, server);
    const stamp = res.stdout.trim();

    const after = await this.readSite(serverId, domain);
    if (!sameConfig(after.config, config)) {
      await this.#run(serverId, restoreCommand(docroot, `config-${stamp}.php`)).catch(() => {});
      throw new AppError('errors.design_verify_failed', { status: 500, vars: { domain } });
    }
    return { stamp, after };
  }

  /**
   * Déclare de nouvelles rubriques dans `config.php`.
   *
   * Le fichier n'est pas rapiécé : il est reconstruit depuis la configuration relue,
   * validée, puis écrit par le circuit de publication — sauvegarde, `php -l`, relecture
   * de contrôle. Une rubrique déjà déclarée n'est jamais réécrite : son nom, son icône
   * et sa description sont l'œuvre de quelqu'un, pas des valeurs à remplacer.
   */
  async addCategories(serverId, domain, categories, userId) {
    this.context(serverId, domain);
    const site = await this.readSite(serverId, domain);
    const config = structuredClone(site.config);
    if (!config.categories || typeof config.categories !== 'object' || Array.isArray(config.categories)) {
      throw new AppError('errors.category_block_missing', { status: 400, vars: { domain } });
    }

    const added = [];
    for (const { slug, name } of Array.isArray(categories) ? categories : []) {
      if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(String(slug ?? '')) || !String(name ?? '').trim()) continue;
      if (Object.hasOwn(config.categories, slug)) continue;
      // Icône et description restent vides : l'agent les complète dans l'éditeur, s'il
      // le souhaite, en voyant le rendu.
      config.categories[slug] = { name: String(name).trim(), icon: '', description: '' };
      added.push(slug);
    }
    if (!added.length) return { domain, added: [], stamp: null };

    const validated = validateConfig(config, { available: site.sections });
    const { stamp } = await this.#commitConfig(serverId, domain, { site, config: validated });
    return { domain, added, stamp };
  }

  /**
   * Remplace des textes désignés par leur chemin (« homepage.hero.title »), sans passer
   * par un brouillon : c'est le geste de l'écran de traduction.
   *
   * Trois garde-fous : seuls les chemins de prose sont acceptés, la valeur attendue est
   * comparée à celle du serveur avant remplacement (un texte modifié entre-temps est
   * laissé intact et signalé), et l'écriture emprunte le circuit de publication complet.
   */
  async applyTextChanges(serverId, domain, changes, userId) {
    this.context(serverId, domain);
    const site = await this.readSite(serverId, domain);
    const config = structuredClone(site.config);

    const applied = [];
    const skipped = [];
    for (const change of Array.isArray(changes) ? changes : []) {
      const path = String(change?.path ?? '');
      const to = typeof change?.to === 'string' ? change.to : '';
      const current = readPath(config, path);
      if (typeof current !== 'string') {
        skipped.push({ path, reason: 'unknown' });
      } else if (!to.trim() || to === current) {
        skipped.push({ path, reason: 'unchanged' });
      } else if (change?.from !== undefined && String(change.from) !== current) {
        skipped.push({ path, reason: 'modified' });
      } else if (writePath(config, path, to)) {
        applied.push({ path, from: current, to });
      } else {
        skipped.push({ path, reason: 'unknown' });
      }
    }
    if (!applied.length) throw new AppError('errors.translate_nothing', { status: 400, vars: { domain } });

    // Le même filet que l'éditeur : les textes passent par la liste blanche de balises.
    const validated = validateConfig(config, { available: site.sections });
    const { stamp, after } = await this.#commitConfig(serverId, domain, { site, config: validated });
    return { domain, stamp, applied, skipped, config: after.config };
  }

  /**
   * Publie le brouillon : sauvegarde, écriture, relecture de contrôle.
   * Si la relecture ne correspond pas à l'intention, la sauvegarde est restaurée
   * immédiatement et la publication est déclarée en échec.
   */
  async publish(serverId, domain, userId) {
    this.context(serverId, domain);
    const draft = getDraft(serverId, domain, 'site', '');
    if (!draft) throw new AppError('errors.design_no_draft', { status: 400 });

    const site = await this.readSite(serverId, domain);
    if (draft.baseHash && site.configMeta?.md5 && draft.baseHash !== site.configMeta.md5) {
      throw new AppError('errors.design_conflict', { status: 409, vars: { domain } });
    }

    const config = validateConfig({ ...site.config, ...draft.data.config }, { available: site.sections });
    const style = validateStyle({ ...site.style, ...draft.data.style });
    const { stamp, after } = await this.#commitConfig(serverId, domain, { site, config, styleB64: b64(buildStyleCss(style)) });

    deleteDraft(serverId, domain, 'site', '');
    // Les prévisualisations du domaine deviennent caduques : elles montrent un état publié.
    for (const [id, entry] of this.previews) if (entry.domain === domain) this.previews.delete(id);
    return { stamp, config: after.config, style: after.style };
  }

  /** Publie un article : mêmes garanties (sauvegarde, syntaxe, écriture sur place). */
  async publishArticle(serverId, domain, rel, userId) {
    const { server, docroot } = this.context(serverId, domain);
    const draft = getDraft(serverId, domain, 'article', rel);
    if (!draft) throw new AppError('errors.design_no_draft', { status: 400 });

    const current = await this.#php(serverId, docroot, READ_ARTICLE, { LKM_B64: b64(rel) });
    if (current.missing) throw new AppError('errors.file_not_found', { status: 404 });
    if (draft.baseHash && draft.baseHash !== current.md5) throw new AppError('errors.design_conflict', { status: 409, vars: { domain } });

    const updated = spliceArticle(Buffer.from(current.raw, 'base64'), current.offsets, {
      metaBlock: buildArticleMetaBlock(mergeArticleMeta(current.meta, validateArticleMeta(draft.data.meta))),
      content: validateArticleContent(draft.data.content),
    });

    const res = await this.#run(serverId, writeArticleCommand(docroot, rel, { expectMd5: current.md5 }), { stdin: b64(updated) });
    this.#check(res, server);

    const after = await this.#php(serverId, docroot, READ_ARTICLE, { LKM_B64: b64(rel) });
    if (after.missing || after.content !== draft.data.content) {
      throw new AppError('errors.design_verify_failed', { status: 500, vars: { domain } });
    }

    deleteDraft(serverId, domain, 'article', rel);
    return { stamp: res.stdout.trim(), file: rel, meta: after.meta };
  }

  // ───────────────────────── Sauvegardes ─────────────────────────

  async listBackups(serverId, domain) {
    const { server, docroot } = this.context(serverId, domain);
    const res = await this.#run(serverId, listBackupsCommand(docroot));
    this.#check(res, server);
    return res.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, size, mtime] = line.split('\t');
        return { name, size: Number(size) || 0, mtime: Math.round(Number(mtime) * 1000) || null, kind: name.startsWith('style-') ? 'style' : 'config' };
      })
      .filter((b) => b.name);
  }

  async restoreBackup(serverId, domain, name) {
    const { server, docroot } = this.context(serverId, domain);
    if (!/^(config-\d{8}-\d{6}\.php|style-\d{8}-\d{6}\.css)$/.test(String(name))) throw new AppError('errors.file_name_invalid', { status: 400, vars: { name: String(name).slice(0, 60) } });
    this.#check(await this.#run(serverId, restoreCommand(docroot, name)), server);
    return { restored: name };
  }
}
