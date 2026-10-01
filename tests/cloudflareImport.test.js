import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getDb, openDatabase } from '../src/db/database.js';
import { parseCsv, splitCsvLine } from '../src/services/csv.js';
import { analyzeCsv, cloudflareStats, importCsv, normalizeDomain, validateRow } from '../src/services/cloudflareImport.js';

const CLE = 'a'.repeat(37); // une clé globale : 37 hexadécimaux
const JETON = 'T'.repeat(40); // un jeton d'API : 40 alphanumériques
const ID = (c) => c.repeat(32);

const EN_TETE = '"domain","account_id","global_api_key","zone_id"';
const ligne = (d, a, k, z) => `"${d}","${a}","${k}","${z}"`;

// ───────── Le lecteur de CSV ─────────

test('une ligne se découpe en respectant les guillemets', () => {
  assert.deepEqual(splitCsvLine('"a","b","c"'), ['a', 'b', 'c']);
  assert.deepEqual(splitCsvLine('a,b,c'), ['a', 'b', 'c']);
  // Une virgule à l'intérieur d'une valeur ne sépare rien.
  assert.deepEqual(splitCsvLine('"un, deux",trois'), ['un, deux', 'trois']);
  // Deux guillemets de suite valent un guillemet.
  assert.deepEqual(splitCsvLine('"il a dit ""oui""",x'), ['il a dit "oui"', 'x']);
  assert.deepEqual(splitCsvLine('a,,c'), ['a', '', 'c']);
});

test('une ligne au mauvais nombre de champs est mise de côté, pas devinée', () => {
  const { rows, malformed } = parseCsv(`a,b,c\n1,2,3\n4,5\n6,7,8`);
  assert.equal(rows.length, 2);
  assert.equal(malformed.length, 1);
  assert.equal(malformed[0].line, 3, 'le numéro de ligne doit permettre de la retrouver');
});

test('un marqueur d’ordre d’octets en tête ne casse pas la première colonne', () => {
  const { columns } = parseCsv('﻿domain,account_id\nx.com,abc');
  assert.equal(columns[0], 'domain');
});

// ───────── La validation d'une ligne ─────────

test('le texte « NULL » d’un export vaut une absence', () => {
  assert.equal(normalizeDomain('NULL'), '');
  assert.equal(validateRow({ domain: 'NULL', account_id: ID('a'), global_api_key: CLE, zone_id: ID('b') }).ok, false);
  assert.equal(validateRow({ domain: 'x.com', account_id: 'NULL', global_api_key: CLE, zone_id: ID('b') }).reason, 'compte absent');
});

test('le domaine est ramené à sa forme canonique', () => {
  assert.equal(normalizeDomain('  EXEMPLE.COM '), 'exemple.com');
  assert.equal(normalizeDomain('https://www.exemple.com/page'), 'exemple.com');
  assert.equal(normalizeDomain('exemple.com.'), 'exemple.com');
  assert.equal(normalizeDomain('sous.exemple.co.uk'), 'sous.exemple.co.uk');
  // Et ce qui n'est pas un domaine est refusé plutôt que rafistolé.
  for (const mauvais of ['exemple', 'ex emple.com', '-x.com', 'x-.com', '.com', '']) {
    assert.equal(normalizeDomain(mauvais), '', `doit être refusé : ${JSON.stringify(mauvais)}`);
  }
});

test('la clé globale et le jeton se distinguent par leur forme', () => {
  const avecCle = validateRow({ domain: 'x.com', account_id: ID('a'), global_api_key: CLE, zone_id: ID('b') });
  assert.equal(avecCle.key, CLE);
  assert.equal(avecCle.token, '');

  const avecJeton = validateRow({ domain: 'x.com', account_id: ID('a'), global_api_key: JETON, zone_id: ID('b') });
  assert.equal(avecJeton.token, JETON);
  assert.equal(avecJeton.key, '');

  assert.equal(validateRow({ domain: 'x.com', account_id: ID('a'), global_api_key: 'court', zone_id: '' }).reason, 'accès mal formé');
});

test('une zone absente n’empêche pas la ligne d’entrer', () => {
  // L'API sait retrouver la zone depuis le domaine : ce n'est pas un motif de rejet.
  const r = validateRow({ domain: 'x.com', account_id: ID('a'), global_api_key: CLE, zone_id: 'NULL' });
  assert.equal(r.ok, true);
  assert.equal(r.zoneId, '');
});

// ───────── L'analyse, qui n'écrit rien ─────────

test('l’analyse compte ce qui entrera, et pourquoi le reste n’entre pas', () => {
  const csv = [
    EN_TETE,
    ligne('bon.com', ID('a'), CLE, ID('b')),
    ligne('sans-zone.com', ID('a'), CLE, 'NULL'),
    ligne('NULL', ID('a'), CLE, ID('b')),
    ligne('mauvais-compte.com', 'xyz', CLE, ID('b')),
  ].join('\n');

  const r = analyzeCsv(csv);
  assert.equal(r.rowsRead, 4);
  assert.equal(r.valid, 2);
  assert.equal(r.withoutZone, 1);
  assert.equal(r.skipped, 2);
  assert.equal(r.accounts, 1, 'le même compte porte les deux domaines');
  // Le texte << NULL >> vaut une absence ; une chaine qui n'est pas un domaine est
  // invalide. Les deux motifs sont distincts, et c'est voulu.
  assert.deepEqual(Object.keys(r.reasons).sort(), ['compte mal formé', 'domaine absent']);
  assert.ok(r.samples.length, 'des exemples sont donnés pour que l’agent voie ce qui cloche');
});

