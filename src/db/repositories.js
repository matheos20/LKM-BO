import { AppError } from '../errors.js';
import { config } from '../config.js';
import { hashPassword } from '../auth/password.js';
import { PROTECTED_ROLE, isPermission } from '../auth/permissions.js';
import { prepare, transaction } from './mysql.js';

/**
 * Accès aux utilisateurs et aux rôles, règles métier comprises.
 *
 * TOUT EST ASYNCHRONE ICI, et c'est le changement qui coûte. SQLite répondait dans
 * l'instant ; MySQL passe par le réseau, fût-il local. Chaque fonction rend donc une
 * promesse, et l'attente remonte jusqu'aux routes.
 *
 * Deux pièges du dialecte, qu'on ne voit qu'à l'exécution :
 *   - « key » est un mot réservé de MySQL : il s'écrit entre accents graves ;
 *   - « INSERT OR IGNORE » devient « INSERT IGNORE ».
 */

const now = () => Date.now();
/**
 * Ce qu'un identifiant de connexion a le droit d'être.
 *
 * L'arobase y est admise, et la longueur va jusqu'à 64 caractères : une adresse de
 * courriel est un identifiant parfaitement légitime, et c'est souvent elle que
 * l'administrateur a sous la main au moment de créer le compte. La règle précédente la
 * refusait — « good@gmail.com » n'entrait pas — sans rien apporter en échange.
 *
 * Ce champ ne part jamais dans une commande : il voyage en paramètre lié jusqu'à la base
 * et s'affiche dans l'interface. Le jeu de caractères est donc borné pour rester lisible,
 * pas pour se protéger d'une injection.
 */
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@-]{2,63}$/;

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

export async function listRoles() {
  const [roles, perms, counts] = await Promise.all([
    prepare('SELECT * FROM roles ORDER BY is_system DESC, name').all(),
    prepare('SELECT role_id, permission FROM role_permissions').all(),
    prepare('SELECT role_id, COUNT(*) AS n FROM users GROUP BY role_id').all(),
  ]);
  const byRole = new Map(roles.map((r) => [r.id, []]));
  for (const p of perms) byRole.get(p.role_id)?.push(p.permission);
  const countBy = new Map(counts.map((c) => [c.role_id, Number(c.n)]));
  return roles.map((r) => roleRow(r, byRole.get(r.id) ?? [], countBy.get(r.id) ?? 0));
}

export async function getRole(id) {
  const row = await prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!row) throw new AppError('errors.role_not_found', { status: 404 });
  const [perms, compte] = await Promise.all([
    prepare('SELECT permission FROM role_permissions WHERE role_id = ?').all(id),
    prepare('SELECT COUNT(*) AS n FROM users WHERE role_id = ?').get(id),
  ]);
  return roleRow(row, perms.map((p) => p.permission), Number(compte.n));
}

export async function getRoleByKey(key) {
  const row = await prepare('SELECT id FROM roles WHERE `key` = ?').get(String(key ?? ''));
  if (!row) throw new AppError('errors.role_not_found', { status: 404 });
  return getRole(row.id);
}

export async function createRole({ key, name, permissions }) {
  const roleKey = String(key ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(roleKey)) throw bad('errors.role_key_invalid', { key: roleKey.slice(0, 40) });
  const label = String(name ?? '').trim() || roleKey;
  const list = assertPermissions(permissions);
  if (await prepare('SELECT 1 AS x FROM roles WHERE `key` = ?').get(roleKey)) {
    throw new AppError('errors.role_exists', { status: 409, vars: { key: roleKey } });
  }

  const id = await transaction(async (tx) => {
    const { lastInsertRowid } = await tx.prepare('INSERT INTO roles (`key`, name, is_system) VALUES (?, ?, 0)').run(roleKey, label);
    for (const p of list) await tx.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').run(lastInsertRowid, p);
    return Number(lastInsertRowid);
  });
  return getRole(id);
}

export async function updateRole(id, { name, permissions }) {
  const role = await getRole(id);
  // Les rôles d'origine sont resynchronisés au démarrage : les modifier n'aurait aucun effet durable.
  if (role.isSystem) throw new AppError('errors.role_system_readonly', { status: 403, vars: { name: role.name } });
  const list = permissions === undefined ? role.permissions : assertPermissions(permissions);

  await transaction(async (tx) => {
    if (name !== undefined) await tx.prepare('UPDATE roles SET name = ? WHERE id = ?').run(String(name).trim() || role.key, id);
    await tx.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
    for (const p of list) await tx.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').run(id, p);
  });
  return getRole(id);
}

