// npm run check [id]  →  teste la connexion SSH à chaque serveur, en LECTURE SEULE
// (authentification, empreinte d'hôte, droits sudo, nombre de domaines). Aucune modification.
import { config, loadServers } from '../src/config.js';
import { loadLocales, translate } from '../src/i18n.js';
import { KnownHosts } from '../src/ssh/knownHosts.js';
import { SshManager } from '../src/ssh/SshManager.js';
import { listCommand, parseList, parseSudo } from '../src/services/parcDriver.js';

loadLocales();
const only = process.argv[2];
const servers = loadServers().filter((s) => !only || s.id === only);
const ssh = new SshManager(servers, { knownHosts: new KnownHosts(config.knownHostsFile), settings: config.ssh });
let failures = 0;

for (const s of servers) {
  const t0 = Date.now();
  process.stdout.write(`${s.label.padEnd(10)} ${`${s.username}@${s.host}:${s.port}`.padEnd(28)} `);
  try {
    await ssh.connect(s.id);
    const sudo = parseSudo((await ssh.exec(s.id, 'sudo -n -l 2>&1 || true', { timeout: 15000 })).stdout);
    const r = await ssh.exec(s.id, listCommand(s), { timeout: 120000 });
    const items = parseList(r.stdout);
    const locked = items.filter((d) => d.status === 'locked').length;
    const rights = sudo.all ? 'ALL' : sudo.commands.map((c) => c.split('/').pop()).join(', ') || '—';
    console.log(`✔ ${items.length} domaines (${locked} verrouillés) · sudo: ${rights} · ${Date.now() - t0} ms`);
    console.log(`${' '.repeat(40)}${ssh.status(s.id).fingerprint}`);
  } catch (err) {
    failures++;
    console.log(`✖ ${err.key ? translate(config.defaultLang, err.key, err.vars) : err.message}`);
  } finally {
    ssh.disconnect(s.id);
  }
}
process.exit(failures ? 1 : 0);
