import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { authenticate } from '../src/auth/authService.js';
import { hashPassword } from '../src/auth/password.js';
import { config } from '../src/config.js';
import { createUser, findUserByLogin, getRoleByKey, updateUser } from '../src/db/repositories.js';
import { prepare } from '../src/db/mysql.js';
import { creerBaseJetable } from './mysqlTestDb.js';

/**
 * Se connecter : par son identifiant OU par son adresse, et savoir ce qui cloche.
 *
 * L'administrateur crée les comptes et remplit l'adresse de chaque agent — c'est elle
 * qu'il a sous la main, et c'est elle qu'il communique. L'agent la tapait pour entrer et
 * se voyait refuser : seul l'identifiant était accepté, et le message ne disait pas
 * lequel des deux champs reprendre.
 */
const base = creerBaseJetable('login');
before(() => base.ouvrir());
after(() => base.fermer());

const MDP = 'un-mot-de-passe-assez-long';

/** Un compte neuf, dans une table vidée. */
async function compte({ username, email = '', password = MDP } = {}) {
  const role = await getRoleByKey('viewer');
  return createUser({ username, email, password, roleId: role.id, mustChangePassword: false });
}

async function surTableVide(fn) {
  await base.vider('user_servers', 'sessions', 'users');
  return fn();
}

/** Ce qu'une tentative de connexion a levé, ou null si elle a réussi. */
const essai = async (login, mdp) => {
  try {
    await authenticate(login, mdp);
    return null;
  } catch (err) {
    return err;
  }
};

test('connexion : l’identifiant comme l’adresse ouvrent la même porte', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    await compte({ username: 'cyntia', email: 'cyntia@gmail.com' });

    assert.equal((await authenticate('cyntia', MDP)).username, 'cyntia');
    assert.equal((await authenticate('cyntia@gmail.com', MDP)).username, 'cyntia', 'l’adresse doit mener au même compte');
    // L'agent recopie ce qu'on lui a écrit : la casse ne doit pas le trahir.
    assert.equal((await authenticate('CYNTIA@GMAIL.COM', MDP)).username, 'cyntia');
  });
});

test('connexion : une adresse peut aussi être l’identifiant', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // C'est ce que l'administrateur avait tenté. La règle refusait l'arobase, et
    // l'erreur ne remontait même pas jusqu'à l'écran : le compte n'était pas créé, et
    // le message annonçait pourtant une création.
    const u = await compte({ username: 'good@gmail.com' });
    assert.equal(u.username, 'good@gmail.com');
    assert.equal((await authenticate('good@gmail.com', MDP)).username, 'good@gmail.com');
  });
});

test('connexion : un identifiant reste refusé s’il ne ressemble à rien', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    for (const mauvais of ['ab', '', ' ', 'avec espace', 'a'.repeat(65), '-commence-par-un-tiret']) {
      await assert.rejects(
        () => compte({ username: mauvais }),
        (err) => err.key === 'errors.user_name_invalid',
        `doit être refusé : ${JSON.stringify(mauvais)}`,
      );
    }
  });
});

test('connexion : le message dit LEQUEL des deux champs cloche', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    await compte({ username: 'cyntia', email: 'cyntia@gmail.com' });

    // « Identifiant ou mot de passe incorrect » ne dit pas quoi reprendre. Pour un agent
    // non technique, c'est la différence entre corriger en dix secondes et appeler
    // l'administrateur.
    const inconnu = await essai('personne', MDP);
    assert.equal(inconnu.key, 'errors.auth_unknown_user');
    assert.equal(inconnu.status, 401);
    assert.equal(inconnu.vars.login, 'personne', 'le message rappelle ce qui a été tapé');

    const faux = await essai('cyntia', 'ce-n-est-pas-le-bon');
    assert.equal(faux.key, 'errors.auth_wrong_password');
    // Combien d'essais restent : le verrouillage ne doit pas tomber par surprise.
    assert.equal(faux.vars.remaining, config.loginMaxAttempts - 1);

    const fauxParAdresse = await essai('cyntia@gmail.com', 'ce-n-est-pas-le-bon');
    assert.equal(fauxParAdresse.key, 'errors.auth_wrong_password', 'même diagnostic en entrant par l’adresse');
    assert.equal(fauxParAdresse.vars.remaining, config.loginMaxAttempts - 2, 'et le décompte suit');
  });
});

