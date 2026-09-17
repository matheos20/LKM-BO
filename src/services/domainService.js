import { AppError } from '../errors.js';
import { assertDomain, normalizeDomain, renderTemplate } from '../ssh/shell.js';
import {
  ACTIONS,
  capability,
  detailsCommand,
  isSudoDenied,
  listCommand,
  parseDetails,
  parseList,
  parseSudo,
  statusCommand,
} from './parcDriver.js';

const ACTION_KEYS = { create: 'create', delete: 'delete', fixPerms: 'fix_perms', lock: 'lock', unlock: 'unlock' };

const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.parseInt(n, 10) || min));

export function computeStats(items) {
  const st = { total: items.length, locked: 0, unlocked: 0, incomplete: 0, link: 0, wwwCanon: 0 };
  for (const d of items) {
    st[d.status]++;
    if (d.storage === 'link') st.link++;
    if (d.wwwCanon) st.wwwCanon++;
  }
  return st;
}

/** Recherche, filtre d'état, tri et pagination côté serveur (jusqu'à ~35 000 domaines). */
export function queryItems(items, { q = '', status = 'all', sort = 'name', page = 1, size = 50 } = {}) {
  const needle = String(q).trim().toLowerCase();
  let r = needle ? items.filter((d) => d.name.includes(needle)) : items;
  if (['locked', 'unlocked', 'incomplete'].includes(status)) r = r.filter((d) => d.status === status);
  const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.server < b.server ? -1 : 1);
  r = [...r].sort(sort === 'mtime' ? (a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || byName(a, b) : byName);
  const pageSize = clamp(size, 10, 200);
  const pages = Math.max(1, Math.ceil(r.length / pageSize));
  const current = clamp(page, 1, pages);
  return { total: r.length, page: current, pages, size: pageSize, items: r.slice((current - 1) * pageSize, current * pageSize) };
}

/** CRUD des domaines sur un serveur, via la connexion SSH active. */
export class DomainService {
  constructor(ssh, { cacheTtl }) {
    this.ssh = ssh;
    this.cacheTtl = cacheTtl;
    this.cache = new Map();
    this.loading = new Map();
    this.sudo = new Map();
  }

  /** Appelé après chaque connexion : relève les droits sudo pour désactiver les actions impossibles. */
  async probe(id) {
    const r = await this.ssh.exec(id, 'sudo -n -l 2>&1 || true', { timeout: 15000 });
    this.sudo.set(id, parseSudo(r.stdout));
  }

  forget(id) {
    this.cache.delete(id);
    this.sudo.delete(id);
  }

  capabilities(id) {
    const s = this.ssh.server(id);
    return Object.fromEntries(ACTIONS.map((a) => [a, capability(s, a, this.sudo.get(id))]));
  }

  cached(id) {
    return this.cache.get(id) ?? null;
  }

  async list(id, { refresh = false } = {}) {
    const hit = this.cache.get(id);
    if (!refresh && hit && Date.now() - hit.at < this.cacheTtl) return hit;
    if (this.loading.has(id)) return this.loading.get(id);

    const s = this.ssh.server(id);
    const job = this.ssh
      .exec(id, listCommand(s), { timeout: 120000 })
      .then((r) => {
        this.#check(s, r);
        const items = parseList(r.stdout).map((d) => ({ ...d, server: id }));
        const entry = { at: Date.now(), items, stats: computeStats(items) };
        this.cache.set(id, entry);
        return entry;
      })
      .finally(() => this.loading.delete(id));
    this.loading.set(id, job);
    return job;
  }

  async details(id, domain) {
    const s = this.ssh.server(id);
    assertDomain(domain);
    const r = await this.ssh.exec(id, detailsCommand(s, domain), { timeout: 45000 });
    if (r.code === 44) throw new AppError('errors.domain_not_found', { status: 404, vars: { domain, server: s.label } });
    this.#check(s, r);
    const d = parseDetails(r.stdout, s, domain);
    this.#patch(id, domain, { status: d.status });
    return { ...d, server: id, capabilities: this.capabilities(id) };
  }

