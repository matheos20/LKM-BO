import crypto from 'node:crypto';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword } from './password.js';
import { countUsers, createUser, findUserByLogin, getRoleByKey, recordLoginFailure, recordLoginSuccess } from '../db/repositories.js';

/** Haché de comparaison : la vérification coûte le même temps pour un compte inexistant. */
const DUMMY_HASH = hashPassword(crypto.randomBytes(24).toString('hex'));

/**
 * Vérifie un couple identifiant / mot de passe.
 * Compte désactivé, verrouillage temporaire et échecs successifs sont traités ici.
 *
 * DEUX MESSAGES DISTINCTS, ET POURQUOI.
 *
 * Un seul message pour « ce compte n'existe pas » et « ce mot de passe est faux » est
 * l'usage sur un site ouvert à tous : il empêche d'essayer des identifiants pour
 * découvrir lesquels existent. Ici, les comptes sont créés un par un par
 * l'administrateur, pour une poignée d'agents, et le coût de ce silence est réel :
 * l'agent qui tape son adresse au lieu de son identifiant voit « incorrect » et ne sait
 * pas quoi corriger — ni lequel des deux champs reprendre.
 *
 * On dit donc lequel des deux cloche. Si ce back-office devient un jour joignable depuis
 * l'extérieur, `LOGIN_PRECISE_ERRORS=false` remet le message unique, sans rien changer
 * d'autre : la vérification garde son coût constant dans les deux cas.
 */
export async function authenticate(login, password) {
  const flou = () => new AppError('errors.auth_invalid', { status: 401 });
  const precis = (key, vars) => (config.loginPreciseErrors ? new AppError(key, { status: 401, vars }) : flou());

  const { user, reason } = await findUserByLogin(login);
  if (!user) {
    verifyPassword(password, DUMMY_HASH); // même coût qu'un compte réel
    // Une adresse portée par deux comptes ne désigne personne : on ne devine pas.
    if (reason === 'ambiguous') throw new AppError('errors.auth_email_ambiguous', { status: 409 });
    throw precis('errors.auth_unknown_user', { login: String(login ?? '').trim().slice(0, 60) });
  }
  if (!user.isActive) throw new AppError('errors.auth_disabled', { status: 403 });

  if (user.lockedUntil && user.lockedUntil > Date.now()) {
    throw new AppError('errors.auth_locked', { status: 429, vars: { minutes: Math.ceil((user.lockedUntil - Date.now()) / 60000) } });
  }
  if (!verifyPassword(password, user.passwordHash)) {
    const { attempts, lockedUntil } = await recordLoginFailure(user.id);
    if (lockedUntil) throw new AppError('errors.auth_locked', { status: 429, vars: { minutes: config.loginLockMinutes } });
    // Le nombre d'essais restants évite la surprise du verrouillage : un agent qui se
    // trompe deux fois doit savoir qu'il approche d'une porte qui se ferme.
    const restants = Math.max(0, config.loginMaxAttempts - attempts);
    throw precis('errors.auth_wrong_password', { remaining: restants });
  }

  await recordLoginSuccess(user.id);
  return user;
}

/**
 * Amorçage : sans aucun utilisateur en base, on crée le premier administrateur.
 * Le compte historique du fichier .env est repris tel quel (même mot de passe) ;
 * à défaut, un mot de passe aléatoire est généré et affiché UNE fois au démarrage.
 */
export async function bootstrapAdmin() {
  if ((await countUsers()) > 0) return null;
  const role = await getRoleByKey('admin');
  const username = config.admin.user || 'admin';

  if (config.admin.passwordHash) {
    await createUser({ username, displayName: 'Administrateur', passwordHash: config.admin.passwordHash, roleId: role.id, mustChangePassword: false });
    console.log(`[init] Compte administrateur « ${username} » repris depuis .env (même mot de passe).`);
    return { username, generated: false };
  }

  const password = crypto.randomBytes(12).toString('base64url');
  await createUser({ username, displayName: 'Administrateur', password, roleId: role.id, mustChangePassword: true });
  console.log(`\n[init] Premier démarrage : compte « ${username} » créé.\n[init] Mot de passe provisoire : ${password}\n[init] À changer dès la première connexion.\n`);
  return { username, generated: true, password };
}
