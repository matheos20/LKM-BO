import { Router } from 'express';
import { AppError } from '../errors.js';
import { PERMISSION_GROUPS, PERMISSIONS } from '../auth/permissions.js';
import { requirePermission } from '../middleware/index.js';
import {
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  getUser,
  listRoles,
  listUsers,
  setUserPassword,
  updateRole,
  updateUser,
} from '../db/repositories.js';
import { revokeUserSessions } from '../db/sessionStore.js';

/**
 * Administration des comptes et des rôles (permission « users.manage »).
 *
 *  GET    /permissions           catalogue des permissions
 *  GET    /roles                 rôles + permissions + nombre de comptes
 *  POST   /roles                 création d'un rôle personnalisé
 *  PATCH  /roles/:id             renommage / permissions d'un rôle personnalisé
 *  DELETE /roles/:id             suppression d'un rôle inutilisé
 *  GET    /users                 comptes
 *  POST   /users                 création
 *  PATCH  /users/:id             modification (rôle, portée, activation…)
 *  POST   /users/:id/password    réinitialisation du mot de passe
 *  DELETE /users/:id             suppression
 */
export function adminRouter({ audit, ssh }) {
  const r = Router();
  r.use(requirePermission('users.manage'));

  const id = (req) => Number.parseInt(req.params.id, 10);

  /** Une portée limitée ne peut désigner que des serveurs réellement déclarés. */
  const checkServers = (servers) => {
    if (servers === undefined) return undefined;
    const known = new Set(ssh.list().map((s) => s.id));
    const list = [...new Set(servers ?? [])].map(String);
    const unknown = list.find((s) => !known.has(s));
    if (unknown) throw new AppError('errors.server_unknown', { status: 400, vars: { server: unknown.slice(0, 40) } });
    return list;
  };

  const audited = (req, action, target, fn) => {
    try {
      const out = fn();
      audit(req, { action, target, ok: true });
      return out;
    } catch (err) {
      audit(req, { action, target, ok: false, error: err.key ?? err.message });
      throw err;
    }
  };

  // ── Catalogue et rôles
  r.get('/permissions', (_req, res) => res.json({ permissions: PERMISSIONS, groups: PERMISSION_GROUPS }));
  r.get('/roles', (_req, res) => res.json({ roles: listRoles() }));

  r.post('/roles', (req, res) => {
    const { key, name, permissions } = req.body ?? {};
    res.status(201).json(audited(req, 'role.create', key, () => createRole({ key, name, permissions })));
  });

  r.patch('/roles/:id', (req, res) => {
    const { name, permissions } = req.body ?? {};
    res.json(audited(req, 'role.update', req.params.id, () => updateRole(id(req), { name, permissions })));
  });

  r.delete('/roles/:id', (req, res) => {
    res.json(audited(req, 'role.delete', req.params.id, () => deleteRole(id(req))));
  });

  // ── Comptes
  r.get('/users', (_req, res) => res.json({ users: listUsers() }));

  r.post('/users', (req, res) => {
    const { username, displayName, email, password, roleId, scopeAllServers, servers, mustChangePassword } = req.body ?? {};
    const out = audited(req, 'user.create', username, () =>
      createUser({
        username,
        displayName,
        email,
        password,
        roleId,
        scopeAllServers: scopeAllServers !== false,
        servers: checkServers(servers) ?? [],
        mustChangePassword: mustChangePassword !== false,
      }),
    );
    res.status(201).json(out);
  });

  r.patch('/users/:id', (req, res) => {
    const target = id(req);
    const patch = req.body ?? {};
    // On ne se retire pas soi-même l'accès par inadvertance.
    if (target === req.user.id && patch.isActive === false) throw new AppError('errors.user_self_disable', { status: 409 });
    if (target === req.user.id && patch.roleId !== undefined && patch.roleId !== req.user.role.id) {
      throw new AppError('errors.user_self_role', { status: 409 });
    }
    const before = getUser(target);
    const updated = audited(req, 'user.update', before.username, () =>
      updateUser(target, { ...patch, servers: checkServers(patch.servers) }),
    );
    // Droits modifiés : les sessions ouvertes doivent refléter le changement sans délai.
    const changed = updated.role.id !== before.role.id || updated.isActive !== before.isActive || updated.scopeAllServers !== before.scopeAllServers;
    if (changed) revokeUserSessions(target);
    res.json(updated);
  });

  r.post('/users/:id/password', (req, res) => {
    const target = id(req);
    const user = getUser(target);
    const out = audited(req, 'user.password', user.username, () =>
      setUserPassword(target, req.body?.password, { mustChange: req.body?.mustChangePassword !== false }),
    );
    revokeUserSessions(target);
    res.json(out);
  });

  r.delete('/users/:id', (req, res) => {
    const target = id(req);
    if (target === req.user.id) throw new AppError('errors.user_self_delete', { status: 409 });
    const out = audited(req, 'user.delete', getUser(target).username, () => deleteUser(target));
    revokeUserSessions(target);
    res.json(out);
  });

  return r;
}
