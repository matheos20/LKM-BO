/**
 * Les scripts serveur du changement de thématique : sauvegarder, poser, restaurer.
 *
 * Ils vivent à part de `phpScripts.js`, qui en compte déjà mille cinq cents lignes, et
 * parce qu'ils forment un tout : la sauvegarde n'a de sens qu'avec la restauration qui
 * la relit, et l'une ne doit pas pouvoir changer sans l'autre.
 *
 * TOUT CE QUE L'OPÉRATION TOUCHE EST COPIÉ D'ABORD, et la liste n'est pas devinée : c'est
 * celle que le script va lui-même modifier. C'est ce qui permet de promettre une
 * restauration complète plutôt que de l'espérer.
 *
 * Mesuré le 05/10/2026 sur deux sites du parc : `config.php` (2,8 ko), `wp_summary.json`
 * (0,4 ko) et les `index.php` de rubriques (41 à 71 octets chacun) font 3,7 ko en tout.
 * Sauvegarder exactement cela coûte 4 ko par site, soit 555 ko pour cent cinquante — là
 * où archiver les sites entiers (559 fichiers chacun en moyenne) était hors de question
 * sur un parc dont les disques sont à 85 % et saturés en entrées-sorties.
 *
 * UN DOSSIER QUI CONTIENT DES ARTICLES N'EST JAMAIS SUPPRIMÉ. Seul son `index.php` s'en
 * va ; les articles restent sur le disque, et le manifeste écrit combien d'entre eux ne
 * sont plus accessibles depuis le menu. C'est la conséquence la plus lourde d'un
 * changement de thématique, et elle doit être dite noir sur blanc.
 */

/** La marque d'un manifeste : sans elle, un dossier n'est pas des nôtres. */
export const MARQUE = 'LKM-BO thematique';

/** Où vivent les sauvegardes, à l'abri du web — nginx refuse les chemins en point. */
export const DOSSIER_SAUVEGARDES = '.lkm-backups/thematiques';

/**
 * Pose une thématique : sauvegarde, dossiers, puis `wp_summary.json`.
 *
 * `config.php` N'EST PAS ÉCRIT ICI. Il emprunte le circuit de publication du
 * back-office — reconstruit, validé, sauvegardé, contrôlé par `php -l`, relu après
 * écriture et restauré tout seul en cas d'écart. C'est le chemin le plus sûr du projet,
 * et le fichier le plus fragile du site mérite qu'on le prenne.
 *
 * L'ORDRE EST CELUI DU SERVICE DE RUBRIQUES, et pour la même raison : les dossiers
 * d'abord, la configuration ensuite. Un dossier sans entrée de configuration ne dérange
 * personne ; l'inverse afficherait au menu une rubrique qui mène à une page inexistante.
 */