  async create(id, rawDomain) {
    const s = this.ssh.server(id);
    const domain = normalizeDomain(rawDomain);
    this.#assertCapable(s, 'create');
    if ((await this.#status(s, domain)) !== 'missing') throw new AppError('errors.domain_exists', { status: 409, vars: { domain, server: s.label } });

    const r = await this.ssh.exec(id, renderTemplate(s.commands.create, { domain }), { timeout: 120000 });
    this.#check(s, r);
    this.cache.delete(id);
    return { domain, output: r.stdout.trim() };
  }

  async update(id, domain, action) {
    const s = this.ssh.server(id);
    assertDomain(domain);
    if (!['lock', 'unlock', 'fixPerms'].includes(action)) throw new AppError('errors.action_unknown', { status: 400, vars: { action: String(action).slice(0, 30) } });
    this.#assertCapable(s, action);
    if ((await this.#status(s, domain)) === 'missing') throw new AppError('errors.domain_not_found', { status: 404, vars: { domain, server: s.label } });

    let r;
    if (action === 'fixPerms') {
      r = await this.ssh.exec(id, renderTemplate(s.commands.fixPerms, { domain }), { timeout: 300000 });
      this.#check(s, r);
    } else {
      // lockop = compte à commande forcée : il reçoit "lock <domaine>" brut dans $SSH_ORIGINAL_COMMAND.
      const lk = s.lockop;
      const target = { host: lk.host, port: lk.port, username: lk.username, auth: lk.auth };
      r = await this.ssh.execOnce(`${s.label} (lockop)`, target, renderTemplate(lk[action], { domain }, { quote: false }), { timeout: 60000 });
      if (r.code !== 0) {
        // lockop valide les sites sur SA propre liste (côté hôte), distincte de /srv/www du
        // conteneur : un domaine présent ici peut lui être inconnu. On le dit explicitement.
        const out = `${r.stderr}\n${r.stdout}`;
        const key = /invalide|inconnu|invalid|unknown/i.test(out) ? 'errors.lock_unknown_site' : 'errors.ssh_lock_failed';
        throw new AppError(key, { status: 409, vars: { server: s.label, domain }, detail: tail(r) });
      }
    }
    const status = await this.#status(s, domain);
    this.#patch(id, domain, { status });
    return { domain, action, status, output: (r.stdout || r.stderr).trim() };
  }

  async remove(id, domain, confirm) {
    const s = this.ssh.server(id);
    assertDomain(domain);
    if (confirm !== domain) throw new AppError('errors.confirm_mismatch', { status: 400 });
    this.#assertCapable(s, 'delete');
    const status = await this.#status(s, domain);
    if (status === 'missing') throw new AppError('errors.domain_not_found', { status: 404, vars: { domain, server: s.label } });
    if (status === 'locked') throw new AppError('errors.domain_locked', { status: 409, vars: { domain } });

    const r = await this.ssh.exec(id, renderTemplate(s.commands.delete, { domain }), { timeout: 300000 });
    this.#check(s, r);
    const hit = this.cache.get(id);
    if (hit) {
      hit.items = hit.items.filter((d) => d.name !== domain);
      hit.stats = computeStats(hit.items);
    }
    return { domain, output: r.stdout.trim() };
  }

  async #status(s, domain) {
    const r = await this.ssh.exec(s.id, statusCommand(s, domain), { timeout: 15000 });
    this.#check(s, r);
    return r.stdout.trim();
  }

  #assertCapable(s, action) {
    const cap = capability(s, action, this.sudo.get(s.id));
    if (!cap.ok) {
      const vars = { action: `@action.${ACTION_KEYS[action]}`, server: s.label, reason: `@reason.${cap.reason}` };
      throw new AppError('errors.action_unavailable', { status: 403, vars });
    }
  }

  #check(s, r) {
    if (r.code === 0) return;
    const out = `${r.stderr}\n${r.stdout}`;
    if (isSudoDenied(out)) throw new AppError('errors.ssh_sudo_denied', { status: 403, vars: { server: s.label }, detail: tail(r) });
    throw new AppError('errors.ssh_command_failed', { status: 502, vars: { server: s.label, code: r.code ?? r.signal }, detail: tail(r) });
  }

  #patch(id, domain, fields) {
    const hit = this.cache.get(id);
    const item = hit?.items.find((d) => d.name === domain);
    if (!item) return;
    Object.assign(item, fields);
    hit.stats = computeStats(hit.items);
  }
}

const tail = (r) => (r.stderr || r.stdout || '').trim().slice(-2000) || undefined;
