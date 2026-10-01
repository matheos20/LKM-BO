import { AppError } from '../errors.js';
import { config } from '../config.js';
import { detectLang, translate } from '../i18n.js';
import { getUser } from '../db/repositories.js';

/** Langue de la requête + raccourci req.t() pour les traductions. */
export function langMiddleware(req, _res, next) {
  req.lang = detectLang(req);
  req.t = (key, vars) => translate(req.lang, key, vars);
  next();
}

/** Anti-CSRF : toute requête modifiante doit porter l'en-tête X-Requested-With (en plus du cookie SameSite=Strict). */
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('x-requested-with') === 'lkm-bo') return next();
  next(new AppError('errors.csrf', { status: 403 }));
}

/**
 * Charge l'utilisateur de la session À CHAQUE requête, depuis la base.
 * Un compte désactivé, supprimé, ou dont le rôle a changé perd donc ses droits
 * immédiatement, sans attendre l'expiration de sa session.
 */
export async function attachUser(req, _res, next) {
  const id = req.session?.userId;
  if (!id) return next();
  try {
    const user = await getUser(id);
    if (!user.isActive) {
      req.session.destroy(() => {});
      return next();
    }
    req.user = { ...user, permissions: new Set(user.permissions) };
  } catch {
    req.session.destroy(() => {}); // utilisateur supprimé
  }
  next();
}

export function requireAuth(req, _res, next) {
  if (req.user) return next();
  next(new AppError('errors.auth_required', { status: 401 }));
}

/**
 * Un mot de passe provisoire ne donne accès à RIEN tant qu'il n'a pas été changé.
 *
 * Le drapeau existait déjà, mais il ne servait qu'à ouvrir une fenêtre dans le
 * navigateur : la fenêtre se fermait d'un clic à côté, et le compte avait alors tous
 * ses droits avec le mot de passe que l'administrateur avait tapé pour lui. Autant dire
 * que l'obligation n'existait pas.
 *
 * Elle est désormais tenue ICI, où elle ne se contourne pas. Ce garde se place après
 * l'authentification et avant tout le reste ; la connexion, la déconnexion, la lecture
 * de son propre profil et le changement de mot de passe sont montés avant lui, donc
 * restent accessibles — c'est tout ce dont le compte a besoin pour se mettre en règle.
 */
export function requirePasswordChanged(req, _res, next) {
  if (!req.user?.mustChangePassword) return next();
  next(new AppError('errors.password_change_required', { status: 403 }));
}

/** Exige une permission précise ; le message nomme la permission manquante, traduite. */
export const requirePermission = (permission) => (req, _res, next) => {
  if (req.user?.permissions.has(permission)) return next();
  next(new AppError('errors.forbidden', { status: 403, vars: { permission: `@perm.${permission}` } }));
};

/** Vérifie que l'utilisateur a bien accès au serveur visé (portée par serveur). */
export const requireServerAccess = (ssh) => (req, _res, next) => {
  const server = ssh.server(req.params.id);
  const user = req.user;
  if (user?.scopeAllServers || user?.servers.includes(server.id)) return next();
  next(new AppError('errors.server_forbidden', { status: 403, vars: { server: server.label } }));
};

/** Filtre une liste de serveurs selon la portée de l'utilisateur. */
export const visibleServers = (user, servers) => (user?.scopeAllServers ? servers : servers.filter((s) => user?.servers.includes(s.id)));

/** Toute route SSH vérifie qu'une connexion active existe avant d'exécuter quoi que ce soit. */
/**
 * Aucune commande n'est lancée sans session : c'est la règle du projet.
 * Une session tombée d'elle-même — coupure réseau, fermeture pour inactivité — reste
 * cependant « disponible » : elle sera rouverte au moment d'ouvrir le canal, sans quoi
 * le moindre incident réseau obligerait l'agent à tout reprendre à la main.
 */
export const requireConnection = (ssh) => (req, _res, next) => {
  const server = ssh.server(req.params.id);
  if (ssh.isAvailable(server.id)) return next();
  next(new AppError('errors.ssh_not_connected', { status: 409, vars: { server: server.label } }));
};

/** Gestion centralisée des erreurs : message traduit dans la langue du client. */
export function errorHandler(err, req, res, _next) {
  const lang = req.lang ?? config.defaultLang;
  if (err?.type === 'entity.too.large') err = new AppError('errors.file_too_big', { status: 413 });
  else if (err?.type === 'entity.parse.failed') err = new AppError('errors.bad_request', { status: 400 });

  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { key: err.key, message: translate(lang, err.key, err.vars), detail: err.detail } });
  }
  console.error(err);
  res.status(500).json({ error: { key: 'errors.generic', message: translate(lang, 'errors.generic') } });
}
