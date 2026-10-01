import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import mysql from 'mysql2/promise';
import { PERMISSION_KEYS, SYSTEM_ROLES } from '../src/auth/permissions.js';
import { config } from '../src/config.js';
import { closeMysql, exec, openMysql, prepare } from '../src/db/mysql.js';
import { migrateMysql, seedSystemRolesMysql } from '../src/db/mysqlSchema.js';
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

/**
 * Les comptes et les rôles vivent désormais dans MySQL.
 *
 * Ces contrôles tournent donc sur une base JETABLE, créée au début et supprimée à la
 * fin : jamais sur celle de l'application. Si aucun serveur MySQL ne répond — sur une
 * machine d'intégration, ou chez quelqu'un qui n'en a pas —, ils s'annoncent ignorés
 * plutôt que de faire échouer toute la suite. Un contrôle qu'on ne peut pas exécuter
 * doit le dire, pas mentir dans un sens ou dans l'autre.
 */
const BASE_TEST = `${config.mysql.database}_test`;
let disponible = false;
let motif = '';

before(async () => {
  try {
    const cnx = await mysql.createConnection({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      connectTimeout: 3000,
    });
    await cnx.query(`DROP DATABASE IF EXISTS \`${BASE_TEST}\``);
    await cnx.query(`CREATE DATABASE \`${BASE_TEST}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await cnx.end();

    openMysql({ ...config.mysql, database: BASE_TEST });
    await migrateMysql({ prepare, exec });
    await seedSystemRolesMysql(null, { SYSTEM_ROLES, PERMISSION_KEYS });
    disponible = true;
  } catch (err) {
    motif = `MySQL injoignable (${err.message.slice(0, 60)})`;
  }
});

after(async () => {
  if (!disponible) return;
  await exec(`DROP DATABASE IF EXISTS \`${BASE_TEST}\``);
  await closeMysql();
});

/** Le message d'erreur d'une fonction asynchrone, ou null si elle a réussi. */
const key = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err.key ?? err.message;
  }
};

test('rôles fournis d’origine créés au démarrage', async (t) => {
  if (!disponible) return t.skip(motif);
  const roles = await listRoles();
  assert.deepEqual(roles.map((r) => r.key).sort(), ['admin', 'contributor', 'editor', 'operator', 'viewer']);
  assert.deepEqual((await getRoleByKey('admin')).permissions.sort(), [...PERMISSION_KEYS].sort());
  assert.ok((await getRoleByKey('viewer')).permissions.every((p) => p.endsWith('.read') || p === 'servers.connect'));
  // Le rédacteur prépare et prévisualise, mais ne publie pas.
  const contributor = (await getRoleByKey('contributor')).permissions;
  assert.ok(contributor.includes('design.edit') && !contributor.includes('design.publish'));
  assert.ok(roles.every((r) => r.isSystem));
});

test('création de comptes et validations', async (t) => {
  if (!disponible) return t.skip(motif);
  const admin = await createUser({ username: 'patron', password: 'MotDePasseSolide-1', roleId: (await getRoleByKey('admin')).id });
  assert.equal(admin.role.key, 'admin');
  assert.equal(admin.scopeAllServers, true);

  assert.equal(await key(() => createUser({ username: 'patron', password: 'MotDePasseSolide-1', roleId: admin.role.id })), 'errors.user_exists');
  assert.equal(await key(() => createUser({ username: 'x', password: 'MotDePasseSolide-1', roleId: admin.role.id })), 'errors.user_name_invalid');
  assert.equal(await key(() => createUser({ username: 'espace interdit', password: 'MotDePasseSolide-1', roleId: admin.role.id })), 'errors.user_name_invalid');
  assert.equal(await key(() => createUser({ username: 'faible', password: 'court', roleId: admin.role.id })), 'errors.password_too_short');
});

