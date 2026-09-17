import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SshConnection } from '../src/ssh/SshManager.js';

/** Flux SSH minimal : de quoi laisser exec() faire son travail jusqu'au « close ». */
function fauxFlux(sortie = 'ok', code = 0) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.close = () => {};
  // On n'émet qu'une fois les écouteurs posés, sinon le « close » passerait inaperçu.
  setTimeout(() => {
    stream.emit('data', Buffer.from(sortie));
    stream.emit('close', code, null);
  }, 5);
  return stream;
}

/**
 * Connexion prête à l'emploi, sans réseau : on remplace le client ssh2 par un objet
 * dont on pilote le comportement, et `connect()` par une reprise instantanée.
 */
function connexion({ execs }) {
  const conn = new SshConnection('VPS test', { host: '10.0.0.1', port: 22, username: 'x', auth: {} }, { knownHosts: new Map(), settings: { maxParallel: 4, commandTimeout: 1000, idleTimeout: 0 } });
  const client = { exec: (command, cb) => execs.shift()(command, cb), end: () => {} };
  conn.client = client;
  conn.state = 'connected';
  conn.wanted = true;
  conn.reconnexions = 0;
  conn.connect = async () => {
    conn.reconnexions += 1;
    conn.client = client;
    conn.state = 'connected';
    return conn;
  };
  return conn;
}

test('une session tombée est rétablie, et la commande n\'est jouée qu\'une fois', async () => {
  const jouees = [];
  const conn = connexion({
    execs: [
      // ssh2 signale la coupure au moment d'ouvrir le canal : la commande n'a pas démarré.
      (command, cb) => {
        jouees.push(command);
        cb(new Error('No response from server'));
      },
      (command, cb) => {
        jouees.push(command);
        cb(null, fauxFlux('sortie'));
      },
    ],
  });

  const res = await conn.exec('echo bonjour');
  assert.equal(res.stdout, 'sortie');
  assert.equal(conn.reconnexions, 1, 'la session doit être rouverte une seule fois');
  assert.deepEqual(jouees, ['echo bonjour', 'echo bonjour']);
});

test('une erreur qui n\'est pas une coupure remonte sans reprise', async () => {
  const conn = connexion({ execs: [(_c, cb) => cb(new Error('Permission denied'))] });
  await assert.rejects(() => conn.exec('ls'), (err) => /Permission denied/.test(err.message ?? '') || err.key === 'errors.ssh_error');
  assert.equal(conn.reconnexions, 0, 'inutile de rouvrir une session qui répond');
});

test('deux coupures d\'affilée : on abandonne au lieu de boucler', async () => {
  const conn = connexion({
    execs: [
      (_c, cb) => cb(new Error('No response from server')),
      (_c, cb) => cb(new Error('No response from server')),
    ],
  });
  await assert.rejects(() => conn.exec('ls'));
  assert.equal(conn.reconnexions, 1);
});

test('une session fermée par l\'utilisateur n\'est pas rouverte toute seule', async () => {
  const conn = connexion({ execs: [] });
  conn.end({ manual: true });
  await assert.rejects(() => conn.exec('ls'), (err) => err.key === 'errors.ssh_not_connected');
  assert.equal(conn.reconnexions, 0);
});

test('une fermeture pour inactivité, elle, se rattrape', async () => {
  const conn = connexion({ execs: [(_c, cb) => cb(null, fauxFlux('reprise'))] });
  conn.end(); // ce que fait le minuteur d'inactivité
  const res = await conn.exec('ls');
  assert.equal(res.stdout, 'reprise');
  assert.equal(conn.reconnexions, 1);
});
