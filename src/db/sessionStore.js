import session from 'express-session';
import { getDb } from './database.js';

/**
 * Stockage des sessions en base plutôt qu'en mémoire.
 *
 * Deux bénéfices concrets : les sessions survivent à un redémarrage, et surtout elles
 * peuvent être révoquées côté serveur — désactiver un compte ou changer son mot de passe
 * ferme immédiatement ses sessions ouvertes.
 */
export class SqliteSessionStore extends session.Store {
  constructor({ ttlMs = 8 * 3600 * 1000, sweepMs = 10 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.timer = setInterval(() => this.sweep(), sweepMs);
    this.timer.unref?.();
  }

  #expiry(sess) {
    const cookieExpires = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : null;
    return cookieExpires && Number.isFinite(cookieExpires) ? cookieExpires : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    try {
      const row = getDb().prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        this.destroy(sid, () => {});
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      getDb()
        .prepare(
          `INSERT INTO sessions (sid, user_id, data, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET user_id = excluded.user_id, data = excluded.data, expires_at = excluded.expires_at`,
        )
        .run(sid, sess?.userId ?? null, JSON.stringify(sess), this.#expiry(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      getDb().prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(this.#expiry(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  length(cb) {
    try {
      cb(null, getDb().prepare('SELECT COUNT(*) AS n FROM sessions').get().n);
    } catch (err) {
      cb(err);
    }
  }

  clear(cb) {
    try {
      getDb().prepare('DELETE FROM sessions').run();
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  sweep() {
    try {
      getDb().prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    } catch {}
  }
}

/**
 * Ferme les sessions d'un utilisateur (désactivation, changement de rôle ou de mot de passe,
 * suppression). `exceptSid` permet de conserver la session courante : un utilisateur qui
 * change son propre mot de passe déconnecte ses autres appareils, mais pas lui-même.
 */
export function revokeUserSessions(userId, { exceptSid } = {}) {
  const db = getDb();
  return exceptSid
    ? db.prepare('DELETE FROM sessions WHERE user_id = ? AND sid <> ?').run(userId, exceptSid).changes
    : db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}