test('l’analyse distingue un doublon pur d’un doublon divergent', () => {
  const csv = [
    EN_TETE,
    ligne('x.com', ID('a'), CLE, ID('b')),
    ligne('x.com', ID('a'), CLE, ID('b')), // à l'identique
    ligne('y.com', ID('a'), CLE, ID('b')),
    ligne('y.com', ID('c'), CLE, ID('d')), // valeurs différentes
  ].join('\n');

  const r = analyzeCsv(csv);
  assert.equal(r.duplicates, 2);
  assert.equal(r.conflicts, 1, 'un seul des deux doublons oblige à trancher');
  assert.equal(r.domains, 2);
});

test('un en-tête sans les colonnes indispensables est refusé net', () => {
  const r = analyzeCsv('autre,colonne\n1,2');
  assert.deepEqual(r.missingColumns, ['domain', 'account_id']);
  assert.equal(r.valid, 0);
});

// ───────── L'écriture en base ─────────

const avecBase = (fn) => {
  const dossier = mkdtempSync(join(tmpdir(), 'lkm-cf-'));
  openDatabase(join(dossier, 'essai.db'));
  try {
    fn();
  } finally {
    closeDatabase();
    rmSync(dossier, { recursive: true, force: true });
  }
};

test('l’import crée les comptes et les zones, et se raconte', () => {
  avecBase(() => {
    const csv = [
      EN_TETE,
      ligne('un.com', ID('a'), CLE, ID('1')),
      ligne('deux.com', ID('a'), CLE, ID('2')),
      ligne('trois.com', ID('b'), CLE, 'NULL'),
      ligne('NULL', ID('c'), CLE, ID('3')),
    ].join('\n');

    const r = importCsv(csv, { source: 'essai.csv' });
    assert.equal(r.accountsAdded, 2, 'deux comptes distincts');
    assert.equal(r.zonesAdded, 3);
    assert.equal(r.skipped, 1);

    const s = cloudflareStats();
    assert.equal(s.accounts, 2);
    assert.equal(s.zones, 3);
    assert.equal(s.zonesWithId, 2, 'celle sans identifiant est comptée à part');
    assert.equal(s.accountsWithEmail, 0, 'l’export n’apporte aucun e-mail');
    assert.equal(s.lastImport.source, 'essai.csv');
  });
});

test('réimporter le même fichier ne duplique rien', () => {
  avecBase(() => {
    const csv = [EN_TETE, ligne('un.com', ID('a'), CLE, ID('1'))].join('\n');
    importCsv(csv, { source: 'a' });
    const second = importCsv(csv, { source: 'b' });
    assert.equal(second.accountsAdded, 0);
    assert.equal(second.zonesAdded, 0);
    assert.equal(cloudflareStats().zones, 1);
  });
});

test('un import ne pietine pas un e-mail saisi a la main', () => {
  // L'export ne porte aucun e-mail, et sans e-mail une cle globale ne sert a rien.
  // Celui que l'agent complete a la main doit donc survivre au prochain import.
  avecBase(() => {
    const csv = [EN_TETE, ligne('un.com', ID('a'), CLE, ID('1'))].join('\n');
    importCsv(csv, { source: 'a' });

    getDb().prepare("UPDATE cf_accounts SET email = 'agent@linkuma.com' WHERE account_id = ?").run(ID('a'));
    importCsv(csv, { source: 'b' });

    assert.equal(getDb().prepare('SELECT email FROM cf_accounts WHERE account_id = ?').get(ID('a')).email, 'agent@linkuma.com');
    assert.equal(cloudflareStats().accountsWithEmail, 1);
  });
});

test('une zone qui gagne son identifiant est mise à jour', () => {
  avecBase(() => {
    importCsv([EN_TETE, ligne('un.com', ID('a'), CLE, 'NULL')].join('\n'), { source: 'a' });
    assert.equal(cloudflareStats().zonesWithId, 0);
    const r = importCsv([EN_TETE, ligne('un.com', ID('a'), CLE, ID('9'))].join('\n'), { source: 'b' });
    assert.equal(r.zonesUpdated, 1);
    assert.equal(cloudflareStats().zonesWithId, 1);
  });
});

test('un fichier sans les bonnes colonnes est refusé avant d’écrire', () => {
  avecBase(() => {
    assert.throws(() => importCsv('a,b\n1,2', { source: 'x' }), /colonnes absentes/);
    assert.equal(cloudflareStats().zones, 0, 'rien ne doit avoir été écrit');
  });
});
