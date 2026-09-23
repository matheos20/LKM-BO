import { Router } from 'express';
import { AppError } from '../errors.js';
import { requireConnection, requirePermission, requireServerAccess, visibleServers } from '../middleware/index.js';
import { queryItems } from '../services/domainService.js';

/**
 *  GET    /api/servers                          liste + état des connexions
 *  POST   /api/servers/:id/connect              ouvre la session SSH
 *  POST   /api/servers/:id/disconnect           ferme la session SSH
 *  GET    /api/servers/:id/domains              Read   (liste paginée : q, status, sort, page, size, refresh)
 *  POST   /api/servers/:id/domains              Create { domain }
 *  GET    /api/servers/:id/domains/:domain      Read   (détails)
 *  PATCH  /api/servers/:id/domains/:domain      Update { action: lock | unlock | fixPerms }
 *  DELETE /api/servers/:id/domains/:domain      Delete { confirm: <domaine> }
 */
export function serversRouter({ ssh, domains, audit }) {
  const r = Router();
  const conn = requireConnection(ssh);
  const access = requireServerAccess(ssh);
  const canConnect = requirePermission('servers.connect');
  const canRead = requirePermission('domains.read');
  const canCreate = requirePermission('domains.create');
  const canDelete = requirePermission('domains.delete');

  // Une action n'est proposée que si le compte SSH la permet ET que l'utilisateur y a droit.
  const PERMISSION_OF = { create: 'domains.create', delete: 'domains.delete', fixPerms: 'domains.fix_perms', lock: 'domains.lock', unlock: 'domains.lock' };
  const allowed = (req, caps) =>
    Object.fromEntries(
      Object.entries(caps).map(([action, cap]) => [action, req.user.permissions.has(PERMISSION_OF[action]) ? cap : { ok: false, reason: 'permission_denied' }]),
    );

  const view = (req, s) => {
    const st = ssh.status(s.id);
    const cache = domains.cached(s.id);
    return {
      id: s.id,
      label: s.label,
      group: s.group,
      host: s.host,
      port: s.port,
      username: s.username,
      authType: s.auth.type,
      lockop: Boolean(s.lockop),
      state: st.state,
      error: st.error ? req.t(st.error.key, st.error.vars) : null,
      fingerprint: st.fingerprint,
      connectedAt: st.connectedAt,
      capabilities: allowed(req, domains.capabilities(s.id)),
      domainCount: cache?.stats.total ?? null,
      cachedAt: cache?.at ?? null,
    };
  };

  const audited = async (req, action, domain, fn) => {
    try {
      const out = await fn();
      audit(req, { action, server: req.params.id, domain: out?.domain ?? domain, ok: true });
      return out;
    } catch (err) {
      audit(req, { action, server: req.params.id, domain: String(domain ?? '').slice(0, 253), ok: false, error: err.key ?? err.message });
      throw err;
    }
  };

  r.get('/', (req, res) => {
    res.json({ servers: visibleServers(req.user, ssh.list()).map((s) => view(req, s)) });
  });

  r.post('/:id/connect', canConnect, access, async (req, res) => {
    const s = ssh.server(req.params.id);
    await audited(req, 'connect', null, async () => {
      await ssh.connect(s.id);
      await domains.probe(s.id).catch((err) => console.warn(`[sudo] ${s.id}: ${err.message}`));
    });
    res.json(view(req, s));
  });

  r.post('/:id/disconnect', canConnect, access, (req, res) => {
    const s = ssh.server(req.params.id);
    ssh.disconnect(s.id);
    domains.forget(s.id);
    audit(req, { action: 'disconnect', server: s.id, ok: true });
    res.json(view(req, s));
  });

  r.get('/:id/domains', access, canRead, conn, async (req, res) => {
    const entry = await domains.list(req.params.id, { refresh: req.query.refresh === '1' });
    res.json({ ...queryItems(entry.items, req.query), stats: entry.stats, cachedAt: entry.at });
  });

  /**
   * Noms seuls, sans pagination : un traitement de masse (analyse de langue) doit
   * connaître d'un coup les domaines du serveur, là où le tableau en affiche 50.
   */
  r.get('/:id/domain-names', access, canRead, conn, async (req, res) => {
    const entry = await domains.list(req.params.id, {});
    res.json({ domains: entry.items.map((d) => d.name), cachedAt: entry.at });
  });

  r.post('/:id/domains', access, canCreate, conn, async (req, res) => {
    const domain = req.body?.domain;
    res.status(201).json(await audited(req, 'create', domain, () => domains.create(req.params.id, domain)));
  });

  r.get('/:id/domains/:domain', access, canRead, conn, async (req, res) => {
    res.json(await domains.details(req.params.id, req.params.domain));
  });

  r.patch('/:id/domains/:domain', access, conn, async (req, res) => {
    const action = req.body?.action;
    // lock / unlock et « réparer les droits » relèvent de permissions distinctes.
    const needed = PERMISSION_OF[action];
    if (!needed || !req.user.permissions.has(needed)) {
      throw new AppError('errors.forbidden', { status: 403, vars: { permission: needed ? `@perm.${needed}` : String(action).slice(0, 40) } });
    }
    res.json(await audited(req, action, req.params.domain, () => domains.update(req.params.id, req.params.domain, action)));
  });

  r.delete('/:id/domains/:domain', access, canDelete, conn, async (req, res) => {
    res.json(await audited(req, 'delete', req.params.domain, () => domains.remove(req.params.id, req.params.domain, req.body?.confirm)));
  });

  return r;
}
