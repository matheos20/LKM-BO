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
 *
 * CES ROUTES NE SERVENT QUE L'ÉCRAN « ACTIONS », et travaillent sur des milliers de
 * sites à la fois. Elles exigent donc, EN PLUS du droit de design correspondant, celui
 * des traitements de masse : « bulk.read » pour ce qui analyse, « bulk.apply » pour ce
 * qui écrit. Publier la page d'un site et relancer une tournée sur tout un VPS ne sont
 * pas le même geste, et ne doivent pas se confier d'un seul clic.
 */
export function categoriesRouter({ ssh, categories, audit }) {
  const r = Router({ mergeParams: true });
  r.use(requireServerAccess(ssh), requireConnection(ssh));

  r.post('/existing', requirePermission('bulk.read'), requirePermission('design.read'), async (req, res) => {
    res.json(await categories.existing(req.params.id, req.body?.domains));
  });

  r.post('/plan', requirePermission('bulk.read'), requirePermission('design.read'), async (req, res) => {
    res.json(await categories.plan(req.params.id, req.body?.request, { operation: req.body?.operation }));
  });

  r.post('/apply', requirePermission('bulk.apply'), requirePermission('design.publish'), async (req, res) => {
    const demande = req.body?.request ?? {};
    const demande_op = String(req.body?.operation ?? '');
    const operation = demande_op === 'remove' ? 'remove' : 'add';
    // REMETTRE UNE RUBRIQUE EST UN AJOUT, mais ce n'est pas une création : la rubrique
    // revient avec son icône, sa description et son rang. Le traitement est le même ;
    // le JOURNAL, lui, doit les distinguer — « on a recréé » et « on a remis ce qu'on
    // venait d'enlever » ne racontent pas la même histoire à qui relit la trace.
    const journal = demande_op === 'restore' ? 'restore' : operation;
    const domaines = Object.keys(demande);
    try {
      const out = await categories.apply(req.params.id, demande, req.user?.id, { operation });
      const touchees = out.sites.reduce((n, s) => n + s.items.filter((i) => i.done.length).length, 0);
      audit(req, { action: `categories.${journal}`, server: req.params.id, domain: domaines.join(', ').slice(0, 253), target: `${touchees} rubrique(s)`, ok: true });
      res.json(out);
    } catch (err) {
      audit(req, { action: `categories.${journal}`, server: req.params.id, domain: domaines.join(', ').slice(0, 253), ok: false, error: err.key ?? err.message });
      throw err;
    }
  });

  return r;
}
