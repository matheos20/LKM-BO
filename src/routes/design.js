import express, { Router } from 'express';
import { requireConnection, requirePermission, requireServerAccess } from '../middleware/index.js';
import { PRESETS, SECTION_FAMILIES, SITE_LANGS } from '../services/siteCatalog.js';
import { deletePhrase, listPhrases, savePhrase } from '../db/phrases.js';

/**
 * Éditeur de design et de contenu, monté sous
 * /api/servers/:id/domains/:domain/design
 *
 *  GET    /                   état de l'éditeur : publié + brouillon + catalogue du site
 *  PUT    /draft              enregistre le brouillon { config, style }
 *  DELETE /draft              abandonne le brouillon
 *  POST   /images             importe une image (corps binaire) ?name=  → déclinaisons créées
 *  POST   /preview            crée la prévisualisation { article? } → adresse à ouvrir
 *  DELETE /preview            supprime les prévisualisations
 *  POST   /publish            publie le brouillon (sauvegarde + vérification)
 *  GET    /articles           liste des articles (fichier + adresse)
 *  POST   /articles/metas     métadonnées d'une page d'articles { files[] }
 *  GET    /article?path=      contenu d'un article + brouillon éventuel
 *  PUT    /article/draft      brouillon d'article { path, meta, content }
 *  DELETE /article/draft      abandonne le brouillon d'article
 *  POST   /article/publish    publie l'article { path }
 *  GET    /backups            sauvegardes disponibles
 *  POST   /backups/restore    restaure une sauvegarde { name }
 */