export async function deleteRole(id) {
  const role = await getRole(id);
  if (role.isSystem) throw new AppError('errors.role_system_readonly', { status: 403, vars: { name: role.name } });
  if (role.users > 0) throw new AppError('errors.role_in_use', { status: 409, vars: { name: role.name, count: role.users } });
  await prepare('DELETE FROM roles WHERE id = ?').run(id);
  return { id, name: role.name };
}

// ───────────────────────── Utilisateurs ─────────────────────────

const SELECT_USER = `
  SELECT u.*, r.\`key\` AS role_key, r.name AS role_name
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
    lockedUntil: row.locked_until == null ? null : Number(row.locked_until),
    lastLoginAt: row.last_login_at == null ? null : Number(row.last_login_at),
    createdAt: Number(row.created_at),
  };
}

const serversOf = async (id) =>
  (await prepare('SELECT server_id FROM user_servers WHERE user_id = ? ORDER BY server_id').all(id)).map((r) => r.server_id);

const permissionsOf = async (roleId) =>
  (await prepare('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission').all(roleId)).map((r) => r.permission);

export async function listUsers() {
  const [rows, scopes] = await Promise.all([
    prepare(`${SELECT_USER} ORDER BY u.username`).all(),
    prepare('SELECT user_id, server_id FROM user_servers').all(),
  ]);
  const byUser = new Map();
  for (const s of scopes) byUser.set(s.user_id, [...(byUser.get(s.user_id) ?? []), s.server_id]);
  return rows.map((row) => userRow(row, { servers: byUser.get(row.id) ?? [] }));
}

export async function getUser(id) {
  const row = await prepare(`${SELECT_USER} WHERE u.id = ?`).get(id);
  if (!row) throw new AppError('errors.user_not_found', { status: 404 });
  const [servers, permissions] = await Promise.all([serversOf(id), permissionsOf(row.role_id)]);
  return userRow(row, { servers, permissions });
}

/** Le compte, ses droits et son empreinte de mot de passe, à partir d'une ligne lue. */
async function userComplet(row) {
  const [servers, permissions] = await Promise.all([serversOf(row.id), permissionsOf(row.role_id)]);
  return {
    ...userRow(row, { servers, permissions }),
    passwordHash: row.password_hash,
    failedAttempts: Number(row.failed_attempts),
  };
}

export async function findUserByUsername(username) {
  const row = await prepare(`${SELECT_USER} WHERE u.username = ?`).get(String(username ?? '').trim());
  return row ? userComplet(row) : null;
}

/**
 * Le compte derrière ce qu'on a tapé pour se connecter : son identifiant, OU son adresse.
 *
 * L'administrateur crée un compte, remplit l'adresse de l'agent, et c'est elle qu'il lui
 * communique — c'est ce qu'il a sous la main. L'agent la tapait donc pour entrer, et se
 * voyait refuser sans comprendre : seul l'identifiant était accepté, et rien ne le disait.
 *
 * L'identifiant passe en premier : il est unique par construction, l'adresse ne l'est
 * pas. Si deux comptes partagent une adresse, on ne devine pas lequel est visé — on le
 * dit, et l'agent se connecte avec son identifiant.
 *
 * @returns {{ user: object|null, reason?: 'ambiguous' }}
 */
export async function findUserByLogin(login) {
  const saisi = String(login ?? '').trim();
  if (!saisi) return { user: null };

  const parIdentifiant = await prepare(`${SELECT_USER} WHERE u.username = ?`).get(saisi);
  if (parIdentifiant) return { user: await userComplet(parIdentifiant) };

  // Une adresse vide ne désigne personne : la plupart des comptes n'en ont pas.
  if (!saisi.includes('@')) return { user: null };
  const parAdresse = await prepare(`${SELECT_USER} WHERE u.email = ? AND u.email <> ''`).all(saisi);
  if (parAdresse.length > 1) return { user: null, reason: 'ambiguous' };
  return { user: parAdresse.length ? await userComplet(parAdresse[0]) : null };
}

export const countUsers = async () => Number((await prepare('SELECT COUNT(*) AS n FROM users').get()).n);

const countActiveAdmins = async (exceptId = 0) =>
  Number((await prepare(
    'SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.`key` = ? AND u.is_active = 1 AND u.id <> ?',
  ).get(PROTECTED_ROLE, exceptId)).n);

/** Empêche de se couper soi-même l'accès : il doit rester un administrateur actif. */
async function assertNotLastAdmin(id) {
  if ((await countActiveAdmins(id)) === 0) throw new AppError('errors.user_last_admin', { status: 409 });
}

/** Remplace la liste des serveurs d'un compte, dans la transaction fournie. */
async function setServers(tx, userId, servers) {
  await tx.prepare('DELETE FROM user_servers WHERE user_id = ?').run(userId);
  for (const s of new Set(servers ?? [])) {
    await tx.prepare('INSERT IGNORE INTO user_servers (user_id, server_id) VALUES (?, ?)').run(userId, String(s).slice(0, 60));
  }
}

export async function createUser({ username, displayName = '', email = '', password, passwordHash, roleId, scopeAllServers = true, servers = [], mustChangePassword = true }) {
  const name = assertUsername(username);
  // `passwordHash` sert à la reprise de l'ancien compte du fichier .env, déjà haché.
  if (!passwordHash) assertPassword(password);
  const role = await getRole(roleId);
  if (await prepare('SELECT 1 AS x FROM users WHERE username = ?').get(name)) {
    throw new AppError('errors.user_exists', { status: 409, vars: { username: name } });
  }

  const ts = now();
  const id = await transaction(async (tx) => {
    const { lastInsertRowid } = await tx.prepare(
      `INSERT INTO users (username, display_name, email, password_hash, role_id, scope_all_servers, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, String(displayName).trim(), String(email).trim(), passwordHash ?? hashPassword(password), role.id, scopeAllServers ? 1 : 0, mustChangePassword ? 1 : 0, ts, ts);
    if (!scopeAllServers) await setServers(tx, Number(lastInsertRowid), servers);
    return Number(lastInsertRowid);
  });
  return getUser(id);
}

