import { AppError } from '../errors.js';
import { config } from '../config.js';
import { hashPassword } from '../auth/password.js';
import { PROTECTED_ROLE, isPermission } from '../auth/permissions.js';
import { getDb } from './database.js';

/** Accès aux utilisateurs et aux rôles, règles métier comprises. */

const now = () => Date.now();
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/;

const bad = (key, vars) => new AppError(key, { status: 400, vars });

function assertUsername(username) {
  const u = String(username ?? '').trim();
  if (!USERNAME_RE.test(u)) throw bad('errors.user_name_invalid', { username: u.slice(0, 40) });
  return u;
}

export function assertPassword(password) {
  const p = String(password ?? '');
  if (p.length < config.passwordMinLength) throw bad('errors.password_too_short', { min: config.passwordMinLength });
  return p;
}

function assertPermissions(permissions) {
  const list = [...new Set(Array.isArray(permissions) ? permissions : [])];
  const unknown = list.find((p) => !isPermission(p));
  if (unknown) throw bad('errors.permission_unknown', { permission: String(unknown).slice(0, 60) });
  return list;
}

// ───────────────────────── Rôles ─────────────────────────

const roleRow = (row, permissions, users) => ({
  id: row.id,
  key: row.key,
  name: row.name,
  isSystem: Boolean(row.is_system),
  permissions,
  users,
});

export function listRoles() {
  const db = getDb();
  const roles = db.prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all();
  const perms = db.prepare('SELECT role_id, permission FROM role_permissions').all();
  const counts = db.prepare('SELECT role_id, COUNT(*) AS n FROM users GROUP BY role_id').all();
  const byRole = new Map(roles.map((r) => [r.id, []]));
  for (const p of perms) byRole.get(p.role_id)?.push(p.permission);
  const countBy = new Map(counts.map((c) => [c.role_id, c.n]));
  return roles.map((r) => roleRow(r, byRole.get(r.id) ?? [], countBy.get(r.id) ?? 0));
}

export function getRole(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!row) throw new AppError('errors.role_not_found', { status: 404 });
  const permissions = db.prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(id).map((p) => p.permission);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(id);
  return roleRow(row, permissions, n);
}

export function getRoleByKey(key) {
  const row = getDb().prepare('SELECT id FROM roles WHERE key = ?').get(String(key ?? ''));
  if (!row) throw new AppError('errors.role_not_found', { status: 404 });
  return getRole(row.id);
}

