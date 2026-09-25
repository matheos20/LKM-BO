import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase } from '../src/db/database.js';
import { countEvents, eventFacets, familyOf, purgeOlderThan, queryEvents, recordEvent } from '../src/db/audit.js';

/** Une base jetable, migrée comme en production. */
function surBaseNeuve(fn) {
  const dossier = mkdtempSync(join(tmpdir(), 'lkm-audit-'));
  closeDatabase();
  try {
    openDatabase(join(dossier, 'essai.db'));
    return fn();
  } finally {
    closeDatabase();
    rmSync(dossier, { recursive: true, force: true });
  }
}

const JOUR = 86400000;

test('journal : la couleur se déduit du nom de l’action', () => {
  // Supprimer passe avant tout : une action qui supprime ne doit jamais finir en vert.
  assert.equal(familyOf('file.delete'), 'delete');
  assert.equal(familyOf('categories.remove'), 'delete');
  assert.equal(familyOf('rm'), 'delete');
  assert.equal(familyOf('delete'), 'delete');
  assert.equal(familyOf('user.delete'), 'delete');

  assert.equal(familyOf('user.create'), 'create');
  assert.equal(familyOf('categories.add'), 'create');
  assert.equal(familyOf('file.upload'), 'create');
  assert.equal(familyOf('file.mkdir'), 'create');

  assert.equal(familyOf('file.save'), 'update');
  assert.equal(familyOf('design.publish'), 'update');
  assert.equal(familyOf('design.article_publish'), 'update');
  assert.equal(familyOf('translate.apply'), 'update');
  assert.equal(familyOf('user.password'), 'update');
  assert.equal(familyOf('password.self'), 'update');

  // « unlock » contient « lock » : les deux doivent rester distincts et corrects.
  assert.equal(familyOf('lock'), 'update');
  assert.equal(familyOf('unlock'), 'update');

  assert.equal(familyOf('login'), 'auth');
  assert.equal(familyOf('connect'), 'auth');
  assert.equal(familyOf('disconnect'), 'auth');

  assert.equal(familyOf('file.download'), 'read');
  assert.equal(familyOf('file.download_zip'), 'read');
  assert.equal(familyOf('design.preview'), 'read');

  // Une action inconnue est rangée, pas perdue.
  assert.equal(familyOf('quelque.chose'), 'other');
  assert.equal(familyOf(''), 'other');
  assert.equal(familyOf(undefined), 'other');
});

test('journal : un événement garde le nom de son auteur, même effacé', () => {
  surBaseNeuve(() => {
    recordEvent({ userId: 42, username: 'agent1', displayName: 'Agent Un', role: 'Opérateur', action: 'categories.remove', domain: 'exemple.com', target: '2 rubrique(s)' });
    const { events } = queryEvents();
    assert.equal(events.length, 1);
    const e = events[0];
    // Le nom et le rôle sont RECOPIÉS, jamais joints : ils disent qui agissait alors.
    assert.deepEqual(e.user, { id: 42, username: 'agent1', displayName: 'Agent Un', role: 'Opérateur' });
    assert.equal(e.action, 'categories.remove');
    assert.equal(e.family, 'delete');
    assert.equal(e.domain, 'exemple.com');
    assert.equal(e.ok, true);
  });
});

test('journal : journaliser ne fait jamais échouer l’action', () => {
  surBaseNeuve(() => {
    // Aucune de ces entrées n'est correcte ; aucune ne doit lever.
    assert.doesNotThrow(() => recordEvent({}));
    assert.doesNotThrow(() => recordEvent({ action: null, ok: false }));
    assert.doesNotThrow(() => recordEvent({ action: 'x'.repeat(5000), target: 'y'.repeat(5000) }));
    assert.equal(countEvents(), 3);
    // Les champs trop longs sont coupés, pas refusés.
    const { events } = queryEvents({ perPage: 1 });
    assert.ok(events[0].target.length <= 400);
  });
});

test('journal : chaque filtre se combine aux autres', () => {
  surBaseNeuve(() => {
    const maintenant = Date.now();
    recordEvent({ at: maintenant - 10 * JOUR, username: 'anna', action: 'file.delete', domain: 'a.com', server: 'vps-001' });
    recordEvent({ at: maintenant - 2 * JOUR, username: 'anna', action: 'user.create', domain: null, server: 'vps-001' });
    recordEvent({ at: maintenant - 1 * JOUR, username: 'bruno', action: 'file.delete', domain: 'b.com', server: 'vps-002', ok: false, error: 'refusé' });
    recordEvent({ at: maintenant, username: 'bruno', action: 'login' });

    assert.equal(queryEvents({ user: 'anna' }).total, 2);
    assert.equal(queryEvents({ action: 'file.delete' }).total, 2);
    assert.equal(queryEvents({ family: 'delete' }).total, 2);
    assert.equal(queryEvents({ family: 'auth' }).total, 1);
    assert.equal(queryEvents({ server: 'vps-001' }).total, 2);
    assert.equal(queryEvents({ domain: 'b.com' }).total, 1);
    assert.equal(queryEvents({ ok: false }).total, 1);
    assert.equal(queryEvents({ ok: true }).total, 3);

    // Combinés : Bruno ET une suppression.
    assert.equal(queryEvents({ user: 'bruno', family: 'delete' }).total, 1);
    // Une combinaison sans résultat rend zéro, pas tout.
    assert.equal(queryEvents({ user: 'anna', action: 'login' }).total, 0);

    // Période : les trois derniers jours.
    assert.equal(queryEvents({ from: maintenant - 3 * JOUR }).total, 3);
    assert.equal(queryEvents({ from: maintenant - 3 * JOUR, to: maintenant - JOUR }).total, 2);

    // Le plus récent d'abord : un journal se lit par le haut.
    assert.deepEqual(
      queryEvents().events.map((e) => e.action),
      ['login', 'file.delete', 'user.create', 'file.delete'],
    );
  });
});

