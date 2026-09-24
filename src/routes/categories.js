import { Router } from 'express';
import { requireConnection, requirePermission, requireServerAccess } from '../middleware/index.js';

/**
 * Ajout de rubriques, monté sous /api/servers/:id/categories
 *
 *  POST /existing { domains }            les rubriques en place sur ces sites — LECTURE SEULE
 *  POST /plan   { request, operation }   ce qui existe déjà, ce qui changerait — LECTURE SEULE
 *  POST /apply  { request, operation }   crée ou retire les rubriques
 *
 * `operation` vaut « add » (défaut) ou « remove ».
 *
 * `request` associe un domaine à ses rubriques : { "exemple.com": [{ name: "Sport" }] }.
 * Vérifier ne demande que le droit de lecture ; créer demande celui de publier, comme
 * toute écriture qui atteint la production.
 */
export function categoriesRouter({ ssh, categories, audit }) {
  const r = Router({ mergeParams: true });
  r.use(requireServerAccess(ssh), requireConnection(ssh));

  r.post('/existing', requirePermission('design.read'), async (req, res) => {
    res.json(await categories.existing(req.params.id, req.body?.domains));
  });

  r.post('/plan', requirePermission('design.read'), async (req, res) => {
    res.json(await categories.plan(req.params.id, req.body?.request, { operation: req.body?.operation }));
  });

  r.post('/apply', requirePermission('design.publish'), async (req, res) => {
    const demande = req.body?.request ?? {};
    const operation = req.body?.operation === 'remove' ? 'remove' : 'add';
    const domaines = Object.keys(demande);
    try {
      const out = await categories.apply(req.params.id, demande, req.user?.id, { operation });
      const touchees = out.sites.reduce((n, s) => n + s.items.filter((i) => i.done.length).length, 0);
      audit(req, { action: `categories.${operation}`, server: req.params.id, domain: domaines.join(', ').slice(0, 253), target: `${touchees} rubrique(s)`, ok: true });
      res.json(out);
    } catch (err) {
      audit(req, { action: `categories.${operation}`, server: req.params.id, domain: domaines.join(', ').slice(0, 253), ok: false, error: err.key ?? err.message });
      throw err;
    }
  });

  return r;
}
