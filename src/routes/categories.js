import { Router } from 'express';
import { requireConnection, requirePermission, requireServerAccess } from '../middleware/index.js';

/**
 * Ajout de rubriques, monté sous /api/servers/:id/categories
 *
 *  POST /plan   { request }   ce qui existe déjà, ce qui serait créé — LECTURE SEULE
 *  POST /apply  { request }   crée les dossiers, déclare les rubriques, met à jour le résumé
 *
 * `request` associe un domaine à ses rubriques : { "exemple.com": [{ name: "Sport" }] }.
 * Vérifier ne demande que le droit de lecture ; créer demande celui de publier, comme
 * toute écriture qui atteint la production.
 */
export function categoriesRouter({ ssh, categories, audit }) {
  const r = Router({ mergeParams: true });
  r.use(requireServerAccess(ssh), requireConnection(ssh));

  r.post('/plan', requirePermission('design.read'), async (req, res) => {
    res.json(await categories.plan(req.params.id, req.body?.request));
  });

  r.post('/apply', requirePermission('design.publish'), async (req, res) => {
    const demande = req.body?.request ?? {};
    const domaines = Object.keys(demande);
    try {
      const out = await categories.apply(req.params.id, demande, req.user?.id);
      const creees = out.sites.reduce((n, s) => n + s.items.filter((i) => i.done.length).length, 0);
      audit(req, { action: 'categories.add', server: req.params.id, domain: domaines.join(', ').slice(0, 253), target: `${creees} rubrique(s)`, ok: true });
      res.json(out);
    } catch (err) {
      audit(req, { action: 'categories.add', server: req.params.id, domain: domaines.join(', ').slice(0, 253), ok: false, error: err.key ?? err.message });
      throw err;
    }
  });

  return r;
}
