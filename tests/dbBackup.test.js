import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  backupStamp, decryptFile, describeDbBackup, dumpLooksComplete, encryptFile,
  findMysqlTool, listDbBackups, prepareRestore, pruneBackups,
} from '../src/services/dbBackup.js';

/** Un dossier de travail, effacé à la fin. */
function dansUnDossier(fn) {
  const d = mkdtempSync(join(tmpdir(), 'lkm-sauvegarde-'));
  try {
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** Un faux dump, complet ou tronqué. */
const dump = (complet = true) =>
  `-- MariaDB dump\nDROP TABLE IF EXISTS \`users\`;\nCREATE TABLE \`users\` (id INT);\nINSERT INTO \`users\` VALUES (1),(2);\n${complet ? '-- Dump completed on 2026-10-01 13:00:00\n' : ''}`;

const ecrire = (dir, nom, complet = true) => {
  const f = join(dir, nom);
  writeFileSync(f, dump(complet));
  return f;
};

// ───────── Les noms, et ce qu'ils disent ─────────

test('sauvegarde : l’horodatage est en UTC et se trie tout seul', () => {
  const s = backupStamp(new Date('2026-10-01T07:05:09Z'));
  assert.equal(s, '20261001-070509');
  // Deux sauvegardes de la même journée se classent dans l'ordre par simple comparaison
  // de texte : c'est ce qui permet de ne JAMAIS trier sur la date du fichier, qu'une
  // copie ou une restauration peut fausser.
  assert.ok(backupStamp(new Date('2026-10-01T08:00:00Z')) > s);
  assert.ok(backupStamp(new Date('2026-09-30T23:59:59Z')) < s);
});

test('sauvegarde : un nom se relit, et un fichier étranger n’est pas pris pour une sauvegarde', () => {
  const b = describeDbBackup('lkm-bo-20261001-130319.sql');
  assert.equal(b.stamp, '20261001-130319');
  assert.equal(b.encrypted, false);
  assert.equal(new Date(b.at).toISOString(), '2026-10-01T13:03:19.000Z');

  assert.equal(describeDbBackup('lkm-bo-20261001-130319.sql.enc').encrypted, true);

  // Les anciennes sauvegardes SQLite portaient « .db ». Elles ne sont plus restaurables
  // par ce chemin : mieux vaut ne pas les reconnaître que proposer de rejouer un fichier
  // qu'aucun outil d'ici ne sait lire.
  assert.equal(describeDbBackup('lkm-bo-20261001-130319.db'), null);
  for (const faux of ['autre.sql', 'lkm-bo.sql', 'lkm-bo-2026-10-01.sql', '', null, undefined]) {
    assert.equal(describeDbBackup(faux), null, `ne doit pas être reconnu : ${JSON.stringify(faux)}`);
  }
});

// ───────── L'intégrité d'un dump ─────────

test('sauvegarde : un dump interrompu est reconnu comme incomplet', () => {
  dansUnDossier((d) => {
    // mysqldump n'écrit « Dump completed » qu'à la toute fin. Un dump coupé — disque
    // plein, serveur arrêté, processus tué — s'arrête au milieu d'un INSERT. Le rejouer
    // par-dessus une base saine serait le pire des deux mondes.
    assert.equal(dumpLooksComplete(ecrire(d, 'bon.sql', true)), true);
    assert.equal(dumpLooksComplete(ecrire(d, 'coupe.sql', false)), false);

    // Un fichier vide n'est pas une sauvegarde non plus.
    const vide = join(d, 'vide.sql');
    writeFileSync(vide, '');
    assert.equal(dumpLooksComplete(vide), false);
  });
});

test('sauvegarde : la marque est cherchée à la FIN, pas n’importe où', () => {
  dansUnDossier((d) => {
    // Un dump qui contiendrait ces mots dans une donnée ne doit pas passer pour complet.
    // On lit la fin du fichier, ce qui évite aussi de charger 10 Mo pour un contrôle.
    const piege = join(d, 'piege.sql');
    writeFileSync(piege, `INSERT INTO \`notes\` VALUES ('-- Dump completed on hier');\n${'x'.repeat(2000)}\nINSERT INTO \`users\` VALUES (1),(`);
    assert.equal(dumpLooksComplete(piege), false);
  });
});

test('sauvegarde : une sauvegarde incomplète ne se remet pas en place', () => {
  dansUnDossier((d) => {
    ecrire(d, 'lkm-bo-20261001-130319.sql', false);
    assert.throws(() => prepareRestore({ dir: d, name: 'lkm-bo-20261001-130319.sql' }), /incomplète/);

    ecrire(d, 'lkm-bo-20261001-140000.sql', true);
    const pret = prepareRestore({ dir: d, name: 'lkm-bo-20261001-140000.sql' });
    assert.equal(pret.temporary, false, 'un fichier en clair se rejoue tel quel');
    assert.equal(pret.info.stamp, '20261001-140000');

    assert.throws(() => prepareRestore({ dir: d, name: 'pas-une-sauvegarde.sql' }), /non reconnu/);
    assert.throws(() => prepareRestore({ dir: d, name: 'lkm-bo-20260101-000000.sql' }), /introuvable/);
  });
});

// ───────── Le chiffrement ─────────

test('sauvegarde : chiffrer puis déchiffrer rend les mêmes octets', () => {
  dansUnDossier((d) => {
    const clair = join(d, 'clair.sql');
    // Des accents et des octets non ASCII : un dump en porte, et c'est ce qui se perd
    // le plus facilement au passage par un fichier.
    writeFileSync(clair, `${dump()}INSERT INTO \`a\` VALUES ('Chamonix — dès 90 €');\n`);
    const avant = readFileSync(clair);

    encryptFile(clair, join(d, 'chiffre.enc'), 'une-cle-de-passe');
    assert.notDeepEqual(readFileSync(join(d, 'chiffre.enc')), avant, 'le fichier chiffré ne doit pas ressembler à l’original');

    decryptFile(join(d, 'chiffre.enc'), join(d, 'rendu.sql'), 'une-cle-de-passe');
    assert.deepEqual(readFileSync(join(d, 'rendu.sql')), avant);
  });
});

test('sauvegarde : une mauvaise clé ou un fichier modifié échoue BRUYAMMENT', () => {
  dansUnDossier((d) => {
    const clair = ecrire(d, 'clair.sql');
    encryptFile(clair, join(d, 'c.enc'), 'bonne-cle');

    // Rendre des octets faux serait pire qu'échouer : on croirait tenir une sauvegarde.
    assert.throws(() => decryptFile(join(d, 'c.enc'), join(d, 'x.sql'), 'mauvaise-cle'));

    const abime = readFileSync(join(d, 'c.enc'));
    abime[abime.length - 1] ^= 0xff; // un seul octet changé
    writeFileSync(join(d, 'abime.enc'), abime);
    assert.throws(() => decryptFile(join(d, 'abime.enc'), join(d, 'y.sql'), 'bonne-cle'));
  });
});

test('sauvegarde : une sauvegarde chiffrée est déchiffrée avant d’être rejouée', () => {
  dansUnDossier((d) => {
    const clair = ecrire(d, 'temporaire.sql');
    encryptFile(clair, join(d, 'lkm-bo-20261001-150000.sql.enc'), 'ma-cle');
    rmSync(clair);

    assert.throws(() => prepareRestore({ dir: d, name: 'lkm-bo-20261001-150000.sql.enc' }), /clé est nécessaire/);

    const pret = prepareRestore({ dir: d, name: 'lkm-bo-20261001-150000.sql.enc', secret: 'ma-cle' });
    assert.equal(pret.temporary, true, 'le fichier déchiffré est temporaire : il ne doit pas rester en clair');
    assert.equal(dumpLooksComplete(pret.path), true);
    rmSync(pret.path, { force: true });
  });
});

// ───────── La rotation ─────────

test('sauvegarde : la liste va du plus récent au plus ancien, et ignore les intrus', () => {
  dansUnDossier((d) => {
    ecrire(d, 'lkm-bo-20260101-010000.sql');
    ecrire(d, 'lkm-bo-20261001-130000.sql');
    ecrire(d, 'lkm-bo-20260601-120000.sql');
    writeFileSync(join(d, 'notes.txt'), 'rien à voir');
    writeFileSync(join(d, 'lkm-bo-vieille.db'), 'ancienne sauvegarde SQLite');

    const l = listDbBackups(d);
    assert.deepEqual(l.map((b) => b.stamp), ['20261001-130000', '20260601-120000', '20260101-010000']);
    assert.ok(l.every((b) => b.bytes > 0), 'la taille de chaque fichier est donnée');
    assert.deepEqual(listDbBackups(join(d, 'nulle-part')), [], 'un dossier absent rend une liste vide, pas une erreur');
  });
});

test('sauvegarde : la rotation garde un plancher de trois, même réglée plus bas', () => {
  dansUnDossier((d) => {
    for (let i = 1; i <= 8; i += 1) ecrire(d, `lkm-bo-2026010${i}-120000.sql`);

    // RÉGLÉE À UN, elle en garde trois. On ne doit jamais se retrouver avec une seule
    // copie — qui pourrait être celle de l'incident qu'on cherche justement à défaire.
    const r = pruneBackups({ dir: d, keep: 1 });
    assert.equal(r.kept, 3);
    assert.equal(r.removed.length, 5);
    assert.deepEqual(listDbBackups(d).map((b) => b.stamp), ['20260108-120000', '20260107-120000', '20260106-120000'], 'les trois plus RÉCENTES');
    for (const nom of r.removed) assert.throws(() => statSync(join(d, nom)), 'les autres sont vraiment effacées');
  });
});

test('sauvegarde : la rotation trie sur le NOM, jamais sur la date du fichier', () => {
  dansUnDossier((d) => {
    // Un fichier copié ou restauré porte une date de système qui ne dit rien de son
    // contenu. Trier là-dessus pourrait effacer la sauvegarde la plus récente. Ici la
    // plus ancienne par le nom est écrite en DERNIER : sa date de fichier est la plus
    // récente des quatre, et elle doit quand même partir la première.
    ecrire(d, 'lkm-bo-20261001-120000.sql');
    ecrire(d, 'lkm-bo-20260901-120000.sql');
    ecrire(d, 'lkm-bo-20260501-120000.sql');
    ecrire(d, 'lkm-bo-20260101-120000.sql');

    const r = pruneBackups({ dir: d, keep: 4 });
    assert.equal(r.removed.length, 0, 'à quatre gardées sur quatre, rien ne part');
    // keep: 0 retombe sur le plancher de trois, donc exactement une doit partir.
    const apres = pruneBackups({ dir: d, keep: 0 });
    assert.deepEqual(apres.removed, ['lkm-bo-20260101-120000.sql'], 'la plus ancienne par le NOM, malgré sa date de fichier');
  });
});

// ───────── Les outils du serveur ─────────

test('sauvegarde : un chemin d’outil imposé mais faux n’est pas remplacé en silence', () => {
  // Si l'agent écrit MYSQLDUMP_PATH et se trompe, il doit le savoir. Chercher ailleurs
  // à sa place donnerait une sauvegarde faite par un autre binaire que celui voulu —
  // d'une autre version, peut-être d'un autre serveur.
  assert.equal(findMysqlTool('mysqldump', 'C:/nulle-part/mysqldump.exe'), null);
  assert.equal(findMysqlTool('mysql', '/chemin/inexistant/mysql'), null);
});