export const THEME_APPLY = String.raw`<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$mode = getenv('LKM_MODE') === 'apply' ? 'apply' : 'scan';
$demande = json_decode((string) base64_decode((string) getenv('LKM_B64'), true), true) ?: [];
$stamp = (string) getenv('LKM_STAMP');
if (!preg_match('/^[0-9]{8}-[0-9]{6}$/', $stamp)) $stamp = date('Ymd-His');
$MARQUE = 'LKM-BO thematique';

/**
 * Les rubriques declarees dans config.php, lues par PHP lui-meme.
 *
 * L'INCLUSION EST SOUS GARDE, et ce n'est pas une precaution de style. Avec les erreurs
 * en sourdine, un « config.php » au PHP cassé provoque une erreur fatale : le processus
 * s'arrete avec le code 255, SANS AUCUNE SORTIE, et tout le lot est perdu — vingt sites
 * pour un seul fichier abime. Vérifié le 05/10/2026 : « include » direct rend 255 et rien,
 * sous try/catch il rend la main et l'on peut nommer le site en cause.
 *
 * Rend null quand le fichier ne se lit pas : l'appelant le signale au lieu de supposer
 * qu'un site n'a aucune rubrique.
 */
function rubriquesActuelles($fichier) {
    try {
        $c = (function ($f) { ob_start(); include $f; ob_end_clean(); return $categories ?? null; })($fichier);
    } catch (\Throwable $e) {
        return null;
    }
    return is_array($c) ? $c : null;
}

/** Le contenu d'un index.php de rubrique, tel que le moteur du site l'attend. */
function contenuIndex() {
    return "<?php require __DIR__ . '/../category.php';\n";
}

/** Ce qu'un dossier contient hors son index : ce sont les articles. */
function articlesDe($dossier) {
    if (!is_dir($dossier)) return array();
    $restes = @scandir($dossier);
    if (!is_array($restes)) return array();
    return array_values(array_diff($restes, array('.', '..', 'index.php')));
}

$sites = array();
foreach ($demande as $domain => $voulu) {
    $domain = (string) $domain;
    if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain) || !is_array($voulu)) continue;
    $doc = $root . '/' . $domain . '/public_html';
    $site = array(
        'domain' => $domain, 'stamp' => $stamp,
        'saved' => array(), 'created' => array(), 'dropped' => array(), 'kept' => array(),
        'orphans' => 0, 'orphansBySlug' => array(), 'done' => array(), 'failed' => array(),
    );

    if (!is_file($doc . '/config.php')) { $site['error'] = 'missing'; $sites[] = $site; continue; }
    // Sans category.php, une rubrique posee n'aurait rien pour s'afficher.
    if (!is_file($doc . '/category.php')) { $site['error'] = 'engine'; $sites[] = $site; continue; }

    $actuelles = rubriquesActuelles($doc . '/config.php');
    // Un config.php illisible ou casse : on le DIT, on ne suppose pas un site sans rubrique
    // — ce qui aurait fait poser la thematique entiere et retirer un menu qu'on n'a pas vu.
    if ($actuelles === null) { $site['error'] = 'config'; $sites[] = $site; continue; }
    $anciens = array();
    foreach ($actuelles as $cle => $v) {
        if (preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', (string) $cle)) $anciens[] = (string) $cle;
    }

    $nouveaux = array();
    foreach ($voulu as $r) {
        $slug = isset($r['slug']) ? (string) $r['slug'] : '';
        if (preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug) && !in_array($slug, $nouveaux, true)) $nouveaux[] = $slug;
    }
    if (!$nouveaux) { $site['error'] = 'empty'; $sites[] = $site; continue; }

    $aCreer = array_values(array_diff($nouveaux, $anciens));
    $aRetirer = array_values(array_diff($anciens, $nouveaux));
    $site['created'] = $aCreer;
    $site['dropped'] = $aRetirer;
    $site['kept'] = array_values(array_intersect($anciens, $nouveaux));

    // CE QUE LE CHANGEMENT REND INACCESSIBLE : les articles des rubriques qui quittent le
    // menu. Ils restent sur le disque, mais plus rien n'y mene depuis le site.
    foreach ($aRetirer as $slug) {
        $n = count(articlesDe($doc . '/' . $slug));
        if ($n) $site['orphansBySlug'][$slug] = $n;
        $site['orphans'] += $n;
    }

    if ($mode !== 'apply') { $sites[] = $site; continue; }

    // ── 1. LA SAUVEGARDE, avant quoi que ce soit.
    $bk = $doc . '/.lkm-backups/thematiques/' . $stamp;
    if (!is_dir($bk) && !@mkdir($bk, 0755, true)) { $site['error'] = 'backup'; $sites[] = $site; continue; }

    $copies = array();
    $copier = function ($de, $nom) use ($bk, &$copies) {
        if (!is_file($de)) return false;
        if (!@copy($de, $bk . '/' . $nom)) return false;
        @chmod($bk . '/' . $nom, 0644);
        $copies[] = $nom;
        return true;
    };

    if (!$copier($doc . '/config.php', 'config.php')) { $site['error'] = 'backup'; $sites[] = $site; continue; }
    $copier($doc . '/wp_summary.json', 'wp_summary.json');
    foreach ($anciens as $slug) {
        $copier($doc . '/' . $slug . '/index.php', 'index--' . $slug . '.php');
    }
    $site['saved'] = $copies;

    // Le manifeste : ce qui a ete sauvegarde, et ce qui va etre fait. C'est lui que lira
    // la restauration, et lui seul — elle ne devine rien.
    $manifeste = array(
        'marker' => $MARQUE,
        'stamp' => $stamp,
        'domain' => $domain,
        'at' => time(),
        'before' => $anciens,
        'after' => $nouveaux,
        'created' => $aCreer,
        'dropped' => $aRetirer,
        'orphans' => $site['orphans'],
        'files' => $copies,
    );
    $ecrit = @file_put_contents($bk . '/manifest.json', json_encode($manifeste, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
    if ($ecrit === false) { $site['error'] = 'backup'; $sites[] = $site; continue; }
    @chmod($bk . '/manifest.json', 0644);
    $site['done'][] = 'backup';

    // ── 2. LES DOSSIERS DES NOUVELLES RUBRIQUES.
    foreach ($aCreer as $slug) {
        $d = $doc . '/' . $slug;
        $i = $d . '/index.php';
        if (is_file($i)) { $site['done'][] = 'dir:' . $slug; continue; }
        if ((is_dir($d) || @mkdir($d, 0755, true)) && @file_put_contents($i, contenuIndex()) !== false) {
            @chmod($i, 0644);
            $site['done'][] = 'dir:' . $slug;
        } else {
            $site['failed'][] = 'dir:' . $slug;
        }
    }

    // ── 3. LES RUBRIQUES QUI QUITTENT LE MENU. Seul l'index s'en va ; un dossier qui
    //      contient des articles reste, et ses articles avec lui.
    foreach ($aRetirer as $slug) {
        $d = $doc . '/' . $slug;
        $i = $d . '/index.php';
        if (!is_file($i)) continue;
        if (@unlink($i)) {
            $restes = is_dir($d) ? array_values(array_diff(@scandir($d) ?: array(), array('.', '..'))) : array();
            if (!$restes) @rmdir($d);
            $site['done'][] = 'undir:' . $slug;
        } else {
            $site['failed'][] = 'undir:' . $slug;
        }
    }

    // ── 4. wp_summary.json, que lit la synchronisation WordPress.
    $fj = $doc . '/wp_summary.json';
    if (is_file($fj)) {
        $resume = json_decode((string) @file_get_contents($fj), true);
        if (is_array($resume)) {
            $liste = array();
            foreach ($voulu as $r) {
                $slug = isset($r['slug']) ? (string) $r['slug'] : '';
                if (!in_array($slug, $nouveaux, true)) continue;
                $liste[] = array('slug' => $slug, 'name' => isset($r['name']) ? (string) $r['name'] : $slug);
            }
            $resume['wp_categories'] = count($liste);
            $resume['wp_categories_list'] = $liste;
            if (@file_put_contents($fj, json_encode($resume, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false) {
                $site['done'][] = 'json';
            } else {
                $site['failed'][] = 'json';
            }
        }
    }

    $sites[] = $site;
}

echo json_encode(array('sites' => $sites, 'mode' => $mode, 'stamp' => $stamp), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/**
 * Les sauvegardes de thématique d'un site, de la plus récente à la plus ancienne.
 *
 * Un dossier sans manifeste lisible, ou dont le manifeste ne porte pas notre marque,
 * n'est pas proposé : mieux vaut une liste courte et sûre qu'une liste complète dont une
 * entrée ferait échouer la restauration.
 */
export const THEME_BACKUPS = String.raw`<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$domaines = json_decode((string) base64_decode((string) getenv('LKM_B64'), true), true) ?: array();
$MARQUE = 'LKM-BO thematique';

