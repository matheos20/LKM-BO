import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { exec, prepare } from '../src/db/mysql.js';
import { creerBaseJetable } from './mysqlTestDb.js';
import { parseCsv, splitCsvLine } from '../src/services/csv.js';
import { analyzeCsv, cloudflareStats, deriveEmail, deriveMissingEmails, importCsv, normalizeDomain, validateRow } from '../src/services/cloudflareImport.js';

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

const base = creerBaseJetable('cloudflare');
before(() => base.ouvrir({ seedRoles: false }));
after(() => base.fermer());

/**
 * Repart de tables Cloudflare VIDES.
 *
 * L'ordre compte : cf_zones pointe vers cf_accounts, et vider le parent avant l'enfant
 * ferait echouer la contrainte.
 */
const avecBase = (fn) => base.vider('cf_zones', 'cf_accounts', 'cf_imports').then(fn);

test('l’import crée les comptes et les zones, et se raconte', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    const csv = [
      EN_TETE,
      ligne('un.com', ID('a'), CLE, ID('1')),
      ligne('deux.com', ID('a'), CLE, ID('2')),
      ligne('trois.com', ID('b'), CLE, 'NULL'),
      ligne('NULL', ID('c'), CLE, ID('3')),
    ].join('\n');

    const r = await importCsv(csv, { source: 'essai.csv' });
    assert.equal(r.accountsAdded, 2, 'deux comptes distincts');
    assert.equal(r.zonesAdded, 3);
    assert.equal(r.skipped, 1);

    const s = await cloudflareStats();
    assert.equal(s.accounts, 2);
    assert.equal(s.zones, 3);
    assert.equal(s.zonesWithId, 2, 'celle sans identifiant est comptée à part');
    assert.equal(s.accountsWithEmail, 0, 'l’export n’apporte aucun e-mail');
    assert.equal(s.lastImport.source, 'essai.csv');
  });
});

test('réimporter le même fichier ne duplique rien', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    const csv = [EN_TETE, ligne('un.com', ID('a'), CLE, ID('1'))].join('\n');
    await importCsv(csv, { source: 'a' });
    const second = await importCsv(csv, { source: 'b' });
    assert.equal(second.accountsAdded, 0);
    assert.equal(second.zonesAdded, 0);
    assert.equal((await cloudflareStats()).zones, 1);
  });
});

test('un import ne pietine pas un e-mail saisi a la main', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  // L'export ne porte aucun e-mail, et sans e-mail une cle globale ne sert a rien.
  // Celui que l'agent complete a la main doit donc survivre au prochain import.
  await avecBase(async () => {
    const csv = [EN_TETE, ligne('un.com', ID('a'), CLE, ID('1'))].join('\n');
    await importCsv(csv, { source: 'a' });

    await prepare("UPDATE cf_accounts SET email = 'agent@linkuma.com' WHERE account_id = ?").run(ID('a'));
    await importCsv(csv, { source: 'b' });

    assert.equal((await prepare('SELECT email FROM cf_accounts WHERE account_id = ?').get(ID('a'))).email, 'agent@linkuma.com');
    assert.equal((await cloudflareStats()).accountsWithEmail, 1);
  });
});

test('une zone qui gagne son identifiant est mise à jour', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    await importCsv([EN_TETE, ligne('un.com', ID('a'), CLE, 'NULL')].join('\n'), { source: 'a' });
    assert.equal((await cloudflareStats()).zonesWithId, 0);
    const r = await importCsv([EN_TETE, ligne('un.com', ID('a'), CLE, ID('9'))].join('\n'), { source: 'b' });
    assert.equal(r.zonesUpdated, 1);
    assert.equal((await cloudflareStats()).zonesWithId, 1);
  });
});

test('un fichier sans les bonnes colonnes est refusé avant d’écrire', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    await assert.rejects(() => importCsv('a,b\n1,2', { source: 'x' }), /colonnes absentes/);
    assert.equal((await cloudflareStats()).zones, 0, 'rien ne doit avoir été écrit');
  });
});

// ───── Ce que MySQL a changé ─────

