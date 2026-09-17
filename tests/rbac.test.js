import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { PERMISSION_KEYS } from '../src/auth/permissions.js';
import { openDatabase } from '../src/db/database.js';
import {
  createRole,
  createUser,
  deleteRole,
  deleteUser,
  findUserByUsername,
  getRoleByKey,
  listRoles,
  listUsers,
  recordLoginFailure,
  setUserPassword,
  updateRole,
  updateUser,
} from '../src/db/repositories.js';

/** Base en mémoire : les tests ne touchent aucun fichier. */
before(() => openDatabase(':memory:'));

const key = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.key ?? err.message;
  }
};

test('rôles fournis d\'origine créés au démarrage', () => {
  const roles = listRoles();
  assert.deepEqual(roles.map((r) => r.key).sort(), ['admin', 'contributor', 'editor', 'operator', 'viewer']);
  assert.deepEqual(getRoleByKey('admin').permissions.sort(), [...PERMISSION_KEYS].sort());
  assert.ok(getRoleByKey('viewer').permissions.every((p) => p.endsWith('.read') || p === 'servers.connect'));
  // Le rédacteur prépare et prévisualise, mais ne publie pas.
  const contributor = getRoleByKey('contributor').permissions;
  assert.ok(contributor.includes('design.edit') && !contributor.includes('design.publish'));
  assert.ok(roles.every((r) => r.isSystem));
});

test('création de comptes et validations', () => {
  const admin = createUser({ username: 'patron', password: 'MotDePasseSolide-1', roleId: getRoleByKey('admin').id });
  assert.equal(admin.role.key, 'admin');
  assert.equal(admin.scopeAllServers, true);

  assert.equal(key(() => createUser({ username: 'patron', password: 'MotDePasseSolide-1', roleId: admin.role.id })), 'errors.user_exists');
  assert.equal(key(() => createUser({ username: 'x', password: 'MotDePasseSolide-1', roleId: admin.role.id })), 'errors.user_name_invalid');
  assert.equal(key(() => createUser({ username: 'espace interdit', password: 'MotDePasseSolide-1', roleId: admin.role.id })), 'errors.user_name_invalid');
  assert.equal(key(() => createUser({ username: 'faible', password: 'court', roleId: admin.role.id })), 'errors.password_too_short');
});

test('portée par serveur', () => {
  const user = createUser({
    username: 'restreint',
    password: 'MotDePasseSolide-2',
    roleId: getRoleByKey('viewer').id,
    scopeAllServers: false,
    servers: ['vps-003', 'tiers1', 'vps-003'],
  });
  assert.deepEqual(user.servers, ['tiers1', 'vps-003']);
  const elargi = updateUser(user.id, { servers: ['vps-001'] });
  assert.deepEqual(elargi.servers, ['vps-001']);
  const total = updateUser(user.id, { scopeAllServers: true });
  assert.equal(total.scopeAllServers, true);
});

test('rôles personnalisés : création, modification, suppression', () => {
  const role = createRole({ key: 'publieur', name: 'Publieur', permissions: ['domains.read', 'files.read', 'files.write'] });
  assert.equal(role.isSystem, false);
  assert.equal(role.permissions.length, 3);

  assert.equal(key(() => createRole({ key: 'publieur', name: 'Doublon', permissions: [] })), 'errors.role_exists');
  assert.equal(key(() => createRole({ key: 'Mauvaise Clé', name: 'x', permissions: [] })), 'errors.role_key_invalid');
  assert.equal(key(() => createRole({ key: 'inconnu', name: 'x', permissions: ['nimporte.quoi'] })), 'errors.permission_unknown');
  assert.equal(key(() => updateRole(getRoleByKey('admin').id, { permissions: [] })), 'errors.role_system_readonly');
  assert.equal(key(() => deleteRole(getRoleByKey('viewer').id)), 'errors.role_system_readonly');

  const modifie = updateRole(role.id, { name: 'Publieur web', permissions: ['files.read'] });
  assert.equal(modifie.name, 'Publieur web');
  assert.deepEqual(modifie.permissions, ['files.read']);

  const porteur = createUser({ username: 'redacteur', password: 'MotDePasseSolide-3', roleId: role.id });
  assert.equal(key(() => deleteRole(role.id)), 'errors.role_in_use');
  updateUser(porteur.id, { roleId: getRoleByKey('viewer').id });
  assert.equal(deleteRole(role.id).name, 'Publieur web');
});

test('il doit toujours rester un administrateur actif', () => {
  const admin = findUserByUsername('patron');
  assert.equal(key(() => updateUser(admin.id, { isActive: false })), 'errors.user_last_admin');
  assert.equal(key(() => updateUser(admin.id, { roleId: getRoleByKey('viewer').id })), 'errors.user_last_admin');
  assert.equal(key(() => deleteUser(admin.id)), 'errors.user_last_admin');

  // Avec un second administrateur, la rétrogradation du premier redevient possible.
  const second = createUser({ username: 'patron2', password: 'MotDePasseSolide-4', roleId: getRoleByKey('admin').id });
  assert.equal(key(() => updateUser(admin.id, { isActive: false })), null);
  updateUser(admin.id, { isActive: true });
  assert.equal(key(() => deleteUser(second.id)), null);
});

test('verrouillage après échecs répétés puis remise à zéro', () => {
  const user = findUserByUsername('restreint');
  let last = null;
  for (let i = 0; i < 10; i++) last = recordLoginFailure(user.id);
  assert.equal(last.attempts, 10);
  assert.ok(last.lockedUntil > Date.now(), 'le compte doit être verrouillé');
  assert.ok(findUserByUsername('restreint').lockedUntil > Date.now());

  // Une réinitialisation du mot de passe déverrouille le compte.
  setUserPassword(user.id, 'MotDePasseSolide-5');
  assert.equal(findUserByUsername('restreint').lockedUntil, null);
});

test('les mots de passe ne sont jamais renvoyés en clair', () => {
  const users = listUsers();
  assert.ok(users.length >= 2);
  for (const u of users) {
    assert.equal(u.password, undefined);
    assert.equal(u.passwordHash, undefined);
  }
});