test('connexion : un compte désactivé le dit, au lieu de se faire passer pour inconnu', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    const u = await compte({ username: 'parti', email: 'parti@gmail.com' });
    await updateUser(u.id, { isActive: false });

    const err = await essai('parti', MDP);
    assert.equal(err.key, 'errors.auth_disabled');
    assert.equal(err.status, 403);
    // Même avec le bon mot de passe : on ne laisse pas croire à une faute de frappe.
    assert.equal((await essai('parti@gmail.com', MDP)).key, 'errors.auth_disabled');
  });
});

test('connexion : après trop d’échecs, le compte se verrouille et le dit', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    await compte({ username: 'cyntia', email: 'cyntia@gmail.com' });

    let dernier = null;
    for (let i = 0; i < config.loginMaxAttempts; i += 1) dernier = await essai('cyntia', 'faux');
    assert.equal(dernier.key, 'errors.auth_locked');
    assert.equal(dernier.status, 429);
    assert.equal(dernier.vars.minutes, config.loginLockMinutes);

    // Le BON mot de passe ne passe pas non plus : sinon le verrou ne servirait à rien.
    assert.equal((await essai('cyntia', MDP)).key, 'errors.auth_locked');

    // Et une fois le verrou levé, tout reprend.
    await prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username = ?').run('cyntia');
    assert.equal((await authenticate('cyntia', MDP)).username, 'cyntia');
  });
});

test('connexion : une connexion réussie remet le compteur d’échecs à zéro', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    await compte({ username: 'cyntia', email: 'cyntia@gmail.com' });
    await essai('cyntia', 'faux');
    await essai('cyntia', 'faux');
    await authenticate('cyntia', MDP);

    // Sans cette remise à zéro, deux fautes de frappe par semaine finiraient par
    // verrouiller un compte qui fonctionne.
    const apres = await essai('cyntia', 'faux');
    assert.equal(apres.vars.remaining, config.loginMaxAttempts - 1, 'le décompte repart de zéro');
  });
});

test('connexion : une adresse portée par deux comptes ne désigne personne', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // L'identifiant est unique par construction ; l'adresse ne l'est pas. Deviner lequel
    // des deux comptes est visé ouvrirait une session sur le mauvais.
    await compte({ username: 'jumeau.a', email: 'partage@gmail.com' });
    await compte({ username: 'jumeau.b', email: 'partage@gmail.com' });

    const err = await essai('partage@gmail.com', MDP);
    assert.equal(err.key, 'errors.auth_email_ambiguous');
    assert.equal(err.status, 409);

    // Chacun garde sa porte.
    assert.equal((await authenticate('jumeau.a', MDP)).username, 'jumeau.a');
    assert.equal((await authenticate('jumeau.b', MDP)).username, 'jumeau.b');
  });
});

test('connexion : une adresse vide ne sert de clé à personne', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // La plupart des comptes n'ont pas d'adresse. Une recherche sur la chaîne vide les
    // rendrait tous, et la connexion tomberait sur le premier venu.
    await compte({ username: 'sans.adresse' });
    await compte({ username: 'autre.sans' });

    assert.equal((await findUserByLogin('')).user, null);
    assert.equal((await findUserByLogin('   ')).user, null);
    assert.equal((await essai('', MDP)).key, 'errors.auth_unknown_user');
  });
});

test('connexion : la précision des messages se coupe d’un réglage', async (t) => {
  if (!base.prete) return t.skip(base.motif);
  await surTableVide(async () => {
    // Si ce back-office devient joignable depuis l'extérieur, le message unique empêche
    // d'essayer des identifiants pour découvrir lesquels existent. Les deux cas doivent
    // alors être INDISTINGUABLES.
    await compte({ username: 'cyntia', email: 'cyntia@gmail.com' });
    const avant = config.loginPreciseErrors;
    config.loginPreciseErrors = false;
    try {
      const inconnu = await essai('personne', MDP);
      const faux = await essai('cyntia', 'ce-n-est-pas-le-bon');
      assert.equal(inconnu.key, 'errors.auth_invalid');
      assert.equal(faux.key, 'errors.auth_invalid');
      assert.equal(inconnu.status, faux.status);
    } finally {
      config.loginPreciseErrors = avant;
    }
  });
});
