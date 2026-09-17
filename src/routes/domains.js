import { Router } from 'express';
import { AppError } from '../errors.js';
import { computeStats, queryItems } from '../services/domainService.js';
import { requirePermission, visibleServers } from '../middleware/index.js';

/** GET /api/domains — vue agrégée « Tous les serveurs » (serveurs connectés uniquement). */
export function domainsRouter({ ssh, domains }) {
  const r = Router();

  r.get('/', requirePermission('domains.read'), async (req, res) => {
    // Vue agrégée limitée aux serveurs autorisés pour ce compte.
    const ids = visibleServers(req.user, ssh.list()).filter((s) => ssh.isConnected(s.id)).map((s) => s.id);
    const results = await Promise.allSettled(ids.map((id) => domains.list(id, { refresh: req.query.refresh === '1' })));

    let items = [];
    const failed = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') items = items.concat(result.value.items);
      else {
        const err = result.reason;
        failed.push({ server: ids[i], message: err instanceof AppError ? req.t(err.key, err.vars) : String(err?.message) });
      }
    });

    res.json({ ...queryItems(items, req.query), stats: computeStats(items), servers: ids, failed });
  });

  return r;
}
