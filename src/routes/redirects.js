import { Router } from 'express';
import { requireConnection, requirePermission, requireServerAccess } from '../middleware/index.js';

/**
 * Redirections 301, monté sous /api/servers/:id/redirects
 *
 *  POST /existing { domains }              ce qui est en place — LECTURE SEULE
 *  POST /plan     { request, operation }   ce que la demande changerait — LECTURE SEULE
 *  POST /apply    { request, operation }   écrit dans le .htaccess
 *
 * `operation` vaut « add » (défaut) ou « remove ».
 * `request` associe un domaine à ses règles, avec la somme de contrôle du fichier
 * vue à la vérification : { "exemple.com": { md5, rules: [{ from, to }] } }.
 *
 * Lire demande `design.read` ; écrire demande `design.publish`, comme toute écriture
 * qui atteint la production. Le `.htaccess` porte tout le routage d'un site : une
 * règle posée là se voit immédiatement par les visiteurs.
 */
export function redirectsRouter({ ssh, redirects, audit }) {
  const r = Router({ mergeParams: true });
  r.use(requireServerAccess(ssh), requireConnection(ssh));

  r.post('/existing', requirePermission('design.read'), async (req, res) => {
    res.json(await redirects.existing(req.params.id, req.body?.domains));
  });

  r.post('/plan', requirePermission('design.read'), async (req, res) => {
    res.json(await redirects.plan(req.params.id, req.body?.request, { operation: req.body?.operation }));
  });

  r.post('/apply', requirePermission('design.publish'), async (req, res) => {
    const demande = req.body?.request ?? {};
    const operation = req.body?.operation === 'remove' ? 'remove' : 'add';
    const domaines = Object.keys(demande);
    try {
      const out = await redirects.apply(req.params.id, demande, { operation });
      const posees = out.sites.reduce((n, s) => n + s.items.filter((i) => i.done.length).length, 0);
      audit(req, {
        action: `redirects.${operation}`,
        server: req.params.id,
        domain: domaines.join(', ').slice(0, 253),
        target: `${posees} redirection(s)`,
        ok: true,
      });
      res.json(out);
    } catch (err) {
      audit(req, { action: `redirects.${operation}`, server: req.params.id, domain: domaines.join(', ').slice(0, 253), ok: false, error: err.key ?? err.message });
      throw err;
    }
  });

  return r;
}