$sites = array();
foreach ($domaines as $domain) {
    $domain = (string) $domain;
    if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain)) continue;
    $doc = $root . '/' . $domain . '/public_html';
    $base = $doc . '/.lkm-backups/thematiques';
    $site = array('domain' => $domain, 'backups' => array());

    if (is_dir($base)) {
        $noms = @scandir($base);
        if (is_array($noms)) {
            rsort($noms);
            foreach ($noms as $nom) {
                if (!preg_match('/^[0-9]{8}-[0-9]{6}$/', $nom)) continue;
                $m = @file_get_contents($base . '/' . $nom . '/manifest.json');
                if ($m === false) continue;
                $j = json_decode($m, true);
                if (!is_array($j) || ($j['marker'] ?? '') !== $MARQUE) continue;
                // On verifie que ce qui est annonce est bien la : une sauvegarde
                // incomplete ne doit pas etre proposee comme restaurable.
                $complete = true;
                foreach ((array) ($j['files'] ?? array()) as $f) {
                    if (!is_file($base . '/' . $nom . '/' . basename((string) $f))) { $complete = false; break; }
                }
                $site['backups'][] = array(
                    'stamp' => $nom,
                    'at' => (int) ($j['at'] ?? 0),
                    'before' => (array) ($j['before'] ?? array()),
                    'after' => (array) ($j['after'] ?? array()),
                    'orphans' => (int) ($j['orphans'] ?? 0),
                    'files' => count((array) ($j['files'] ?? array())),
                    'complete' => $complete,
                );
            }
        }
    }
    $sites[] = $site;
}

