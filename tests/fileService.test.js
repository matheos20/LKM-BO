import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { FileService } from '../src/services/fileService.js';

/**
 * Le gestionnaire de fichiers : ce qu'il refuse de faire.
 *
 * C'est le seul service qui ÉCRIT directement sur les sites en production, et il n'avait
 * aucun contrôle. Ce qui est vérifié ici n'est donc pas ce qu'il sait faire, mais ce
 * qu'il refuse : écrire sur un domaine verrouillé, envoyer un fichier trop gros, sortir
 * du dossier du site. Chacun de ces refus est ce qui sépare une erreur de manipulation
 * d'un incident sur un site visité.
 *
 * Tout passe par un FAUX serveur SSH : on observe les commandes qui PARTIRAIENT, sans
 * qu'aucune n'atteigne une machine.
 */

const LIMITES = {
  maxEntries: 2000,
  maxEditBytes: 2 * 1024 * 1024,
  maxArchiveBytes: 200 * 1024 * 1024,
  maxArchiveEntries: 20000,
  maxBatch: 200,
  maxUploadBytes: 200 * 1024 * 1024,
};

/**
 * Un faux parc SSH.
 *
 * Il note tout ce qu'on lui demande d'exécuter, et rend ce qu'on lui a dit de rendre.
 * `statut` décide de l'état du domaine : c'est lui qui fait la différence entre un site
 * verrouillé et un site ouvert à l'écriture.
 */
function fauxParc({ statut = 'unlocked', code = 0, stdout = '', stderr = '' } = {}) {
  const vu = { exec: [], spawn: [], stdin: [] };
  return {
    vu,
    statut: (s) => { statut = s; },
    server: () => ({ id: 'vps-001', label: 'VPS 001', wwwRoot: '/srv/www' }),
    async exec(id, command) {
      vu.exec.push(command);
      // La seule commande passée par « exec » est la lecture d'état.
      return { code: 0, stdout: `${statut}\n`, stderr: '' };
    },
    async spawn(id, command) {
      vu.spawn.push(command);
      const stream = new EventEmitter();
      stream.end = (data) => {
        vu.stdin.push(data ?? null);
        setImmediate(() => {
          if (stdout) stream.emit('data', Buffer.from(stdout));
          stream.emit('end');
        });
      };
      stream.close = () => stream.emit('end');
      return { stream, done: new Promise((r) => setImmediate(() => setImmediate(() => r({ code, stdout: '', stderr })))) };
    },
  };
}

const service = (parc) => new FileService(parc, { limits: LIMITES });

/** Ce qui a été demandé au serveur, en un seul texte. */
const commandes = (parc) => [...parc.vu.exec, ...parc.vu.spawn].join('\n');

// ───────── Le verrou : ce qui protège un site en ligne ─────────

/**
 * Toutes les écritures, et ce qu'il faut pour les appeler.
 * Elles doivent TOUTES refuser un domaine verrouillé — une seule qui oublierait
 * suffirait à modifier un site qu'on avait justement décidé de figer.
 */
const ECRITURES = [
  ['write', (f) => f.write('vps-001', 'exemple.com', 'index.php', 'du contenu')],
  ['rename', (f) => f.rename('vps-001', 'exemple.com', 'index.php', 'autre.php')],
  ['remove', (f) => f.remove('vps-001', 'exemple.com', ['index.php'])],
  ['upload', (f) => f.upload('vps-001', 'exemple.com', '', 'photo.jpg', Buffer.from('xx'))],
  ['createFile', (f) => f.createFile('vps-001', 'exemple.com', '', 'neuf.php')],
  ['mkdir', (f) => f.mkdir('vps-001', 'exemple.com', '', 'images')],
];

test('fichiers : AUCUNE écriture ne passe sur un domaine verrouillé', async () => {
  for (const [nom, appel] of ECRITURES) {
    const parc = fauxParc({ statut: 'locked' });
    await assert.rejects(
      () => appel(service(parc)),
      (err) => err.key === 'errors.file_locked' && err.status === 409,
      `« ${nom} » doit refuser un domaine verrouillé`,
    );
    // ET LE REFUS ARRIVE AVANT LA COMMANDE : rien ne doit partir vers le serveur.
    assert.equal(parc.vu.spawn.length, 0, `« ${nom} » ne doit envoyer aucune commande`);
  }
});

