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
 *
 * L'analyse ne demande que le droit de lecture du design ; l'écriture demande le droit
 * de publier, comme toute modification qui atteint la production.
 */
export function translationRouter({ ssh, translation, audit }) {
  const r = Router({ mergeParams: true });
  r.use(requireServerAccess(ssh), requireConnection(ssh));

  r.get('/status', requirePermission('design.read'), (_req, res) => {
    res.json({ machine: translation.machineAvailable, langs: LANGS });
  });

  r.post('/scan', requirePermission('design.read'), async (req, res) => {
    const { domains, minScore } = req.body ?? {};
    res.json(await translation.scan(req.params.id, domains, { minScore }));
  });

  r.post('/translate', requirePermission('design.edit'), async (req, res) => {
    const { texts, from, to } = req.body ?? {};
    res.json(await translation.translate(texts, { from, to }));
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
