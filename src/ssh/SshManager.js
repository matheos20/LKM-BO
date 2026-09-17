import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client } from 'ssh2';
import { AppError } from '../errors.js';

const MAX_OUTPUT = 32 * 1024 * 1024;
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET']);

/** Empreinte au format OpenSSH : SHA256:<base64 sans padding>. */
export const fingerprint = (key) => `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** Résout les secrets depuis l'environnement AU MOMENT de la connexion (jamais stockés en config). */
function authOptions(auth) {
  const need = (name) => {
    const v = process.env[name];
    if (!v) throw new AppError('errors.ssh_missing_env', { status: 500, vars: { name } });
    return v;
  };
  if (auth.type === 'key') {
    const keyPath = need(auth.keyPathEnv);
    let privateKey;
    try {
      privateKey = fs.readFileSync(keyPath);
    } catch {
      throw new AppError('errors.ssh_key_unreadable', { status: 500, vars: { path: keyPath } });
    }
    return { privateKey, passphrase: (auth.passphraseEnv && process.env[auth.passphraseEnv]) || undefined };
  }
  if (auth.type === 'password') return { password: need(auth.passwordEnv), tryKeyboard: true };
  return { agent: process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined) };
}

function mapError(err, label, hostKey) {
  if (err instanceof AppError) return err;
  const vars = { server: label };
  if (hostKey === 'mismatch') return new AppError('errors.ssh_host_key_mismatch', { status: 502, vars });
  if (hostKey === 'unknown') return new AppError('errors.ssh_host_key_unknown', { status: 502, vars });
  if (err.level === 'client-authentication') return new AppError('errors.ssh_auth_failed', { status: 502, vars });
  if (err.code === 'ECONNREFUSED') return new AppError('errors.ssh_refused', { status: 502, vars });
  if (NETWORK_CODES.has(err.code) || /timed out/i.test(err.message)) return new AppError('errors.ssh_unreachable', { status: 504, vars });
  return new AppError('errors.ssh_error', { status: 502, vars: { ...vars, message: err.message } });
}

/**
 * Session tombée : le serveur a fermé la connexion, ou elle n'a jamais répondu.
 * ssh2 signale « No response from server » quand la socket se ferme alors qu'une
 * ouverture de canal est en attente — c'est le cas typique d'une coupure réseau.
 */
const LOST_SESSION = /no response from server|not connected|channel open failure|socket (is )?closed|broken pipe/i;
const lostSession = (err) =>
  LOST_SESSION.test(String(err?.message ?? '')) || ['ECONNRESET', 'EPIPE', 'ERR_SOCKET_CLOSED', 'ERR_STREAM_DESTROYED'].includes(err?.code);

class Semaphore {
  constructor(n) {
    this.free = n;
    this.queue = [];
  }
  async acquire() {
    if (this.free > 0) return void this.free--;
    await new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.free++;
  }
}

/**
 * Une connexion SSH persistante vers une cible { host, port, username, auth }.
 * Keepalive, fermeture sur inactivité, limite de canaux parallèles, timeouts de commande.
 */
export class SshConnection {
  constructor(label, target, { knownHosts, settings }) {
    this.label = label;
    this.target = target;
    this.knownHosts = knownHosts;
    this.settings = settings;
    this.client = null;
    this.state = 'disconnected'; // disconnected | connecting | connected | error
    this.lastError = null;
    this.connectedAt = null;
    this.fingerprint = knownHosts.get(`${target.host}:${target.port}`);
    this.pending = null;
    this.idleTimer = null;
    // Vrai dès qu'une connexion a été demandée et n'a pas été fermée par l'utilisateur :
    // une coupure réseau ou la fermeture pour inactivité ne doivent pas obliger l'agent
    // à se reconnecter à la main.
    this.wanted = false;
    this.sem = new Semaphore(settings.maxParallel);
  }

  get connected() {
    return this.state === 'connected' && this.client !== null;
  }

  connect() {
    // Une session demandée reste voulue tant que l'utilisateur ne la ferme pas :
    // c'est ce qui autorise sa reprise après une coupure.
    this.wanted = true;
    if (this.connected) return Promise.resolve(this);
    if (this.pending) return this.pending;

    const { host, port, username, auth } = this.target;
    const hostId = `${host}:${port}`;
    let hostKey = null;
    let settled = false;
    this.state = 'connecting';

    this.pending = new Promise((resolve, reject) => {
      const fail = (err) => {
        this.lastError = mapError(err, this.label, hostKey);
        this.state = 'error';
        this.client = null;
        if (!settled) {
          settled = true;
          reject(this.lastError);
        }
      };

      let opts;
      try {
        opts = authOptions(auth);
      } catch (err) {
        return fail(err);
      }

      const client = new Client();
      client
        .on('ready', () => {
          settled = true;
          this.client = client;
          this.state = 'connected';
          this.lastError = null;
          this.connectedAt = Date.now();
          this.touch();
          resolve(this);
        })
        .on('keyboard-interactive', (_name, _instr, _lang, prompts, finish) => finish(prompts.map(() => opts.password ?? '')))
        .on('error', (err) => {
          fail(err);
          client.end();
        })
        .on('close', () => {
          clearTimeout(this.idleTimer);
          if (!settled) return fail(new Error('Connection closed during handshake'));
          if (this.client === client) this.client = null;
          if (this.state === 'connected') this.state = 'disconnected';
        });

      client.connect({
        host,
        port,
        username,
        ...opts,
        readyTimeout: this.settings.readyTimeout,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        hostVerifier: (key) => {
          this.fingerprint = fingerprint(key);
          hostKey = this.knownHosts.check(hostId, this.fingerprint, this.settings.strictHostKey);
          return hostKey === 'ok' || hostKey === 'new';
        },
      });
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Exécute une commande ; résout toujours avec { code, stdout, stderr } (le code ≠ 0 n'est pas une exception). */
  /**
   * Ouvre un canal d'exécution, en rétablissant la session si elle est tombée.
   *
   * La reprise ne concerne QUE l'ouverture du canal : à ce stade la commande n'a pas
   * commencé, donc la relancer ne peut rien exécuter deux fois. Une coupure survenue
   * en cours d'exécution remonte telle quelle — il appartient à l'appelant de décider.
   */
  async #channel(command) {
    for (let essai = 0; ; essai++) {
      if (!this.connected) {
        if (!this.wanted) throw new AppError('errors.ssh_not_connected', { status: 409, vars: { server: this.label } });
        await this.connect();
      }
      this.touch();
      try {
        const client = this.client;
        return await new Promise((resolve, reject) => {
          client.exec(command, (err, stream) => (err ? reject(err) : resolve(stream)));
        });
      } catch (err) {
        if (essai > 0 || !lostSession(err)) throw mapError(err, this.label);
        // La session est morte : on la rouvre une fois, puis on retente l'ouverture.
        this.state = 'disconnected';
        this.client = null;
      }
    }
  }

  async exec(command, { timeout = this.settings.commandTimeout, maxOutput = MAX_OUTPUT } = {}) {
    await this.sem.acquire();
    try {
      const stream = await this.#channel(command);
      return await new Promise((resolve, reject) => {
        const out = [];
        const errs = [];
        let size = 0;
        let aborted = null;
        const timer = setTimeout(() => {
          aborted = 'timeout';
          stream.close();
        }, timeout);
        const collect = (bucket) => (chunk) => {
          size += chunk.length;
          if (size > maxOutput) {
            aborted = 'overflow';
            return stream.close();
          }
          bucket.push(chunk);
        };
        stream.on('data', collect(out));
        stream.stderr.on('data', collect(errs));
        stream.on('close', (code, signal) => {
          clearTimeout(timer);
          if (aborted === 'timeout') return reject(new AppError('errors.ssh_timeout', { status: 504, vars: { server: this.label } }));
          if (aborted === 'overflow') return reject(new AppError('errors.ssh_error', { status: 502, vars: { server: this.label, message: 'output too large' } }));
          resolve({
            code: code ?? null,
            signal: signal ?? null,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(errs).toString('utf8'),
          });
        });
      });
    } finally {
      this.sem.release();
      this.touch();
    }
  }

  /**
   * Ouvre un canal d'exécution brut : rend le flux (stdin/stdout binaires) et une promesse
   * de fin. Utilisé pour les gros transferts (tar, téléchargements, écriture de fichiers)
   * qui ne doivent pas être mis en mémoire tampon par exec().
   */
  async spawn(command, { timeout = this.settings.commandTimeout } = {}) {
    await this.sem.acquire();
    let stream;
    try {
      stream = await this.#channel(command);
    } catch (err) {
      this.sem.release();
      throw err;
    }

    const errs = [];
    let errSize = 0;
    let aborted = null;
    const timer = setTimeout(() => {
      aborted = 'timeout';
      stream.resume(); // un flux en pause n'émettrait jamais « close »
      stream.close();
    }, timeout);
    stream.stderr.on('data', (c) => {
      if (errSize < 64 * 1024) {
        errSize += c.length;
        errs.push(c);
      }
    });
    const done = new Promise((res, rej) => {
      stream.on('close', (code, signal) => {
        clearTimeout(timer);
        this.sem.release();
        this.touch();
        if (aborted === 'timeout') rej(new AppError('errors.ssh_timeout', { status: 504, vars: { server: this.label } }));
        else res({ code: code ?? null, signal: signal ?? null, stderr: Buffer.concat(errs).toString('utf8') });
      });
    });
    return { stream, done };
  }

  touch() {
    clearTimeout(this.idleTimer);
    if (this.connected && this.settings.idleTimeout > 0) {
      this.idleTimer = setTimeout(() => this.end(), this.settings.idleTimeout).unref();
    }
  }

  /** Fermeture propre de la session. `manual` : demandée par l'utilisateur, donc pas de reprise. */
  end({ manual = false } = {}) {
    if (manual) this.wanted = false;
    clearTimeout(this.idleTimer);
    const client = this.client;
    this.client = null;
    this.state = 'disconnected';
    this.connectedAt = null;
    client?.end();
  }
}

/** Registre des connexions, une par serveur déclaré dans config/servers.json. */
export class SshManager {
  constructor(servers, { knownHosts, settings }) {
    this.servers = new Map(servers.map((s) => [s.id, s]));
    this.knownHosts = knownHosts;
    this.settings = settings;
    this.conns = new Map();
  }

  list() {
    return [...this.servers.values()];
  }

  server(id) {
    const s = this.servers.get(id);
    if (!s) throw new AppError('errors.server_unknown', { status: 404, vars: { server: String(id).slice(0, 40) } });
    return s;
  }

  conn(id) {
    let c = this.conns.get(id);
    if (!c) {
      const s = this.server(id);
      c = new SshConnection(s.label, s, { knownHosts: this.knownHosts, settings: this.settings });
      this.conns.set(id, c);
    }
    return c;
  }

  connect(id) {
    return this.conn(id).connect();
  }

  disconnect(id) {
    this.server(id);
    this.conns.get(id)?.end({ manual: true });
  }

  isConnected(id) {
    return this.conns.get(id)?.connected ?? false;
  }

  /**
   * Session ouverte, ou seulement tombée en cours de route.
   * Une coupure réseau et la fermeture pour inactivité ne valent pas déconnexion :
   * la commande suivante rouvrira la session toute seule.
   */
  isAvailable(id) {
    const conn = this.conns.get(id);
    return Boolean(conn?.connected || conn?.wanted);
  }

  status(id) {
    const c = this.conn(id);
    return { state: c.state, error: c.lastError, fingerprint: c.fingerprint, connectedAt: c.connectedAt };
  }

  // Session disponible plutôt que strictement ouverte : une session tombée toute seule
  // est rouverte au moment d'ouvrir le canal. Fermée par l'utilisateur, elle refuse.
  exec(id, command, opts) {
    if (!this.isAvailable(id)) throw new AppError('errors.ssh_not_connected', { status: 409, vars: { server: this.server(id).label } });
    return this.conn(id).exec(command, opts);
  }

  spawn(id, command, opts) {
    if (!this.isAvailable(id)) throw new AppError('errors.ssh_not_connected', { status: 409, vars: { server: this.server(id).label } });
    return this.conn(id).spawn(command, opts);
  }

  /** Connexion éphémère (ex. compte lockop à commande forcée) : connect → exec → fermeture. */
  async execOnce(label, target, command, opts) {
    const c = new SshConnection(label, target, { knownHosts: this.knownHosts, settings: { ...this.settings, idleTimeout: 0 } });
    await c.connect();
    try {
      return await c.exec(command, opts);
    } finally {
      c.end();
    }
  }

  closeAll() {
    for (const c of this.conns.values()) c.end();
  }
}
