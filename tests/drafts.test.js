import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { deleteDraft, getDraft, listDrafts, saveDraft, setDraftPreview } from '../src/db/drafts.js';
import { prepare } from '../src/db/mysql.js';
import { creerBaseJetable } from './mysqlTestDb.js';

const base = creerBaseJetable('drafts');
before(() => base.ouvrir());
after(() => base.fermer());

/** Repart d'une table de brouillons VIDE. */
async function surTableVide(fn) {
  await base.vider('site_drafts');
  return fn();
}

const CONFIG = { sections: ['hero', 'prix'], titre: 'Chalets à Chamonix — dès 90 €' };

test('brouillons : ce qu’on enregistre est ce qu’on relit', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const ecrit = await saveDraft({ server: 'vps-001', domain: 'exemple.fr', data: { config: CONFIG }, baseHash: 'abc123' });
    assert.ok(ecrit.id > 0);

    const lu = await getDraft('vps-001', 'exemple.fr');
    // Le JSON revient en objet, accents et symboles compris : utf8mb4 porte tout.
    assert.deepEqual(lu.data.config, CONFIG);
    assert.equal(lu.baseHash, 'abc123');
    assert.equal(lu.kind, 'site');
    assert.equal(lu.target, '');
    // Les horodatages sont des NOMBRES, pas des chaînes : l'interface les compare.
    assert.equal(typeof lu.createdAt, 'number');
    assert.equal(typeof lu.updatedAt, 'number');
    assert.equal(lu.previewToken, null);
    assert.equal(lu.previewAt, null);

    // Un brouillon qui n'existe pas rend « rien », pas une erreur.
    assert.equal(await getDraft('vps-001', 'jamais-vu.fr'), undefined);
  });
});

test('brouillons : réenregistrer remplace, sans doubler ni perdre la date de départ', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const premier = await saveDraft({ server: 'vps-001', domain: 'exemple.fr', data: { v: 1 }, baseHash: 'h1' });

    // On vieillit la ligne pour que l'écart soit mesurable : la fonction prend l'heure
    // elle-même, et deux appels d'affilée tombent dans la même milliseconde.
    const JADIS = Date.now() - 3600000;
    await prepare('UPDATE site_drafts SET created_at = ?, updated_at = ? WHERE id = ?').run(JADIS, JADIS, premier.id);

    const second = await saveDraft({ server: 'vps-001', domain: 'exemple.fr', data: { v: 2 }, baseHash: 'h2' });
    assert.equal(second.id, premier.id); // la MÊME ligne, pas une nouvelle
    assert.deepEqual(second.data, { v: 2 });
    assert.equal(second.baseHash, 'h2');
    // created_at dit quand l'agent a COMMENCÉ : une réécriture ne doit pas l'effacer.
    assert.equal(second.createdAt, JADIS);
    assert.ok(second.updatedAt > JADIS);

    assert.equal(Number((await prepare('SELECT COUNT(*) n FROM site_drafts').get()).n), 1);
  });
});

test('brouillons : le site et chaque article ont le leur', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    await saveDraft({ server: 'vps-001', domain: 'exemple.fr', data: { quoi: 'site' } });
    await saveDraft({ server: 'vps-001', domain: 'exemple.fr', kind: 'article', target: 'velo/a.php', data: { quoi: 'A' } });
    await saveDraft({ server: 'vps-001', domain: 'exemple.fr', kind: 'article', target: 'velo/b.php', data: { quoi: 'B' } });
    // Même domaine sur un AUTRE serveur : deux parcs peuvent héberger le même nom.
    await saveDraft({ server: 'vps-002', domain: 'exemple.fr', data: { quoi: 'ailleurs' } });

    assert.equal((await getDraft('vps-001', 'exemple.fr')).data.quoi, 'site');
    assert.equal((await getDraft('vps-001', 'exemple.fr', 'article', 'velo/a.php')).data.quoi, 'A');
    assert.equal((await getDraft('vps-001', 'exemple.fr', 'article', 'velo/b.php')).data.quoi, 'B');
    assert.equal((await getDraft('vps-002', 'exemple.fr')).data.quoi, 'ailleurs');

    const duDomaine = await listDrafts({ server: 'vps-001', domain: 'exemple.fr' });
    assert.equal(duDomaine.length, 3); // celui de vps-002 n'est pas du lot
    assert.equal((await listDrafts()).length, 4);
    // Le plus récemment touché en tête : c'est l'ordre utile à l'écran.
    const dates = (await listDrafts()).map((d) => d.updatedAt);
    assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  });
});