export function designRouter({ ssh, sites, audit, uploadLimit }) {
  const r = Router({ mergeParams: true });
  const canRead = requirePermission('design.read');
  const canEdit = requirePermission('design.edit');
  const canPublish = requirePermission('design.publish');
  r.use(requireServerAccess(ssh), requireConnection(ssh));

  const ctx = (req) => ({ id: req.params.id, domain: req.params.domain, user: req.user?.id });

  const audited = async (req, action, target, fn) => {
    try {
      const out = await fn();
      audit(req, { action, server: req.params.id, domain: req.params.domain, target, ok: true });
      return out;
    } catch (err) {
      audit(req, { action, server: req.params.id, domain: req.params.domain, target, ok: false, error: err.key ?? err.message });
      throw err;
    }
  };

  r.get('/', canRead, async (req, res) => {
    const { id, domain } = ctx(req);
    res.json(await sites.editorState(id, domain));
  });

  // ── Brouillon du site
  r.put('/draft', canEdit, async (req, res) => {
    const { id, domain, user } = ctx(req);
    const { config, style } = req.body ?? {};
    res.json(await audited(req, 'design.draft', 'site', () => sites.saveSiteDraft(id, domain, { config, style }, user)));
  });

  r.delete('/draft', canEdit, (req, res) => {
    const { id, domain } = ctx(req);
    res.json(sites.discardDraft(id, domain));
  });

  // ── Images du site
  /**
   * L'image arrive telle quelle dans le corps de la requête, comme pour le gestionnaire
   * de fichiers : ni formulaire multipart ni fichier temporaire côté back-office.
   */
  r.post('/images', canEdit, express.raw({ type: () => true, limit: uploadLimit }), async (req, res) => {
    const { id, domain } = ctx(req);
    const name = String(req.query.name ?? '');
    const out = await audited(req, 'design.image', name, () => sites.uploadImage(id, domain, { name, data: req.body }));
    res.status(201).json(out);
  });

  // ── Prévisualisation
  r.post('/preview', canEdit, async (req, res) => {
    const { id, domain, user } = ctx(req);
    const out = await audited(req, 'design.preview', req.body?.article ?? 'homepage', () =>
      sites.preview(id, domain, { article: req.body?.article, userId: user }),
    );
    res.json({ ...out, url: `/api/servers/${encodeURIComponent(id)}/domains/${encodeURIComponent(domain)}/design/preview/${out.id}.html` });
  });

  /**
   * Sert la prévisualisation. Le HTML vient d'un site tiers : il est déjà débarrassé de
   * ses scripts, et cette réponse interdit en plus toute exécution, en n'autorisant que
   * les styles, images et polices chargés depuis le site.
   */
  r.get('/preview/:previewId.html', canRead, (req, res) => {
    const { id, domain, user } = ctx(req);
    const html = sites.getPreview(req.params.previewId, { domain, userId: user });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src https: data:; style-src https: 'unsafe-inline'; font-src https: data:; script-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    );
    res.send(html);
  });

  // ── Publication
  r.post('/publish', canPublish, async (req, res) => {
    const { id, domain, user } = ctx(req);
    res.json(await audited(req, 'design.publish', 'site', () => sites.publish(id, domain, user)));
  });

  // ── Articles
  r.get('/articles', canRead, async (req, res) => {
    const { id, domain } = ctx(req);
    res.json({ articles: await sites.listArticles(id, domain) });
  });

  r.post('/articles/metas', canRead, async (req, res) => {
    const { id, domain } = ctx(req);
    res.json({ metas: await sites.articleMetas(id, domain, req.body?.files) });
  });

  r.get('/article', canRead, async (req, res) => {
    const { id, domain } = ctx(req);
    res.json(await sites.readArticle(id, domain, req.query.path));
  });

  r.put('/article/draft', canEdit, async (req, res) => {
    const { id, domain, user } = ctx(req);
    const { path, meta, content } = req.body ?? {};
    res.json(await audited(req, 'design.article_draft', path, () => sites.saveArticleDraft(id, domain, path, { meta, content }, user)));
  });

  r.delete('/article/draft', canEdit, (req, res) => {
    const { id, domain } = ctx(req);
    res.json(sites.discardDraft(id, domain, 'article', String(req.query.path ?? '')));
  });

  r.post('/article/publish', canPublish, async (req, res) => {
    const { id, domain, user } = ctx(req);
    res.json(await audited(req, 'design.article_publish', req.body?.path, () => sites.publishArticle(id, domain, req.body?.path, user)));
  });

  // ── Sauvegardes
  r.get('/backups', canRead, async (req, res) => {
    const { id, domain } = ctx(req);
    res.json({ backups: await sites.listBackups(id, domain) });
  });

  r.post('/backups/restore', canPublish, async (req, res) => {
    const { id, domain } = ctx(req);
    res.json(await audited(req, 'design.restore', req.body?.name, () => sites.restoreBackup(id, domain, req.body?.name)));
  });

  return r;
}

/**
 * Catalogue des composants et dictionnaire des agents : indépendants d'un serveur.
 *
 *  GET    /catalog              familles de blocs, présets, langues
 *  GET    /phrases              dictionnaire ajouté par les agents
 *  POST   /phrases              { source, lang, target }  ajoute ou met à jour
 *  DELETE /phrases/:id          retire une entrée
 */
export function designCatalogRouter({ audit } = {}) {
  const r = Router();
  r.get('/catalog', requirePermission('design.read'), (_req, res) => {
    res.json({ families: SECTION_FAMILIES, presets: PRESETS, langs: SITE_LANGS });
  });

  r.get('/phrases', requirePermission('design.read'), (_req, res) => {
    res.json({ phrases: listPhrases() });
  });

  r.post('/phrases', requirePermission('design.edit'), (req, res) => {
    const { source, lang, target } = req.body ?? {};
    const phrase = savePhrase({ source, lang, target, userId: req.user?.id });
    audit?.(req, { action: 'design.phrase', target: `${phrase.source} → ${phrase.target} (${phrase.lang})`, ok: true });
    res.status(201).json(phrase);
  });

  r.delete('/phrases/:id', requirePermission('design.edit'), (req, res) => {
    const removed = deletePhrase(req.params.id);
    audit?.(req, { action: 'design.phrase_delete', target: String(req.params.id), ok: removed });
    res.json({ removed });
  });

  return r;
}
