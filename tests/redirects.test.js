import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP_REDIRECTS } from '../src/services/phpScripts.js';
import { ligne, normalizeRequest, urlValide } from '../src/services/redirectService.js';

/**
 * Les redirections 301, éprouvées sur du VRAI PHP.
 *
 * Ce fichier contrôlait l'ancien mécanisme — des règles écrites dans `.htaccess`. Les
 * cinq machines du parc tournent sous nginx, qui ne lit jamais ce fichier : ces
 * contrôles protégeaient donc du code qui ne faisait rien, et leur vert entretenait
 * l'illusion. Ils portent désormais sur ce qui s'exécute réellement.
 *
 * Le mécanisme : un petit fichier PHP est déposé à l'ancienne adresse. Comme il EXISTE,
 * nginx le sert comme une page normale, et PHP y impose son propre 301 — ce que la page
 * d'erreur ne peut pas faire, le vhost écrivant « error_page 404 /404.php » sans le
 * signe « = ».
 */
const phpAbsent = spawnSync('php', ['-v'], { encoding: 'utf8' }).status !== 0;

/**
 * Lance le script sur un parc jetable.
 *
 * `sites` décrit ce qui existe au départ : { 'exemple.com': { '/page.php': 'contenu' } }.
 * Le résultat porte aussi l'état du disque APRÈS, car c'est le fichier obtenu qui fait
 * foi, jamais ce que le script dit avoir fait.
 */
