import session from 'express-session';
import { prepare } from './mysql.js';

/**
 * Stockage des sessions en base plutôt qu'en mémoire.
 *
 * Deux bénéfices concrets : les sessions survivent à un redémarrage, et surtout elles
 * peuvent être révoquées côté serveur — désactiver un compte ou changer son mot de passe
 * ferme immédiatement ses sessions ouvertes.
 *
 * `express-session` attend des méthodes à CALLBACK, pas des promesses. La base, elle,
 * répond désormais de façon asynchrone. Chaque méthode enveloppe donc son travail dans
 * une promesse dont elle rend le résultat au callback — et surtout, dont elle rattrape
 * le rejet : une promesse rejetée ici ferait tomber le processus entier.
 */
export class MysqlSessionStore extends session.Store {
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

  /** Enveloppe une promesse dans un callback, en rattrapant tout rejet. */
  static #rendre(promesse, cb) {
    promesse.then((v) => cb(null, v), (err) => cb(err));
  }

  get(sid, cb) {
    MysqlSessionStore.#rendre((async () => {
      const row = await prepare('SELECT data, expires_at FROM sessions WHERE sid = ?').get(sid);
      if (!row) return null;
      if (Number(row.expires_at) <= Date.now()) {
        this.destroy(sid, () => {});
        return null;
      }
      return JSON.parse(row.data);
    })(), cb);
  }

  set(sid, sess, cb) {
    // « ON DUPLICATE KEY UPDATE » remplace le « ON CONFLICT » de SQLite ; « VALUES(col) »
    // y désigne la valeur qu'on tentait d'insérer.
    MysqlSessionStore.#rendre(
      prepare(
        `INSERT INTO sessions (sid, user_id, data, expires_at) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), data = VALUES(data), expires_at = VALUES(expires_at)`,
      ).run(sid, sess?.userId ?? null, JSON.stringify(sess), this.#expiry(sess)).then(() => undefined),
      cb,
    );
  }

  touch(sid, sess, cb) {
    MysqlSessionStore.#rendre(
      prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?').run(this.#expiry(sess), sid).then(() => undefined),
      cb,
    );
  }

  destroy(sid, cb) {
    MysqlSessionStore.#rendre(prepare('DELETE FROM sessions WHERE sid = ?').run(sid).then(() => undefined), cb);
  }

  length(cb) {
    MysqlSessionStore.#rendre(prepare('SELECT COUNT(*) AS n FROM sessions').get().then((r) => Number(r.n)), cb);
  }

  clear(cb) {
    MysqlSessionStore.#rendre(prepare('DELETE FROM sessions').run().then(() => undefined), cb);
  }

  /** Nettoyage périodique : sans appelant, un échec ne doit rien interrompre. */
  sweep() {
    prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now()).catch((err) => {
      console.error(`[sessions] nettoyage impossible : ${err.message}`);
    });
  }
}

/**
 * Ferme les sessions d'un utilisateur (désactivation, changement de rôle ou de mot de passe,
 * suppression). `exceptSid` permet de conserver la session courante : un utilisateur qui
 * change son propre mot de passe déconnecte ses autres appareils, mais pas lui-même.
 */
export async function revokeUserSessions(userId, { exceptSid } = {}) {
  const r = exceptSid
    ? await prepare('DELETE FROM sessions WHERE user_id = ? AND sid <> ?').run(userId, exceptSid)
    : await prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return r.changes;
}