export async function updateUser(id, patch) {
  const user = await getUser(id);
  const sets = [];
  const values = [];

  if (patch.displayName !== undefined) (sets.push('display_name = ?'), values.push(String(patch.displayName).trim()));
  if (patch.email !== undefined) (sets.push('email = ?'), values.push(String(patch.email).trim()));
  if (patch.roleId !== undefined && patch.roleId !== user.role.id) {
    const role = await getRole(patch.roleId);
    if (user.role.key === PROTECTED_ROLE && role.key !== PROTECTED_ROLE) await assertNotLastAdmin(id);
    sets.push('role_id = ?');
    values.push(role.id);
  }
  if (patch.isActive !== undefined && Boolean(patch.isActive) !== user.isActive) {
    // La garde ne concerne QUE les administrateurs : désactiver un lecteur ne peut pas
    // priver le parc de son dernier administrateur. Sans cette condition, elle répondait
    // « il doit rester un administrateur actif » à qui désactivait un compte d'agent.
    if (!patch.isActive && user.role.key === PROTECTED_ROLE) await assertNotLastAdmin(id);
    sets.push('is_active = ?', 'failed_attempts = 0', 'locked_until = NULL');
    values.push(patch.isActive ? 1 : 0);
  }
  if (patch.scopeAllServers !== undefined) (sets.push('scope_all_servers = ?'), values.push(patch.scopeAllServers ? 1 : 0));

  await transaction(async (tx) => {
    if (sets.length) {
      sets.push('updated_at = ?');
      values.push(now(), id);
      await tx.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    if (patch.servers !== undefined) await setServers(tx, id, patch.servers);
  });
  return getUser(id);
}

export async function setUserPassword(id, password, { mustChange = false } = {}) {
  await getUser(id);
  assertPassword(password);
  await prepare(
    'UPDATE users SET password_hash = ?, must_change_password = ?, failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
  ).run(hashPassword(password), mustChange ? 1 : 0, now(), id);
  return getUser(id);
}

export async function deleteUser(id) {
  const user = await getUser(id);
  await assertNotLastAdmin(id);
  await prepare('DELETE FROM users WHERE id = ?').run(id);
  return { id, username: user.username };
}

// ───────────────────────── Connexion ─────────────────────────

export async function recordLoginSuccess(id) {
  await prepare('UPDATE users SET last_login_at = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?').run(now(), id);
}

/** Verrouille temporairement le compte après trop d'échecs (freine le bourrage d'identifiants). */
export async function recordLoginFailure(id) {
  const ligne = await prepare('SELECT failed_attempts AS n FROM users WHERE id = ?').get(id);
  const attempts = Number(ligne?.n ?? 0) + 1;
  const locked = attempts >= config.loginMaxAttempts ? now() + config.loginLockMinutes * 60_000 : null;
  await prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?').run(attempts, locked, id);
  return { attempts, lockedUntil: locked };
}