test('un import qui échoue ne laisse RIEN derrière lui', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    await importCsv([EN_TETE, ligne('deja.com', ID('a'), CLE, ID('1'))].join('\n'), { source: 'premier' });

    // AUCUN CONTENU DE CSV NE PEUT FAIRE ÉCHOUER UNE ÉCRITURE, et c'est voulu : la
    // validation refuse déjà un domaine au-delà de la limite DNS, et les identifiants
    // comme les clés ont une forme de longueur fixe. Pour éprouver l'annulation il faut
    // donc provoquer la panne autrement : on rétrécit la colonne le temps du contrôle.
    //
    // Ce que l'on vérifie ici n'est pas la taille d'une colonne, mais le tout-ou-rien :
    // un import à moitié écrit laisserait des domaines rattachés à des comptes absents,
    // et personne ne saurait où il s'est arrêté.
    await exec('ALTER TABLE cf_zones MODIFY domain VARCHAR(12) NOT NULL');
    try {
      const csv = [
        EN_TETE,
        ligne('court.com', ID('b'), CLE, ID('2')),
        ligne('un-domaine-bien-trop-long.com', ID('c'), CLE, ID('3')),
      ].join('\n');
      await assert.rejects(() => importCsv(csv, { source: 'rate' }), /too long/i);
    } finally {
      await exec('ALTER TABLE cf_zones MODIFY domain VARCHAR(253) NOT NULL');
    }

    const etat = await cloudflareStats();
    assert.equal(etat.zones, 1, 'la zone courte du second import ne doit pas rester');
    assert.equal(etat.accounts, 1, 'ni les comptes qu’il apportait');
    assert.equal(etat.lastImport.source, 'premier', 'ni la trace d’un import qui a échoué');
  });
});

test('un nom de domaine entier tient en base, sans être coupé', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    // La norme DNS autorise 253 caractères. Un domaine tronqué désignerait une AUTRE
    // zone : purger son cache ou changer son SSL toucherait le mauvais site.
    const etiquette = (c) => c.repeat(60);
    const long = `${etiquette('a')}.${etiquette('b')}.${etiquette('c')}.${etiquette('d')}.fr`;
    assert.equal(long.length, 246, 'le domaine d’essai doit être proche de la limite DNS');
    assert.equal(normalizeDomain(long), long, 'et rester valide');

    await importCsv([EN_TETE, ligne(long, ID('a'), CLE, ID('1'))].join('\n'), { source: 'long' });
    const enBase = await prepare('SELECT domain FROM cf_zones WHERE zone_id = ?').get(ID('1'));
    assert.equal(enBase.domain, long, 'le domaine revient complet');
  });
});

test('l’adresse se déduit du domaine, et ne piétine que le vide', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    const csv = [
      EN_TETE,
      // Un compte avec deux domaines : l'adresse prend le premier par ordre alphabétique.
      ligne('b-second.com', ID('a'), CLE, ID('1')),
      ligne('a-premier.com', ID('a'), CLE, ID('2')),
      ligne('autre.com', ID('b'), CLE, ID('3')),
      // Un compte à jeton n'a pas besoin d'adresse : Cloudflare ne la demande pas.
      ligne('jeton.com', ID('c'), JETON, ID('4')),
    ].join('\n');
    await importCsv(csv, { source: 'essai' });

    const apercu = await deriveMissingEmails('linkuma.co', { dryRun: true });
    assert.equal(apercu.candidates, 2, 'les deux comptes à clé globale, pas celui à jeton');
    assert.equal(apercu.updated, 0, 'un aperçu n’écrit rien');
    assert.equal((await cloudflareStats()).accountsWithEmail, 0);

    const r = await deriveMissingEmails('linkuma.co');
    assert.equal(r.updated, 2);
    assert.equal(
      (await prepare('SELECT email FROM cf_accounts WHERE account_id = ?').get(ID('a'))).email,
      'a-premier.com@linkuma.co',
      'le premier domaine par ordre alphabétique',
    );
    assert.equal((await prepare('SELECT email FROM cf_accounts WHERE account_id = ?').get(ID('c'))).email, '', 'le compte à jeton reste sans adresse');

    // Repasser ne doit plus rien trouver : une adresse en place n'est jamais remplacée.
    assert.equal((await deriveMissingEmails('linkuma.co', { dryRun: true })).candidates, 0);
  });
});

