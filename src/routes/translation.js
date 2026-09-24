import { Router } from 'express';
import { requireConnection, requirePermission, requireServerAccess } from '../middleware/index.js';
import { LANGS } from '../services/langTools.js';

/**
 * Traduction des pages d'accueil, montée sous /api/servers/:id/translation
 *
 *  GET  /status      moyens disponibles : traduction automatique, langues reconnues
 *  POST /scan        { domains[] }                 analyse un lot (lecture seule)
 *  POST /translate   { texts[], from, to }         propositions de traduction
 *  POST /apply       { domain, changes[] }         écrit les textes retenus
 *  POST /templates   { domains[] }                 gabarits : repérage (lecture seule)
 *  POST /templates/apply { changes }               gabarits : écriture des corrections
 *
 * L'analyse ne demande que le droit de lecture du design ; l'écriture demande le droit
 * de publier, comme toute modification qui atteint la production.
 */
export function translationRouter({ ssh, translation, audit }) {
  const r = Router({ mergeParams: true });
  r.use(requireServerAccess(ssh), requireConnection(ssh));

  r.get('/status', requirePermission('design.read'), (_req, res) => {
    res.json({ machine: translation.machineAvailable, provider: translation.providerName, langs: LANGS });
  });

  r.post('/scan', requirePermission('design.read'), async (req, res) => {
    const { domains, minScore } = req.body ?? {};
    res.json(await translation.scan(req.params.id, domains, { minScore }));
  });

  r.post('/translate', requirePermission('design.edit'), async (req, res) => {
    const { texts, from, to } = req.body ?? {};
    res.json(await translation.translate(texts, { from, to }));
  });

  r.post('/templates', requirePermission('design.read'), async (req, res) => {
    res.json(await translation.templates(req.params.id, req.body?.domains));
  });

  /**
   * Les gabarits sont écrits fichier par fichier, comme le ferait un éditeur : pas de
   * brouillon ni de md5 d'ensemble, mais une sauvegarde et un contrôle de syntaxe par
   * fichier, côté serveur.
   */
  r.post('/templates/apply', requirePermission('design.publish'), async (req, res) => {
    const { changes } = req.body ?? {};
    const domains = Object.keys(changes ?? {});
    try {
      const out = await translation.templates(req.params.id, domains, { apply: true, changes });
      const ecrits = out.sites.reduce((n, s) => n + s.written.length, 0);
      audit(req, { action: 'translate.templates', server: req.params.id, domain: domains.join(', ').slice(0, 253), target: `${ecrits} fichier(s)`, ok: true });
      res.json(out);
    } catch (err) {
      audit(req, { action: 'translate.templates', server: req.params.id, domain: domains.join(', ').slice(0, 253), ok: false, error: err.key ?? err.message });
      throw err;
    }
  });

  r.post('/apply', requirePermission('design.publish'), async (req, res) => {
    const { domain, changes } = req.body ?? {};
    const target = String(domain ?? '');
    try {
      const out = await translation.apply(req.params.id, target, changes, req.user?.id);
      audit(req, { action: 'translate.apply', server: req.params.id, domain: target, target: `${out.applied.length} texte(s)`, ok: true });
      res.json(out);
    } catch (err) {
      audit(req, { action: 'translate.apply', server: req.params.id, domain: target, ok: false, error: err.key ?? err.message });
      throw err;
    }
  });

  return r;
}