test('portée par serveur', async (t) => {
  if (!disponible) return t.skip(motif);
  const user = await createUser({
    username: 'restreint',
    password: 'MotDePasseSolide-2',
    roleId: (await getRoleByKey('viewer')).id,
    scopeAllServers: false,
    servers: ['vps-003', 'tiers1', 'vps-003'],
  });
  assert.deepEqual(user.servers, ['tiers1', 'vps-003']);
  assert.deepEqual((await updateUser(user.id, { servers: ['vps-001'] })).servers, ['vps-001']);
  assert.equal((await updateUser(user.id, { scopeAllServers: true })).scopeAllServers, true);
});

test('rôles personnalisés : création, modification, suppression', async (t) => {
  if (!disponible) return t.skip(motif);
  const role = await createRole({ key: 'publieur', name: 'Publieur', permissions: ['domains.read', 'files.read', 'files.write'] });
  assert.equal(role.isSystem, false);
  assert.equal(role.permissions.length, 3);

  assert.equal(await key(() => createRole({ key: 'publieur', name: 'Doublon', permissions: [] })), 'errors.role_exists');
  assert.equal(await key(() => createRole({ key: 'Mauvaise Clé', name: 'x', permissions: [] })), 'errors.role_key_invalid');
  assert.equal(await key(() => createRole({ key: 'inconnu', name: 'x', permissions: ['nimporte.quoi'] })), 'errors.permission_unknown');
  assert.equal(await key(async () => updateRole((await getRoleByKey('admin')).id, { permissions: [] })), 'errors.role_system_readonly');
  assert.equal(await key(async () => deleteRole((await getRoleByKey('viewer')).id)), 'errors.role_system_readonly');

  const modifie = await updateRole(role.id, { name: 'Publieur web', permissions: ['files.read'] });
  assert.equal(modifie.name, 'Publieur web');
  assert.deepEqual(modifie.permissions, ['files.read']);

  const porteur = await createUser({ username: 'redacteur', password: 'MotDePasseSolide-3', roleId: role.id });
  assert.equal(await key(() => deleteRole(role.id)), 'errors.role_in_use');
  await updateUser(porteur.id, { roleId: (await getRoleByKey('viewer')).id });
  assert.equal((await deleteRole(role.id)).name, 'Publieur web');
});

test('il doit toujours rester un administrateur actif', async (t) => {
  if (!disponible) return t.skip(motif);
  const admin = await findUserByUsername('patron');
  assert.equal(await key(() => updateUser(admin.id, { isActive: false })), 'errors.user_last_admin');
  assert.equal(await key(async () => updateUser(admin.id, { roleId: (await getRoleByKey('viewer')).id })), 'errors.user_last_admin');
  assert.equal(await key(() => deleteUser(admin.id)), 'errors.user_last_admin');

  // Avec un second administrateur, la rétrogradation du premier redevient possible.
  const second = await createUser({ username: 'patron2', password: 'MotDePasseSolide-4', roleId: (await getRoleByKey('admin')).id });
  assert.equal(await key(() => updateUser(admin.id, { isActive: false })), null);
  await updateUser(admin.id, { isActive: true });
  assert.equal(await key(() => deleteUser(second.id)), null);
});

test('verrouillage après échecs répétés puis remise à zéro', async (t) => {
  if (!disponible) return t.skip(motif);
  const user = await findUserByUsername('restreint');
  let last = null;
  for (let i = 0; i < 10; i += 1) last = await recordLoginFailure(user.id);
  assert.equal(last.attempts, 10);
  assert.ok(last.lockedUntil > Date.now(), 'le compte doit être verrouillé');
  assert.ok((await findUserByUsername('restreint')).lockedUntil > Date.now());

  // Une réinitialisation du mot de passe déverrouille le compte.
  await setUserPassword(user.id, 'MotDePasseSolide-5');
  assert.equal((await findUserByUsername('restreint')).lockedUntil, null);
});

test('les mots de passe ne sont jamais renvoyés en clair', async (t) => {
  if (!disponible) return t.skip(motif);
  const users = await listUsers();
  assert.ok(users.length >= 2);
  for (const u of users) {
    assert.equal(u.password, undefined);
    assert.equal(u.passwordHash, undefined);
  }
});
