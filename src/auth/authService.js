import crypto from 'node:crypto';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword } from './password.js';
import { countUsers, createUser, findUserByUsername, getRoleByKey, recordLoginFailure, recordLoginSuccess } from '../db/repositories.js';

/** Haché de comparaison : la vérification coûte le même temps pour un compte inexistant. */
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

/**
 * Vérifie un couple identifiant / mot de passe.
 * Compte désactivé, verrouillage temporaire et échecs successifs sont traités ici.
 */
export function authenticate(username, password) {
  const user = findUserByUsername(username);
  if (!user) {
    verifyPassword(password, DUMMY_HASH); // même coût qu'un compte réel
    throw new AppError('errors.auth_invalid', { status: 401 });
  }
  if (!user.isActive) throw new AppError('errors.auth_disabled', { status: 403 });

  if (user.lockedUntil && user.lockedUntil > Date.now()) {
    throw new AppError('errors.auth_locked', { status: 429, vars: { minutes: Math.ceil((user.lockedUntil - Date.now()) / 60000) } });
  }
  if (!verifyPassword(password, user.passwordHash)) {
    const { lockedUntil } = recordLoginFailure(user.id);
    if (lockedUntil) throw new AppError('errors.auth_locked', { status: 429, vars: { minutes: config.loginLockMinutes } });
    throw new AppError('errors.auth_invalid', { status: 401 });
  }

  recordLoginSuccess(user.id);
  return user;
}

/**
 * Amorçage : sans aucun utilisateur en base, on crée le premier administrateur.
 * Le compte historique du fichier .env est repris tel quel (même mot de passe) ;
 * à défaut, un mot de passe aléatoire est généré et affiché UNE fois au démarrage.
 */
export function bootstrapAdmin() {
  if (countUsers() > 0) return null;
  const role = getRoleByKey('admin');
  const username = config.admin.user || 'admin';

  if (config.admin.passwordHash) {
    createUser({ username, displayName: 'Administrateur', passwordHash: config.admin.passwordHash, roleId: role.id, mustChangePassword: false });
    console.log(`[init] Compte administrateur « ${username} » repris depuis .env (même mot de passe).`);
    return { username, generated: false };
  }

  const password = crypto.randomBytes(12).toString('base64url');
  createUser({ username, displayName: 'Administrateur', password, roleId: role.id, mustChangePassword: true });
  console.log(`\n[init] Premier démarrage : compte « ${username} » créé.\n[init] Mot de passe provisoire : ${password}\n[init] À changer dès la première connexion.\n`);
  return { username, generated: true, password };
}
