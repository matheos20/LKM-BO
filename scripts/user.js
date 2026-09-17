// Gestion des comptes en ligne de commande — porte de secours si plus personne
// ne peut se connecter à l'interface.
//
//   npm run user list
//   npm run user add <identifiant> <rôle> [mot de passe]
//   npm run user passwd <identifiant> [mot de passe]
//   npm run user role <identifiant> <rôle>
//   npm run user enable|disable <identifiant>
//   npm run user roles
import crypto from 'node:crypto';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import {
  createUser,
  findUserByUsername,
  getRoleByKey,
  listRoles,
  listUsers,
  setUserPassword,
  updateUser,
} from '../src/db/repositories.js';

openDatabase(config.dbFile);

const [command, ...args] = process.argv.slice(2);
const date = (ms) => (ms ? new Date(ms).toLocaleString('fr-FR') : '—');

function requireUser(username) {
  const user = findUserByUsername(username);
  if (!user) {
    console.error(`✖ Compte inconnu : ${username}`);
    process.exit(1);
  }
  return user;
}

try {
  switch (command) {
    case 'list': {
      const users = listUsers();
      console.log(`${'IDENTIFIANT'.padEnd(20)} ${'RÔLE'.padEnd(16)} ${'ÉTAT'.padEnd(10)} ${'PORTÉE'.padEnd(22)} DERNIÈRE CONNEXION`);
      for (const u of users) {
        const scope = u.scopeAllServers ? 'tous les serveurs' : u.servers.join(', ') || 'aucun serveur';
        console.log(`${u.username.padEnd(20)} ${u.role.key.padEnd(16)} ${(u.isActive ? 'actif' : 'désactivé').padEnd(10)} ${scope.padEnd(22)} ${date(u.lastLoginAt)}`);
      }
      break;
    }

    case 'roles': {
      for (const role of listRoles()) {
        console.log(`${role.key.padEnd(14)} ${String(role.users).padStart(3)} compte(s)  ${role.isSystem ? '[fourni]' : '[personnalisé]'}  ${role.permissions.join(', ') || '—'}`);
      }
      break;
    }

    case 'add': {
      const [username, roleKey, given] = args;
      if (!username || !roleKey) throw new Error('usage: npm run user add <identifiant> <rôle> [mot de passe]');
      const password = given || crypto.randomBytes(12).toString('base64url');
      const user = createUser({ username, password, roleId: getRoleByKey(roleKey).id, mustChangePassword: !given });
      console.log(`✔ Compte « ${user.username} » créé avec le rôle ${user.role.key}.`);
      if (!given) console.log(`  Mot de passe provisoire : ${password}`);
      break;
    }

    case 'passwd': {
      const [username, given] = args;
      const user = requireUser(username);
      const password = given || crypto.randomBytes(12).toString('base64url');
      setUserPassword(user.id, password, { mustChange: !given });
      console.log(`✔ Mot de passe de « ${user.username} » modifié.`);
      if (!given) console.log(`  Nouveau mot de passe : ${password}`);
      break;
    }

    case 'role': {
      const [username, roleKey] = args;
      const user = requireUser(username);
      const updated = updateUser(user.id, { roleId: getRoleByKey(roleKey).id });
      console.log(`✔ « ${updated.username} » a désormais le rôle ${updated.role.key}.`);
      break;
    }

    case 'enable':
    case 'disable': {
      const user = requireUser(args[0]);
      const updated = updateUser(user.id, { isActive: command === 'enable' });
      console.log(`✔ « ${updated.username} » est ${updated.isActive ? 'actif' : 'désactivé'}.`);
      break;
    }

    default:
      console.log(`Commandes : list · roles · add <id> <rôle> [mdp] · passwd <id> [mdp] · role <id> <rôle> · enable <id> · disable <id>`);
  }
} catch (err) {
  console.error(`✖ ${err.vars ? `${err.key} ${JSON.stringify(err.vars)}` : err.message}`);
  process.exit(1);
}