test('l’adresse déduite d’un domaine très long tient aussi en base', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    // L'adresse est plus longue que le domaine : sa colonne doit suivre.
    const long = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.fr`;
    await importCsv([EN_TETE, ligne(long, ID('a'), CLE, ID('1'))].join('\n'), { source: 'long' });
    await deriveMissingEmails('linkuma.co');
    const l = await prepare('SELECT email FROM cf_accounts WHERE account_id = ?').get(ID('a'));
    assert.equal(l.email, deriveEmail(long, 'linkuma.co'));
    assert.equal(l.email.length, long.length + 11, 'rien n’a été coupé');
  });
});

test('un gros import ne fait pas un aller-retour par ligne', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    // L'export du parc compte 40 781 lignes. Avec une requête par ligne, l'import
    // prendrait des minutes : c'est tout l'objet de la réécriture par paquets. On ne
    // mesure pas un temps — il dépend de la machine — mais le fait que deux mille
    // lignes entrent, exactes, d'un seul geste.
    const lignes = [EN_TETE];
    for (let i = 0; i < 2000; i += 1) lignes.push(ligne(`d${i}.com`, ID('a'), CLE, ''));
    const r = await importCsv(lignes.join('\n'), { source: 'masse' });
    assert.equal(r.valid, 2000);
    assert.equal(r.zonesAdded, 2000);
    assert.equal(r.accountsAdded, 1, 'un seul compte pour les deux mille domaines');
    assert.equal((await cloudflareStats()).zones, 2000);

    // Réimporter à l'identique ne doit rien écrire : c'est ce qui prouve que la
    // comparaison en mémoire voit bien l'existant.
    const second = await importCsv(lignes.join('\n'), { source: 'masse bis' });
    assert.equal(second.zonesAdded, 0);
    assert.equal(second.zonesUpdated, 0);
    assert.equal(second.accountsUpdated, 0);
  });
});

test('un export ne défait pas ce que l’API a confirmé', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await avecBase(async () => {
    // L'export du parc portait encore l'ancienne zone d'un domaine que « cf verify »
    // avait déjà corrigé auprès de Cloudflare. Chaque import défaisait la correction,
    // et l'opération suivante repartait vers la MAUVAISE ZONE : purger le cache d'un
    // autre site, changer le SSL d'un autre site, sans que rien ne le signale.
    await importCsv([EN_TETE, ligne('zone-perimee.com', ID('a'), CLE, ID('1'))].join('\n'), { source: 'export' });

    // « cf verify » retrouve la vraie zone et pose checked_at.
    await prepare('UPDATE cf_zones SET zone_id = ?, checked_at = ? WHERE domain = ?').run(ID('9'), Date.now(), 'zone-perimee.com');

    // Le même export, rejoué : il porte toujours sa valeur périmée.
    const r = await importCsv([EN_TETE, ligne('zone-perimee.com', ID('a'), CLE, ID('1'))].join('\n'), { source: 'export bis' });
    assert.equal(r.zonesUpdated, 0, 'rien à mettre à jour : la valeur en place est la bonne');
    assert.equal(
      (await prepare('SELECT zone_id FROM cf_zones WHERE domain = ?').get('zone-perimee.com')).zone_id,
      ID('9'),
      'la zone vérifiée doit survivre à l’import',
    );

    // En revanche, une zone JAMAIS vérifiée se laisse corriger par l'export : c'est la
    // seule source dont on dispose pour elle.
    await importCsv([EN_TETE, ligne('jamais-verifiee.com', ID('a'), CLE, 'NULL')].join('\n'), { source: 'a' });
    const maj = await importCsv([EN_TETE, ligne('jamais-verifiee.com', ID('a'), CLE, ID('7'))].join('\n'), { source: 'b' });
    assert.equal(maj.zonesUpdated, 1);
    assert.equal((await prepare('SELECT zone_id FROM cf_zones WHERE domain = ?').get('jamais-verifiee.com')).zone_id, ID('7'));
  });
});
