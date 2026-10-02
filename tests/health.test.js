import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildHealth } from '../src/routes/health.js';
import { attente } from '../scripts/supervise.js';

/**
 * La santé de l'application, et le surveillant qui la relit.
 *
 * Deux règles seulement, mais ce sont elles qui décident de relancer la production :
 * ce qui compte comme une panne, et combien de temps attendre avant de réessayer.
 */
const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVEUR = readFileSync(join(RACINE, 'src/server.js'), 'utf8');

/** Un faux parc SSH, sans aucune connexion réelle. */
const fauxSsh = (etats) => ({
  list: () => etats.map((_, i) => ({ id: `vps-00${i + 1}` })),
  peek: (id) => etats[Number(id.slice(-1)) - 1],
});

test('santé : la base en panne fait tomber le verdict, et le code HTTP avec', async () => {
  const bon = await buildHealth({ startedAt: Date.now() - 5000, ping: async () => ({ ok: true, ms: 3 }) });
  assert.equal(bon.status, 'ok');
  assert.equal(bon.checks.database.ok, true);
  assert.equal(bon.uptimeSeconds, 5);

  const mauvais = await buildHealth({ startedAt: Date.now(), ping: async () => ({ ok: false, ms: 3000, error: 'pas de réponse' }) });
  assert.equal(mauvais.status, 'down');
  assert.equal(mauvais.checks.database.error, 'pas de réponse');
});

test('santé : un VPS déconnecté n’est PAS une panne', async () => {
  // C'est l'état normal au démarrage : les sessions SSH s'ouvrent à la demande de
  // l'agent. Les compter comme un problème ferait sonner l'alarme tous les matins, et
  // on finirait par ne plus la regarder — ce qui est pire que pas d'alarme du tout.
  const bilan = await buildHealth({
    startedAt: Date.now(),
    ping: async () => ({ ok: true, ms: 2 }),
    ssh: fauxSsh([null, null, null, null, null]),
  });
  assert.equal(bilan.status, 'ok');
  assert.deepEqual(bilan.checks.servers, { configured: 5, connected: 0, connecting: 0, error: 0, disconnected: 5 });
});

test('santé : les sessions sont comptées par état, et un état inconnu ne se perd pas', async () => {
  const bilan = await buildHealth({
    startedAt: Date.now(),
    ping: async () => ({ ok: true, ms: 2 }),
    ssh: fauxSsh(['connected', 'connected', 'error', 'connecting', 'quelque-chose-de-neuf']),
  });
  const s = bilan.checks.servers;
  assert.equal(s.configured, 5);
  assert.equal(s.connected, 2);
  assert.equal(s.error, 1);
  assert.equal(s.connecting, 1);
  // Un état que ce code ne connaît pas encore est compté quelque part, jamais oublié :
  // la somme doit retomber sur le nombre de serveurs déclarés.
  assert.equal(s.connected + s.connecting + s.error + s.disconnected, s.configured);
});

test('santé : le relevé n’OUVRE aucune session SSH', async () => {
  // `ssh.status(id)` crée l'objet de connexion au premier appel. Le surveillant passe
  // toutes les trente secondes : s'il l'employait, surveiller finirait par peser plus
  // que servir. Ce contrôle échouerait si quelqu'un revenait à `status`.
  let creations = 0;
  const ssh = {
    list: () => [{ id: 'vps-001' }, { id: 'vps-002' }],
    peek: () => null,
    conn: () => { creations += 1; return {}; },
    status: () => { creations += 1; return { state: 'disconnected' }; },
  };
  await buildHealth({ startedAt: Date.now(), ping: async () => ({ ok: true, ms: 1 }), ssh });
  assert.equal(creations, 0, 'le relevé ne doit créer aucune connexion');
});

test('santé : la route répond AVANT l’authentification', () => {
  // Ce qui surveille une application ne peut pas se connecter avec un compte. Montée
  // après `requireAuth`, la route répondrait 401 à tout surveillant — et un 401 se
  // lirait comme « l'application tourne », alors qu'on n'en saurait rien.
  const sante = SERVEUR.indexOf("app.use('/api/health'");
  const auth = SERVEUR.indexOf("app.use('/api', requireAuth)");
  assert.ok(sante >= 0, 'la route de santé doit être montée');
  assert.ok(sante < auth, 'elle doit précéder l’authentification');
});

test('surveillant : l’attente double à chaque échec, puis plafonne', () => {
  // Un serveur qui ne PEUT pas démarrer — MySQL arrêté, .env incomplet — ne démarrera
  // pas davantage à la centième tentative. Réessayer sans fin remplirait le disque de
  // journaux et masquerait la cause.
  assert.equal(attente(0), 0, 'la première relance est immédiate : une panne isolée arrive');
  assert.equal(attente(1), 1000);
  assert.equal(attente(2), 2000);
  assert.equal(attente(3), 4000);
  assert.equal(attente(4), 8000);
  assert.equal(attente(10), 60_000, 'le plafond est d’une minute');
  assert.equal(attente(100), 60_000, 'et il tient');

  // Une entrée absurde ne doit pas produire une attente absurde.
  for (const n of [-5, null, undefined, NaN, 'trois']) {
    assert.equal(attente(n), 0, `attente(${JSON.stringify(n)})`);
  }
});

test('surveillant : il se lance par « npm run serve », et le service l’appelle', () => {
  const pkg = JSON.parse(readFileSync(join(RACINE, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.serve, /supervise\.js/, '« npm run serve » doit passer par le surveillant');
  assert.match(pkg.scripts.start, /src\/server\.js/, '« npm start » reste le lancement nu, pour comprendre une panne');

  // La tâche planifiée doit lancer le SURVEILLANT, pas le serveur : déclarer le serveur
  // directement rendrait la tâche inutile dès le premier arrêt.
  const service = readFileSync(join(RACINE, 'scripts/service.js'), 'utf8');
  assert.match(service, /supervise\.js/);
  const unite = readFileSync(join(RACINE, 'deploy/lkm-bo.service'), 'utf8');
  assert.match(unite, /ExecStart=.*supervise\.js/);
  assert.match(unite, /Restart=always/);
});