test('fichiers : un domaine absent se dit, il ne se crée pas', async () => {
  for (const [nom, appel] of ECRITURES) {
    const parc = fauxParc({ statut: 'missing' });
    await assert.rejects(
      () => appel(service(parc)),
      (err) => err.key === 'errors.domain_not_found' && err.status === 404,
      `« ${nom} » sur un domaine absent`,
    );
    assert.equal(parc.vu.spawn.length, 0);
  }
});

test('fichiers : sur un domaine déverrouillé, la commande part', async () => {
  for (const [nom, appel] of ECRITURES) {
    const parc = fauxParc({ statut: 'unlocked', stdout: '12 1700000000' });
    await appel(service(parc)).catch(() => {});
    assert.ok(parc.vu.spawn.length >= 1, `« ${nom} » doit atteindre le serveur`);
    // Et toujours dans le dossier du site, jamais ailleurs.
    assert.match(commandes(parc), /\/srv\/www\/exemple\.com\/public_html/, `« ${nom} » doit viser le docroot`);
  }
});

// ───────── Les limites : contrôlées AVANT l'appel ─────────

test('fichiers : un fichier trop gros est refusé sans traverser le réseau', async () => {
  // Envoyer deux cents mégaoctets pour se les faire refuser à l'arrivée serait absurde :
  // la liaison est lente, et le refus est connu d'avance.
  const parc = fauxParc();
  const trop = 'x'.repeat(LIMITES.maxEditBytes + 1);
  await assert.rejects(
    () => service(parc).write('vps-001', 'exemple.com', 'index.php', trop),
    (err) => err.key === 'errors.file_too_big_edit' && err.status === 413,
  );
  assert.equal(parc.vu.spawn.length, 0, 'aucune commande');
  assert.equal(parc.vu.exec.length, 0, 'et même pas la lecture d’état : le refus vient avant');
});

test('fichiers : un envoi vide ou démesuré est refusé', async () => {
  const parc = fauxParc();
  await assert.rejects(
    () => service(parc).upload('vps-001', 'exemple.com', '', 'vide.txt', Buffer.alloc(0)),
    (err) => err.key === 'errors.file_upload_empty',
  );
  await assert.rejects(
    () => service(parc).upload('vps-001', 'exemple.com', '', 'gros.bin', Buffer.alloc(LIMITES.maxUploadBytes + 1)),
    (err) => err.key === 'errors.file_too_big' && err.status === 413,
  );
  assert.equal(parc.vu.spawn.length, 0);
});

test('fichiers : on ne supprime pas mille fichiers d’un geste', async () => {
  // Une suppression de masse par inadvertance ne doit pas être à un clic près.
  const parc = fauxParc();
  const trop = Array.from({ length: LIMITES.maxBatch + 1 }, (_, i) => `f${i}.php`);
  await assert.rejects(
    () => service(parc).remove('vps-001', 'exemple.com', trop),
    (err) => err.key === 'errors.file_batch_too_big',
  );
  await assert.rejects(() => service(parc).remove('vps-001', 'exemple.com', []), (err) => err.key === 'errors.bad_request');
  assert.equal(parc.vu.spawn.length, 0);
});

// ───────── Les chemins : rester dans le site ─────────

test('fichiers : aucun chemin ne sort du dossier du site', async () => {
  // Le docroot est la frontière. Un « .. » qui passerait donnerait accès aux autres
  // sites de la machine, et au système.
  const parc = fauxParc();
  for (const mauvais of ['../secret', 'dossier/../../etc/passwd', '..', 'a/./b']) {
    await assert.rejects(
      () => service(parc).write('vps-001', 'exemple.com', mauvais, 'x'),
      (err) => Boolean(err.key),
      `doit être refusé : ${mauvais}`,
    );
  }
  assert.equal(parc.vu.spawn.length, 0, 'aucune de ces tentatives n’atteint le serveur');
});