export function createRole({ key, name, permissions }) {
  const db = getDb();
  const roleKey = String(key ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(roleKey)) throw bad('errors.role_key_invalid', { key: roleKey.slice(0, 40) });
  const label = String(name ?? '').trim() || roleKey;
  const list = assertPermissions(permissions);
  if (db.prepare('SELECT 1 FROM roles WHERE key = ?').get(roleKey)) throw new AppError('errors.role_exists', { status: 409, vars: { key: roleKey } });

  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO roles (key, name, is_system) VALUES (?, ?, 0)').run(roleKey, label);
    const grant = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    for (const p of list) grant.run(lastInsertRowid, p);
    db.exec('COMMIT');
    return getRole(Number(lastInsertRowid));
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function updateRole(id, { name, permissions }) {
  const db = getDb();
  const role = getRole(id);
  // Les rôles d'origine sont resynchronisés au démarrage : les modifier n'aurait aucun effet durable.
  if (role.isSystem) throw new AppError('errors.role_system_readonly', { status: 403, vars: { name: role.name } });
  const list = permissions === undefined ? role.permissions : assertPermissions(permissions);

  db.exec('BEGIN');
  try {
    if (name !== undefined) db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(String(name).trim() || role.key, id);
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
    const grant = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    for (const p of list) grant.run(id, p);
    db.exec('COMMIT');
    return getRole(id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function deleteRole(id) {
  const db = getDb();
  const role = getRole(id);
  if (role.isSystem) throw new AppError('errors.role_system_readonly', { status: 403, vars: { name: role.name } });
  if (role.users > 0) throw new AppError('errors.role_in_use', { status: 409, vars: { name: role.name, count: role.users } });
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  return { id, name: role.name };
}

// ───────────────────────── Utilisateurs ─────────────────────────

const SELECT_USER = `
  SELECT u.*, r.key AS role_key, r.name AS role_name
  FROM users u JOIN roles r ON r.id = u.role_id
`;

function userRow(row, { servers, permissions } = {}) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    role: { id: row.role_id, key: row.role_key, name: row.role_name },
    isActive: Boolean(row.is_active),
    mustChangePassword: Boolean(row.must_change_password),
    scopeAllServers: Boolean(row.scope_all_servers),
    servers: servers ?? [],
    permissions: permissions ?? [],
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

const serversOf = (id) => getDb().prepare('SELECT server_id FROM user_servers WHERE user_id = ? ORDER BY server_id').all(id).map((r) => r.server_id);
const permissionsOf = (roleId) => getDb().prepare('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission').all(roleId).map((r) => r.permission);

export function listUsers() {
  const db = getDb();
  const rows = db.prepare(`${SELECT_USER} ORDER BY u.username`).all();
  const scopes = db.prepare('SELECT user_id, server_id FROM user_servers').all();
  const byUser = new Map();
  for (const s of scopes) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s.server_id]);
  return rows.map((row) => userRow(row, { servers: byUser.get(row.id) ?? [] }));
}

export function getUser(id) {
  const row = getDb().prepare(`${SELECT_USER} WHERE u.id = ?`).get(id);
  if (!row) throw new AppError('errors.user_not_found', { status: 404 });
  return userRow(row, { servers: serversOf(id), permissions: permissionsOf(row.role_id) });
}

export function findUserByUsername(username) {
  const row = getDb().prepare(`${SELECT_USER} WHERE u.username = ?`).get(String(username ?? '').trim());
  return row ? { ...userRow(row, { servers: serversOf(row.id), permissions: permissionsOf(row.role_id) }), passwordHash: row.password_hash, failedAttempts: row.failed_attempts } : null;
}

export const countUsers = () => getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;

const countActiveAdmins = (exceptId = 0) =>
  getDb()
    .prepare(`SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = ? AND u.is_active = 1 AND u.id <> ?`)
    .get(PROTECTED_ROLE, exceptId).n;

/** Empêche de se couper soi-même l'accès : il doit rester un administrateur actif. */
function assertNotLastAdmin(id) {
  if (countActiveAdmins(id) === 0) throw new AppError('errors.user_last_admin', { status: 409 });
}

function setServers(userId, servers) {
  const db = getDb();
  db.prepare('DELETE FROM user_servers WHERE user_id = ?').run(userId);
  const add = db.prepare('INSERT OR IGNORE INTO user_servers (user_id, server_id) VALUES (?, ?)');
  for (const s of new Set(servers ?? [])) add.run(userId, String(s).slice(0, 64));
}

export function createUser({ username, displayName = '', email = '', password, passwordHash, roleId, scopeAllServers = true, servers = [], mustChangePassword = true }) {
  const db = getDb();
  const name = assertUsername(username);
  // `passwordHash` sert à la reprise de l'ancien compte du fichier .env, déjà haché.
  if (!passwordHash) assertPassword(password);
  const role = getRole(roleId);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) throw new AppError('errors.user_exists', { status: 409, vars: { username: name } });

  const ts = now();
  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO users (username, display_name, email, password_hash, role_id, scope_all_servers, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, String(displayName).trim(), String(email).trim(), passwordHash ?? hashPassword(password), role.id, scopeAllServers ? 1 : 0, mustChangePassword ? 1 : 0, ts, ts);
    if (!scopeAllServers) setServers(Number(lastInsertRowid), servers);
    db.exec('COMMIT');
    return getUser(Number(lastInsertRowid));
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function updateUser(id, patch) {
  const db = getDb();
  const user = getUser(id);
  const sets = [];
  const values = [];

  if (patch.displayName !== undefined) (sets.push('display_name = ?'), values.push(String(patch.displayName).trim()));
  if (patch.email !== undefined) (sets.push('email = ?'), values.push(String(patch.email).trim()));
  if (patch.roleId !== undefined && patch.roleId !== user.role.id) {
    const role = getRole(patch.roleId);
    if (user.role.key === PROTECTED_ROLE && role.key !== PROTECTED_ROLE) assertNotLastAdmin(id);
    sets.push('role_id = ?');
    values.push(role.id);
  }
  if (patch.isActive !== undefined && Boolean(patch.isActive) !== user.isActive) {
    if (!patch.isActive) assertNotLastAdmin(id);
    sets.push('is_active = ?', 'failed_attempts = 0', 'locked_until = NULL');
    values.push(patch.isActive ? 1 : 0);
  }
  if (patch.scopeAllServers !== undefined) (sets.push('scope_all_servers = ?'), values.push(patch.scopeAllServers ? 1 : 0));

  db.exec('BEGIN');
  try {
    if (sets.length) {
      sets.push('updated_at = ?');
      values.push(now(), id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    if (patch.servers !== undefined) setServers(id, patch.servers);
    db.exec('COMMIT');
    return getUser(id);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function setUserPassword(id, password, { mustChange = false } = {}) {
  const db = getDb();
  getUser(id);
  assertPassword(password);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
    .run(hashPassword(password), mustChange ? 1 : 0, now(), id);
  return getUser(id);
}

export function deleteUser(id) {
  const db = getDb();
  const user = getUser(id);
  assertNotLastAdmin(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { id, username: user.username };
}

// ───────────────────────── Connexion ─────────────────────────

export function recordLoginSuccess(id) {
  getDb().prepare('UPDATE users SET last_login_at = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?').run(now(), id);
}

/** Verrouille temporairement le compte après trop d'échecs (freine le bourrage d'identifiants). */
export function recordLoginFailure(id) {
  const db = getDb();
  const attempts = (db.prepare('SELECT failed_attempts AS n FROM users WHERE id = ?').get(id)?.n ?? 0) + 1;
  const locked = attempts >= config.loginMaxAttempts ? now() + config.loginLockMinutes * 60_000 : null;
  db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, locked, id);
  return { attempts, lockedUntil: locked };
}
