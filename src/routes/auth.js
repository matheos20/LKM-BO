import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { authenticate } from '../auth/authService.js';
import { verifyPassword } from '../auth/password.js';
import { findUserByUsername, setUserPassword } from '../db/repositories.js';
import { revokeUserSessions } from '../db/sessionStore.js';

/** Profil renvoyé au navigateur : il pilote l'affichage, la vérification restant côté serveur. */
const view = (user) => ({
  id: user.id,
  username: user.username,
  displayName: user.displayName,
  email: user.email,
  role: { key: user.role.key, name: user.role.name },
  permissions: [...(user.permissions ?? [])],
  scopeAllServers: user.scopeAllServers,
  servers: user.servers,
  mustChangePassword: user.mustChangePassword,
});

export function authRouter({ audit }) {
  const r = Router();

  const limiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.loginRateLimit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError('errors.auth_too_many', { status: 429 })),
  });

  r.post('/login', limiter, async (req, res) => {
    const { username, password } = req.body ?? {};
    let user;
    try {
      user = authenticate(username, password);
    } catch (err) {
      audit(req, { action: 'login', ok: false, user: String(username ?? '').slice(0, 40), error: err.key });
      throw err;
    }
    // Nouvel identifiant de session à la connexion (anti fixation de session).
    await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
    req.session.userId = user.id;
    audit(req, { action: 'login', ok: true, user: user.username, role: user.role.key });
    res.json(view(user));
  });

  r.post('/logout', (req, res, next) => {
    audit(req, { action: 'logout', ok: true, user: req.user?.username });
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('lkm.sid');
      res.json({ ok: true });
    });
  });

  r.get('/me', (req, res) => {
    if (!req.user) throw new AppError('errors.auth_required', { status: 401 });
    res.json(view(req.user));
  });

  /** Changement de son propre mot de passe : les autres sessions du compte sont fermées. */
  r.post('/password', (req, res) => {
    if (!req.user) throw new AppError('errors.auth_required', { status: 401 });
    const { current, password } = req.body ?? {};
    const full = findUserByUsername(req.user.username);
    if (!verifyPassword(current, full.passwordHash)) throw new AppError('errors.password_wrong', { status: 403 });
    setUserPassword(req.user.id, password);
    revokeUserSessions(req.user.id, { exceptSid: req.sessionID });
    audit(req, { action: 'password.self', ok: true, user: req.user.username });
    res.json({ ok: true });
  });

  return r;
}