test('fichiers : un chemin absolu est RAMENÉ dans le site, pas suivi', async () => {
  // Tout chemin est relatif au dossier du site : la barre de tête est simplement
  // ignorée. « /etc/passwd » désigne donc un fichier DU SITE nommé « etc/passwd », et
  // jamais celui du système. Le refuser n'apporterait rien ; le suivre serait grave.
  const parc = fauxParc({ stdout: '3 1700000000' });
  const out = await service(parc).write('vps-001', 'exemple.com', '/etc/passwd', 'x');
  assert.equal(out.path, 'etc/passwd');
  assert.match(commandes(parc), /\/srv\/www\/exemple\.com\/public_html/);
  assert.ok(!/ \/etc\/passwd/.test(commandes(parc)), 'le chemin du système n’apparaît nulle part');
});

test('fichiers : la racine ne s’écrit pas, ne se renomme pas, ne s’efface pas', async () => {
  // Écrire « sur » le dossier racine n'a pas de sens, et l'effacer viderait le site.
  const parc = fauxParc();
  for (const appel of [
    (f) => f.write('vps-001', 'exemple.com', '', 'x'),
    (f) => f.rename('vps-001', 'exemple.com', '', 'autre'),
    (f) => f.remove('vps-001', 'exemple.com', ['']),
  ]) {
    await assert.rejects(() => appel(service(parc)), (err) => Boolean(err.key));
  }
  assert.equal(parc.vu.spawn.length, 0);
});

test('fichiers : un nom d’entrée douteux est refusé', async () => {
  const parc = fauxParc();
  for (const mauvais of ['..', '.', 'a/b', '', '   ']) {
    await assert.rejects(
      () => service(parc).mkdir('vps-001', 'exemple.com', '', mauvais),
      (err) => Boolean(err.key),
      `doit être refusé : ${JSON.stringify(mauvais)}`,
    );
  }
});

test('fichiers : un domaine qui n’en est pas un est refusé avant tout', async () => {
  const parc = fauxParc();
  for (const mauvais of ['exemple.com; rm -rf /', '../autre.com', 'exemple com', '']) {
    await assert.rejects(
      () => service(parc).list('vps-001', mauvais, ''),
      (err) => Boolean(err.key),
      `doit être refusé : ${JSON.stringify(mauvais)}`,
    );
  }
  assert.equal(parc.vu.spawn.length, 0, 'le nom du domaine est validé avant de construire la moindre commande');
});

// ───────── Ce que le serveur répond ─────────

test('fichiers : un fichier déjà là ne s’écrase pas en silence', async () => {
  // Le code 79 est la convention du script serveur pour « ce nom est pris ».
  const parc = fauxParc({ code: 79 });
  await assert.rejects(
    () => service(parc).createFile('vps-001', 'exemple.com', '', 'index.php'),
    (err) => err.key === 'errors.file_exists' && err.status === 409,
  );
});

test('fichiers : une modification concurrente arrête l’écriture', async () => {
  // Le code 82 dit que le fichier a changé depuis sa lecture : écraser ferait perdre le
  // travail de quelqu'un d'autre, sans que personne ne s'en aperçoive.
  const parc = fauxParc({ code: 82 });
  await assert.rejects(
    () => service(parc).write('vps-001', 'exemple.com', 'index.php', 'x', { expectMtime: 1700000000 }),
    (err) => err.key === 'errors.file_conflict' && err.status === 409,
  );
});

test('fichiers : une panne du serveur remonte telle quelle, avec sa sortie', async () => {
  const parc = fauxParc({ code: 7, stderr: 'disque plein' });
  await assert.rejects(
    () => service(parc).createFile('vps-001', 'exemple.com', '', 'neuf.php'),
    (err) => err.status === 502 && /disque plein/.test(err.detail ?? ''),
  );
});

test('fichiers : renommer vers le même nom ne touche à rien', async () => {
  // Inutile de déranger la production — et de prendre le risque — pour ne rien changer.
  const parc = fauxParc();
  const out = await service(parc).rename('vps-001', 'exemple.com', 'dossier/index.php', 'index.php');
  assert.deepEqual(out, { path: 'dossier/index.php', name: 'index.php' });
  assert.equal(parc.vu.spawn.length, 0, 'aucune commande envoyée');
  assert.equal(parc.vu.exec.length, 0, 'ni même la lecture d’état');
});

test('fichiers : une archive qui n’est pas un zip ne se décompresse pas', async () => {
  const parc = fauxParc();
  await assert.rejects(
    () => service(parc).upload('vps-001', 'exemple.com', '', 'photo.jpg', Buffer.from('xx'), { extract: true }),
    (err) => err.key === 'errors.file_zip_invalid',
  );
});