function lancer(sites, request, mode = 'scan', op = 'add') {
  const root = mkdtempSync(join(tmpdir(), 'lkm-red-'));
  try {
    for (const [domaine, fichiers] of Object.entries(sites)) {
      const doc = join(root, domaine, 'public_html');
      mkdirSync(doc, { recursive: true });
      for (const [chemin, contenu] of Object.entries(fichiers ?? {})) {
        const cible = join(doc, chemin);
        mkdirSync(join(cible, '..'), { recursive: true });
        writeFileSync(cible, contenu, 'utf8');
      }
    }
    const res = spawnSync('php', [], {
      input: PHP_REDIRECTS,
      encoding: 'utf8',
      env: {
        ...process.env,
        LKM_ROOT: root,
        LKM_MODE: mode,
        LKM_OP: op,
        LKM_B64: Buffer.from(JSON.stringify(normalizeRequest(request))).toString('base64'),
      },
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    const site = out.sites[0];
    const doc = join(root, Object.keys(sites)[0], 'public_html');
    // L'ÉTAT DU DISQUE EST RELEVÉ MAINTENANT, pas à la demande : le dossier est effacé
    // au retour, et une lecture différée ne trouverait plus rien — elle rendrait « null »
    // pour tout, et ferait croire qu'aucune écriture n'a eu lieu.
    const contenus = new Map();
    const modes = new Map();
    for (const nom of readdirSync(doc)) {
      try {
        contenus.set(`/${nom}`, readFileSync(join(doc, nom), 'utf8'));
        modes.set(`/${nom}`, (statSync(join(doc, nom)).mode & 0o777).toString(8));
      } catch {
        // un dossier, par exemple : il n'a pas de contenu à relire
      }
    }
    site.lire = (chemin) => contenus.get(chemin) ?? null;
    site.mode = (chemin) => modes.get(chemin) ?? null;
    site.registre = (() => {
      try {
        return JSON.parse(contenus.get('/.lkm-redirects.json'));
      } catch {
        return null;
      }
    })();
    site.sauvegardes = existsSync(join(doc, '.lkm-backups')) ? readdirSync(join(doc, '.lkm-backups')) : [];
    return site;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const PARC = { 'exemple.com': { 'index.php': '<?php echo "accueil";' }, 'autre.fr': { 'index.php': '<?php echo "autre";' } };
const UNE = { 'exemple.com': { rules: [{ from: '/vieille.php', to: '/nouvelle.php' }] } };

// ───────── Ce que l'écran et le service annoncent ─────────

test('redirections : l’aperçu montre ce qui sera réellement posé', () => {
  // Plus une ligne de .htaccess : elle n'aurait rien fait, et l'afficher laissait croire
  // le contraire.
  assert.equal(ligne({ from: '/vieille.php', to: '/nouvelle.php' }), '/vieille.php  →  301  →  /nouvelle.php');
});

test('redirections : ce qu’une adresse a le droit d’être', () => {
  assert.equal(urlValide('/page.php'), true);
  assert.equal(urlValide('/actu/sous/page-2.php'), true);

  // Un saut de ligne permettrait d'injecter une seconde en-tête HTTP.
  assert.equal(urlValide('/page.php\nRewriteEngine Off'), false);
  assert.equal(urlValide('/page.php\r\nHeader set X: y'), false);
  assert.equal(urlValide('/page avec espace.php'), false);

  // Une source désigne un chemin de CE site ; une destination peut partir ailleurs —
  // le script serveur dira ensuite si « ailleurs » est acceptable.
  assert.equal(urlValide('https://ailleurs.example/x'), false);
  assert.equal(urlValide('https://ailleurs.example/x', { destination: true }), true);
  assert.equal(urlValide('javascript:alert(1)', { destination: true }), false);
  assert.equal(urlValide(''), false);
});

test('redirections : les deux autorisations suivent la règle jusqu’au serveur', () => {
  // Sans cela, cocher « remplacer » dans l'écran n'aurait aucun effet : la demande
  // arriverait nettoyée de son intention.
  const out = normalizeRequest({ 'exemple.com': { rules: [{ from: '/a.php', to: '/b.php', replace: true, external: true }] } });
  assert.deepEqual(out['exemple.com'].rules[0], { from: '/a.php', to: '/b.php', replace: true, external: true });
  // Et elles valent FAUX par défaut : on ne devine jamais une intention pareille.
  const sobre = normalizeRequest({ 'exemple.com': { rules: [{ from: '/a.php', to: '/b.php' }] } });
  assert.deepEqual(sobre['exemple.com'].rules[0], { from: '/a.php', to: '/b.php', replace: false, external: false });
});

// ───────── Le script serveur ─────────

test('redirections : la vérification n’écrit rien', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(PARC, UNE);
  assert.equal(site.error, undefined);
  assert.equal(site.items[0].state, 'to_add');
  assert.deepEqual(site.existing, []);
  assert.equal(site.lire('/vieille.php'), null, 'aucun fichier posé');
  assert.equal(site.registre, null, 'aucun registre créé');
});

test('redirections : le fichier posé impose un 301, et rien d’autre', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(PARC, UNE, 'apply');
  assert.equal(site.error, undefined);
  assert.equal(site.written, 1);
  const pose = site.lire('/vieille.php');
  assert.match(pose, /header\('Location: \/nouvelle\.php', true, 301\);/);
  assert.match(pose, /^<\?php/);
  assert.match(pose, /exit;/);
  // Il doit porter notre marque, sinon on ne saura plus qu'il est à nous.
  assert.match(pose, /LKM-BO redirection 301/);
  assert.deepEqual(site.registre, { '/vieille.php': '/nouvelle.php' });
});

test('redirections : rejouée, la demande ne change rien', { skip: phpAbsent && 'php absent' }, () => {
  const premier = lancer(PARC, UNE, 'apply');
  const site = lancer(
    { 'exemple.com': { ...PARC['exemple.com'], 'vieille.php': premier.lire('/vieille.php'), '.lkm-redirects.json': premier.lire('/.lkm-redirects.json') } },
    UNE,
  );
  assert.equal(site.items[0].state, 'present');
  assert.equal(site.existing.length, 1);
});

test('redirections : une règle est reconnue même sans registre', { skip: phpAbsent && 'php absent' }, () => {
  // C'EST LE FICHIER QUI FAIT FOI, pas le registre. Celui-ci peut disparaître — une
  // sauvegarde remise en place, un ménage à la main — et la redirection continue de
  // fonctionner. L'état de la règle demandée doit rester juste, sans quoi on la
  // reposerait par-dessus elle-même.
  const pose = lancer(PARC, UNE, 'apply').lire('/vieille.php');
  const site = lancer({ 'exemple.com': { ...PARC['exemple.com'], 'vieille.php': pose } }, UNE);
  assert.equal(site.items[0].state, 'present');
  // En revanche la LISTE des redirections du site s'appuie sur le registre : sans lui,
  // elle est vide. La liste est un confort ; l'état de chaque règle est la garantie.
  assert.equal(site.existing.length, 0);
});

test('redirections : changer la destination remplace le fichier, sans le doubler', { skip: phpAbsent && 'php absent' }, () => {
  const pose = lancer(PARC, UNE, 'apply').lire('/vieille.php');
  const site = lancer(
    { 'exemple.com': { ...PARC['exemple.com'], 'vieille.php': pose } },
    { 'exemple.com': { rules: [{ from: '/vieille.php', to: '/troisieme.php' }] } },
    'apply',
  );
  assert.equal(site.items[0].state, 'conflict');
  assert.equal(site.items[0].current, '/nouvelle.php');
  assert.match(site.lire('/vieille.php'), /Location: \/troisieme\.php/);
  assert.deepEqual(site.registre, { '/vieille.php': '/troisieme.php' });
});

test('redirections : UNE VRAIE PAGE n’est jamais écrasée sans qu’on le demande', { skip: phpAbsent && 'php absent' }, () => {
  // C'est le garde-fou le plus important : une page en ligne remplacée par une
  // redirection disparaîtrait du site, et l'agent ne l'aurait pas voulu.
  const vraie = '<?php echo "une vraie page du site";';
  const avant = lancer({ 'exemple.com': { 'vieille.php': vraie } }, UNE, 'apply');
  assert.equal(avant.items[0].state, 'exists');
  assert.equal(avant.lire('/vieille.php'), vraie, 'la page est intacte, à l’octet près');
  assert.equal(avant.written, 0);

  // Avec l'autorisation explicite, elle devient une redirection — et l'ancienne page
  // est sauvegardée d'abord.
  const apres = lancer(
    { 'exemple.com': { 'vieille.php': vraie } },
    { 'exemple.com': { rules: [{ from: '/vieille.php', to: '/nouvelle.php', replace: true }] } },
    'apply',
  );
  assert.equal(apres.items[0].state, 'to_replace');
  assert.match(apres.lire('/vieille.php'), /Location: \/nouvelle\.php/);
  assert.equal(apres.sauvegardes.length, 1, 'la page remplacée est sauvegardée');
  assert.ok(apres.sauvegardes[0].startsWith('vieille.php-'));
});

test('redirections : une cible HORS du parc demande une autorisation', { skip: phpAbsent && 'php absent' }, () => {
  // Une redirection ouverte ferait de chaque site un tremplin d'hameçonnage : un lien
  // portant le nom d'un de vos domaines, et le visiteur atterrit ailleurs.
  const dehors = { 'exemple.com': { rules: [{ from: '/vieille.php', to: 'https://inconnu.test/piege' }] } };
  const refus = lancer(PARC, dehors, 'apply');
  assert.equal(refus.items[0].state, 'external');
  assert.equal(refus.lire('/vieille.php'), null, 'rien n’est posé');

  const permis = lancer(PARC, { 'exemple.com': { rules: [{ from: '/vieille.php', to: 'https://inconnu.test/piege', external: true }] } }, 'apply');
  assert.equal(permis.items[0].state, 'to_add');
  assert.match(permis.lire('/vieille.php'), /Location: https:\/\/inconnu\.test\/piege/);
});

test('redirections : un autre domaine DU PARC passe sans autorisation', { skip: phpAbsent && 'php absent' }, () => {
  // Déménager un article d'un de vos sites vers un autre est courant, et ne sort pas
  // du parc : inutile d'exiger une case cochée pour cela.
  const site = lancer(PARC, { 'exemple.com': { rules: [{ from: '/vieille.php', to: 'https://autre.fr/article.php' }] } }, 'apply');
  assert.equal(site.items[0].state, 'to_add');
  assert.equal(site.items[0].external, undefined, 'ce n’est pas considéré comme extérieur');
  assert.match(site.lire('/vieille.php'), /Location: https:\/\/autre\.fr\/article\.php/);
});

test('redirections : « http » vers le parc devient « https »', { skip: phpAbsent && 'php absent' }, () => {
  // Le parc redirige http vers https : viser http ajouterait un saut inutile.
  const site = lancer(PARC, { 'exemple.com': { rules: [{ from: '/vieille.php', to: 'http://autre.fr/article.php' }] } }, 'apply');
  assert.match(site.lire('/vieille.php'), /Location: https:\/\/autre\.fr\/article\.php/);
});

test('redirections : seules les adresses en « .php » sont acceptées', { skip: phpAbsent && 'php absent' }, () => {
  // nginx sert tout autre fichier TEL QUEL : un « /ancienne-page » déposé sans
  // extension s'afficherait en clair, code source compris.
  const site = lancer(PARC, { 'exemple.com': { rules: [{ from: '/ancienne-page', to: '/nouvelle.php' }] } }, 'apply');
  assert.equal(site.items[0].state, 'unsupported');
  assert.equal(site.lire('/ancienne-page'), null);
});

test('redirections : rien ne sort du dossier du site', { skip: phpAbsent && 'php absent' }, () => {
  for (const mauvais of ['/../autre.fr/public_html/pirate.php', '/sous/../../echappe.php', '//autre.fr/x.php']) {
    const site = lancer(PARC, { 'exemple.com': { rules: [{ from: mauvais, to: '/nouvelle.php' }] } }, 'apply');
    assert.ok(['invalid', 'unsupported'].includes(site.items[0].state), `${mauvais} → ${site.items[0].state}`);
  }
});

test('redirections : une adresse refusée n’écrit rien et se dit refusée', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(PARC, { 'exemple.com': { rules: [{ from: '/vieille.php', to: '/vieille.php' }] } }, 'apply');
  assert.equal(site.items[0].state, 'loop');
  assert.equal(site.lire('/vieille.php'), null);
});

test('redirections : poser puis retirer rend le site à son état d’origine', { skip: phpAbsent && 'php absent' }, () => {
  const pose = lancer(PARC, UNE, 'apply').lire('/vieille.php');
  const site = lancer(
    { 'exemple.com': { ...PARC['exemple.com'], 'vieille.php': pose } },
    { 'exemple.com': { rules: [{ from: '/vieille.php', to: '' }] } },
    'apply',
    'remove',
  );
  assert.equal(site.items[0].state, 'to_remove');
  assert.equal(site.lire('/vieille.php'), null, 'le fichier a disparu');
  assert.deepEqual(site.registre, {}, 'et le registre avec');
  assert.equal(site.lire('/index.php'), '<?php echo "accueil";', 'le reste du site est intact');
});

test('redirections : on ne supprime JAMAIS une page qui n’est pas à nous', { skip: phpAbsent && 'php absent' }, () => {
  const vraie = '<?php echo "une vraie page";';
  const site = lancer(
    { 'exemple.com': { 'vieille.php': vraie } },
    { 'exemple.com': { rules: [{ from: '/vieille.php', to: '' }] } },
    'apply',
    'remove',
  );
  assert.equal(site.items[0].state, 'exists');
  assert.equal(site.lire('/vieille.php'), vraie);
});

test('redirections : le registre est reconstruit depuis ce qui EXISTE', { skip: phpAbsent && 'php absent' }, () => {
  // Un registre qui annoncerait une redirection disparue ferait croire une adresse
  // couverte alors qu'elle rend 404.
  const menteur = JSON.stringify({ '/disparue.php': '/ailleurs.php', '/vieille.php': '/nouvelle.php' });
  const pose = lancer(PARC, UNE, 'apply').lire('/vieille.php');
  const site = lancer(
    { 'exemple.com': { ...PARC['exemple.com'], 'vieille.php': pose, '.lkm-redirects.json': menteur } },
    { 'exemple.com': { rules: [{ from: '/seconde.php', to: '/cible.php' }] } },
    'apply',
  );
  assert.deepEqual(Object.keys(site.registre).sort(), ['/seconde.php', '/vieille.php'], 'la disparue est oubliée');
});

test('redirections : les fichiers posés sont lisibles par le compte DU SITE', { skip: phpAbsent && 'php absent' }, () => {
  // PHP tourne sous le compte du site, qui n'appartient qu'à son propre groupe. En
  // 0640, un fichier créé par le compte SSH lui serait inaccessible, et la redirection
  // ne partirait jamais. Mesuré en production le 02/10/2026, avant correction.
  if (process.platform === 'win32') return; // les modes POSIX n'ont pas cours ici
  const site = lancer(PARC, UNE, 'apply');
  assert.equal(site.mode('/vieille.php'), '644');
  assert.equal(site.mode('/.lkm-redirects.json'), '644');
});

test('redirections : un site absent est nommé, pas deviné', { skip: phpAbsent && 'php absent' }, () => {
  const site = lancer(PARC, { 'nexistepas.fr': { rules: [{ from: '/a.php', to: '/b.php' }] } }, 'apply');
  assert.equal(site.error, 'no_site');
});