test('brouillons : un chemin plus long que la colonne se retrouve quand même', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // LE PIÈGE à ne pas rater : la colonne « target » est bornée. Si l'enregistrement
    // taille et que la recherche ne taille pas, le brouillon est écrit sous un nom et
    // cherché sous un autre — il paraît perdu, et l'agent refait son travail.
    const tresLong = `velo/${'x'.repeat(300)}.php`;
    await saveDraft({ server: 'vps-001', domain: 'exemple.fr', kind: 'article', target: tresLong, data: { v: 'long' } });
    const lu = await getDraft('vps-001', 'exemple.fr', 'article', tresLong);
    assert.ok(lu, 'le brouillon doit être retrouvé malgré la coupe');
    assert.equal(lu.data.v, 'long');
    assert.equal(await deleteDraft('vps-001', 'exemple.fr', 'article', tresLong), 1);
  });
});

test('brouillons : la prévisualisation se note sur la ligne, sans toucher au contenu', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const d = await saveDraft({ server: 'vps-001', domain: 'exemple.fr', data: { config: CONFIG } });
    await setDraftPreview(d.id, 'a'.repeat(32));

    const lu = await getDraft('vps-001', 'exemple.fr');
    assert.equal(lu.previewToken, 'a'.repeat(32));
    assert.equal(typeof lu.previewAt, 'number');
    assert.deepEqual(lu.data.config, CONFIG); // le brouillon lui-même n'a pas bougé
  });
});

test('brouillons : effacer ne retire que celui visé, et le dit', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    await saveDraft({ server: 'vps-001', domain: 'exemple.fr', data: { quoi: 'site' } });
    await saveDraft({ server: 'vps-001', domain: 'exemple.fr', kind: 'article', target: 'velo/a.php', data: { quoi: 'A' } });

    // Publier un article efface SON brouillon ; celui du site doit survivre.
    assert.equal(await deleteDraft('vps-001', 'exemple.fr', 'article', 'velo/a.php'), 1);
    assert.ok(await getDraft('vps-001', 'exemple.fr'));
    // Effacer deux fois rend zéro : « removed: false » plutôt qu'une erreur.
    assert.equal(await deleteDraft('vps-001', 'exemple.fr', 'article', 'velo/a.php'), 0);
    assert.equal(await deleteDraft('vps-001', 'exemple.fr'), 1);
    assert.equal((await listDrafts()).length, 0);
  });
});

test('brouillons : l’auteur est rattaché au compte, et le brouillon survit à sa suppression', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const role = await prepare('SELECT id FROM roles WHERE `key` = ?').get('admin');
    const u = await prepare(
      `INSERT INTO users (username, display_name, email, password_hash, role_id, scope_all_servers, must_change_password, created_at, updated_at)
       VALUES ('essai.brouillon', 'Essai', '', 'x', ?, 1, 0, ?, ?)`,
    ).run(role.id, Date.now(), Date.now());

    const d = await saveDraft({ server: 'vps-001', domain: 'exemple.fr', data: { v: 1 }, userId: u.lastInsertRowid });
    assert.equal(d.createdBy, u.lastInsertRowid);

    // Un départ d'agent ne doit pas emporter le travail préparé : la clé étrangère est
    // en ON DELETE SET NULL, le brouillon reste, sans auteur.
    await prepare('DELETE FROM users WHERE id = ?').run(u.lastInsertRowid);
    const apres = await getDraft('vps-001', 'exemple.fr');
    assert.ok(apres, 'le brouillon doit survivre à la suppression du compte');
    assert.equal(apres.createdBy, null);
  });
});