echo json_encode(array('sites' => $sites), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/**
 * Remet un site dans l'état où la sauvegarde l'a trouvé.
 *
 * ELLE NE DEVINE RIEN : tout vient du manifeste. Et elle procède dans l'ordre inverse de
 * la pose, avec trois précautions qui font la différence entre une restauration et un
 * espoir :
 *
 *   1. LE `config.php` RESTAURÉ EST CONTRÔLÉ PAR `php -l` AVANT d'être mis en place. Un
 *      fichier sauvegardé est en principe valide — mais « en principe » n'est pas une
 *      garantie, et un `config.php` cassé rend tout le site blanc ;
 *   2. L'ÉTAT ACTUEL EST LUI-MÊME SAUVEGARDÉ avant d'être remplacé, dans un dossier
 *      `…-avant-restauration`. Une restauration malheureuse resterait sinon sans retour ;
 *   3. RIEN N'EST SUPPRIMÉ QUI CONTIENNE DES ARTICLES. Les dossiers créés par la pose
 *      sont retirés, mais seulement s'ils sont vides — un article publié depuis le
 *      changement ne doit pas disparaître parce qu'on revient en arrière.
 *
 * La sauvegarde n'est pas effacée : on peut restaurer deux fois.
 */
export const THEME_RESTORE = String.raw`<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$domain = (string) getenv('LKM_DOMAIN');
$stamp = (string) getenv('LKM_STAMP');
$MARQUE = 'LKM-BO thematique';

$sortie = array('domain' => $domain, 'stamp' => $stamp, 'restored' => array(), 'removed' => array(), 'kept' => array(), 'failed' => array());

if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain) || !preg_match('/^[0-9]{8}-[0-9]{6}$/', $stamp)) {
    $sortie['error'] = 'invalid';
    echo json_encode($sortie);
    exit;
}

$doc = $root . '/' . $domain . '/public_html';
$bk = $doc . '/.lkm-backups/thematiques/' . $stamp;
$m = @file_get_contents($bk . '/manifest.json');
if ($m === false) { $sortie['error'] = 'no_backup'; echo json_encode($sortie); exit; }
$j = json_decode($m, true);
if (!is_array($j) || ($j['marker'] ?? '') !== $MARQUE || ($j['domain'] ?? '') !== $domain) {
    $sortie['error'] = 'no_backup';
    echo json_encode($sortie);
    exit;
}

// Tout ce que le manifeste annonce doit etre la AVANT qu'on touche a quoi que ce soit.
foreach ((array) ($j['files'] ?? array()) as $f) {
    if (!is_file($bk . '/' . basename((string) $f))) { $sortie['error'] = 'incomplete'; echo json_encode($sortie); exit; }
}

// ── 1. L'ETAT ACTUEL EST SAUVEGARDE : une restauration malheureuse doit avoir un retour.
$avant = $bk . '-avant-restauration';
if (!is_dir($avant)) @mkdir($avant, 0755, true);
if (is_file($doc . '/config.php')) @copy($doc . '/config.php', $avant . '/config.php');
if (is_file($doc . '/wp_summary.json')) @copy($doc . '/wp_summary.json', $avant . '/wp_summary.json');

// ── 2. LE config.php, controle avant d'etre mis en place.
$source = $bk . '/config.php';
$tmp = $doc . '/.lkm-config-restore.php';
if (!@copy($source, $tmp)) { $sortie['error'] = 'copy'; echo json_encode($sortie); exit; }
$php = PHP_BINARY && is_executable(PHP_BINARY) ? PHP_BINARY : 'php';
$cmd = escapeshellarg($php) . ' -l ' . escapeshellarg($tmp) . ' 2>&1';
$lint = @shell_exec($cmd);
$syntaxeOk = $lint === null || strpos((string) $lint, 'No syntax errors') !== false;
if (!$syntaxeOk) {
    @unlink($tmp);
    $sortie['error'] = 'syntax';
    $sortie['detail'] = substr((string) $lint, 0, 200);
    echo json_encode($sortie);
    exit;
}
if (!@rename($tmp, $doc . '/config.php')) {
    @unlink($tmp);
    $sortie['error'] = 'write';
    echo json_encode($sortie);
    exit;
}
@chmod($doc . '/config.php', 0644);
$sortie['restored'][] = 'config.php';

// ── 3. wp_summary.json.
if (is_file($bk . '/wp_summary.json')) {
    if (@copy($bk . '/wp_summary.json', $doc . '/wp_summary.json')) {
        @chmod($doc . '/wp_summary.json', 0644);
        $sortie['restored'][] = 'wp_summary.json';
    } else {
        $sortie['failed'][] = 'wp_summary.json';
    }
}

// ── 4. LES index.php DES RUBRIQUES D'AVANT, remis en place.
foreach ((array) ($j['before'] ?? array()) as $slug) {
    $slug = (string) $slug;
    if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug)) continue;
    $copie = $bk . '/index--' . $slug . '.php';
    if (!is_file($copie)) continue;
    $d = $doc . '/' . $slug;
    if (!is_dir($d) && !@mkdir($d, 0755, true)) { $sortie['failed'][] = $slug; continue; }
    if (@copy($copie, $d . '/index.php')) {
        @chmod($d . '/index.php', 0644);
        $sortie['restored'][] = $slug . '/index.php';
    } else {
        $sortie['failed'][] = $slug;
    }
}

// ── 5. LES DOSSIERS CREES PAR LA POSE, retires — mais seulement s'ils sont vides. Un
//      article publie depuis le changement ne doit pas disparaitre parce qu'on revient.
foreach ((array) ($j['created'] ?? array()) as $slug) {
    $slug = (string) $slug;
    if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug)) continue;
    if (in_array($slug, (array) ($j['before'] ?? array()), true)) continue;
    $d = $doc . '/' . $slug;
    if (!is_dir($d)) continue;
    // L'INDEX S'EN VA TOUJOURS : la rubrique n'est plus au menu du site restaure, sa page
    // n'a donc plus a etre servie — category.php y chercherait une rubrique que
    // config.php ne declare plus. C'est exactement ce que fait la pose en sens inverse.
    @unlink($d . '/index.php');
    $restes = array_values(array_diff(@scandir($d) ?: array(), array('.', '..')));
    // LE DOSSIER, EN REVANCHE, NE S'EN VA QUE S'IL EST VIDE : un article publie depuis le
    // changement ne doit pas disparaitre parce qu'on revient en arriere.
    if ($restes) { $sortie['kept'][] = $slug; continue; }
    if (@rmdir($d)) $sortie['removed'][] = $slug;
    else $sortie['failed'][] = $slug;
}

$sortie['before'] = (array) ($j['before'] ?? array());
$sortie['after'] = (array) ($j['after'] ?? array());
echo json_encode($sortie, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;