test('journal : la recherche libre balaie les colonnes utiles, sans ouvrir de joker', () => {
  surBaseNeuve(() => {
    recordEvent({ username: 'anna', displayName: 'Anna Dupont', action: 'file.save', domain: 'exemple.com', target: 'index.php' });
    recordEvent({ username: 'bruno', displayName: 'Bruno Martin', action: 'categories.add', domain: 'autre.fr', target: 'Sport 100% neuf' });

    assert.equal(queryEvents({ search: 'anna' }).total, 1);
    assert.equal(queryEvents({ search: 'Dupont' }).total, 1); // nom d'affichage
    assert.equal(queryEvents({ search: 'exemple' }).total, 1); // domaine
    assert.equal(queryEvents({ search: 'index.php' }).total, 1); // cible
    assert.equal(queryEvents({ search: 'categories' }).total, 1); // action

    // Les jokers de LIKE sont neutralisés : « % » cherche un pourcentage, pas tout.
    assert.equal(queryEvents({ search: '100%' }).total, 1);
    assert.equal(queryEvents({ search: '%' }).total, 1);
    assert.equal(queryEvents({ search: '_' }).total, 0);
  });
});

test('journal : la pagination tient le compte', () => {
  surBaseNeuve(() => {
    const t0 = Date.now();
    for (let i = 0; i < 25; i += 1) recordEvent({ at: t0 - i * 1000, username: 'anna', action: 'file.save', target: `f${i}` });

    const p1 = queryEvents({ perPage: 10, page: 1 });
    assert.deepEqual([p1.total, p1.pages, p1.page, p1.events.length], [25, 3, 1, 10]);
    assert.equal(p1.events[0].target, 'f0'); // le plus récent

    const p3 = queryEvents({ perPage: 10, page: 3 });
    assert.equal(p3.events.length, 5);
    assert.equal(p3.events.at(-1).target, 'f24'); // le plus ancien

    // Une page hors bornes se replie sur la dernière, au lieu de rendre du vide.
    assert.equal(queryEvents({ perPage: 10, page: 99 }).page, 3);
    assert.equal(queryEvents({ perPage: 10, page: 0 }).page, 1);
    // La taille de page est bornée : on ne demande pas le journal entier d'un coup.
    assert.equal(queryEvents({ perPage: 10000 }).perPage, 200);
  });
});

test('journal : les listes de filtres ne proposent que ce qui existe', () => {
  surBaseNeuve(() => {
    recordEvent({ username: 'anna', displayName: 'Anna Dupont', action: 'file.save' });
    recordEvent({ username: 'anna', displayName: 'Anna Dupont', action: 'file.save' });
    recordEvent({ username: 'bruno', displayName: 'Bruno Martin', action: 'login' });
    recordEvent({ username: '', action: 'connect' }); // sans auteur

    const f = eventFacets();
    // Les plus actifs d'abord, et personne d'inventé.
    assert.deepEqual(
      f.users.map((u) => [u.username, u.count]),
      [['anna', 2], ['bruno', 1]],
    );
    assert.deepEqual(
      f.actions.map((a) => a.action).sort(),
      ['connect', 'file.save', 'login'],
    );
    assert.equal(f.actions.find((a) => a.action === 'file.save').count, 2);
  });
});

test('journal : la purge ne touche que ce qui a dépassé la durée', () => {
  surBaseNeuve(() => {
    const maintenant = Date.now();
    recordEvent({ at: maintenant - 400 * JOUR, action: 'login' });
    recordEvent({ at: maintenant - 200 * JOUR, action: 'login' });
    recordEvent({ at: maintenant - 10 * JOUR, action: 'login' });

    assert.equal(purgeOlderThan(180), 2);
    assert.equal(countEvents(), 1);

    // À 0 — ou sans valeur — rien n'est effacé : la conservation sans limite se dit ainsi.
    assert.equal(purgeOlderThan(0), 0);
    assert.equal(purgeOlderThan(undefined), 0);
    assert.equal(purgeOlderThan(-5), 0);
    assert.equal(countEvents(), 1);
  });
});
