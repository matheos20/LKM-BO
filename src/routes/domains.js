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

  /**
   * POST /api/domains/resolve { domains[] } — où se trouve chacun de ces domaines ?
   *
   * Un agent colle une liste venue d'un tableur : elle mélange les serveurs, et
   * contient des noms mal orthographiés. Plutôt que de télécharger les 29 000 noms
   * du parc dans le navigateur, la recherche se fait ici, sur les listes déjà en cache.
   * Les serveurs non connectés sont signalés : c'est la première raison pour laquelle
   * un domaine bien réel reste introuvable.
   */
  r.post('/resolve', requirePermission('domains.read'), async (req, res) => {
    const asked = Array.isArray(req.body?.domains) ? req.body.domains : [];
    const wanted = [...new Set(asked.map((d) => String(d ?? '').trim().toLowerCase()).filter(Boolean))].slice(0, 1000);

    const visible = visibleServers(req.user, ssh.list());
    const connected = visible.filter((s) => ssh.isConnected(s.id));
    const results = await Promise.allSettled(connected.map((s) => domains.list(s.id, {})));

    const index = new Map();
    results.forEach((result, i) => {
      if (result.status !== 'fulfilled') return;
      for (const item of result.value.items) if (!index.has(item.name)) index.set(item.name, connected[i].id);
    });

    const found = [];
    const unknown = [];
    for (const name of wanted) {
      const server = index.get(name);
      if (server) found.push({ domain: name, server });
      else unknown.push(name);
    }

    res.json({
      found,
      unknown,
      // Ce que l'interface doit pouvoir dire : « vps-002 n'est pas connecté ».
      offline: visible.filter((s) => !ssh.isConnected(s.id)).map((s) => ({ id: s.id, label: s.label })),
    });
  });

  return r;
}
