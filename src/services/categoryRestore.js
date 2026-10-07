/**
 * REMETTRE LES RUBRIQUES D'UN SITE DANS L'ÉTAT OÙ ELLES ÉTAIENT.
 *
 * POURQUOI UN POINT DE RESTAURATION PLUTÔT QU'UNE ANNULATION. Un bouton qui défait « le
 * dernier geste » ne sert qu'une fois, et seulement si l'agent n'a pas rechargé sa page.
 * Ce qu'il faut est plus simple à comprendre et plus sûr : une liste de dates, et « remets
 * le site comme il était à ce moment-là ». Le même bouton couvre alors les trois cas —
 * une rubrique AJOUTÉE repart, une rubrique MODIFIÉE retrouve son nom, son icône et sa
 * description, une rubrique SUPPRIMÉE revient avec sa page.
 *
 * CE QUI REND CELA POSSIBLE SANS RIEN SAUVEGARDER DE PLUS : `config.php` est déjà
 * sauvegardé, daté, à CHAQUE écriture, par le circuit de publication (`config-<stamp>.php`
 * dans `.lkm-backups`). Et la page d'une rubrique — son `index.php` — ne contient aucune
 * information propre : c'est trois lignes qui se déduisent du nom de la rubrique. On ne
 * la sauvegarde donc pas, on la REFABRIQUE. Tout l'état des rubriques tient dans
 * `config.php`, et c'est lui qu'on restaure.
 *
 * LES ARTICLES NE SONT JAMAIS EN JEU. Ils vivent dans le dossier de la rubrique, et
 * aucune des deux opérations n'y touche : on pose ou on retire la page d'index, et le
 * dossier ne disparaît que s'il est vide. Un article publié entre-temps fait donc rester
 * le dossier, et c'est dit à l'agent.
 *
 * LA RÈGLE QUI PROTÈGE DU PIRE : on n'efface un `index.php` que s'il est EXACTEMENT celui
 * que le back-office écrit. Une page de rubrique retouchée à la main n'est pas touchée —
 * elle est signalée, et laissée en place. Mieux vaut une rubrique de trop qu'un travail
 * effacé.
 */

/** Ce que le back-office écrit dans la page d'une rubrique, et rien d'autre. */
export const pageRubrique = (slug) => `<?php\n$category = '${slug}';\ninclude __DIR__ . '/../category.php';\n`;

/**
 * CE QUE REVENIR À UN POINT CHANGERAIT, dit AVANT de le faire.
 *
 * Lit les rubriques du point visé et celles d'aujourd'hui, sans rien écrire. Une
 * confirmation qui annonce « 1 rubrique reviendra, 1 partira, 1 retrouvera son nom » se
 * décide ; une qui demande seulement « êtes-vous sûr ? » se clique sans réfléchir.
 *
 * Entrées : LKM_ROOT, LKM_DOMAIN, LKM_POINT (le nom du fichier de sauvegarde).
 */
export const CATEGORY_POINT_DIFF = String.raw`<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$domain = (string) getenv('LKM_DOMAIN');
$point = basename((string) getenv('LKM_POINT'));

$out = array('domain' => $domain, 'point' => $point, 'now' => array(), 'then' => array());

if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain) || !preg_match('/^config-[0-9]{8}-[0-9]{6}\.php$/', $point)) {
    $out['error'] = 'invalid';
    echo json_encode($out);
    exit;
}

$doc = $root . '/' . $domain . '/public_html';
$sauvegarde = $doc . '/.lkm-backups/' . $point;
if (!is_file($sauvegarde)) { $out['error'] = 'no_point'; echo json_encode($out); exit; }

/**
 * Les rubriques d'un config.php, lues par PHP lui-meme et SOUS GARDE.
 *
 * Un config.php casse provoquerait une erreur fatale et emporterait tout le lot sans un
 * mot. On rend null, et l'appelant le dit.
 */
function lireCategories($fichier) {
    try {
        $c = (function ($f) { ob_start(); include $f; ob_end_clean(); return $categories ?? null; })($fichier);
    } catch (\Throwable $e) {
        return null;
    }
    return is_array($c) ? $c : null;
}

$maintenant = lireCategories($doc . '/config.php');
$alors = lireCategories($sauvegarde);
if ($maintenant === null || $alors === null) { $out['error'] = 'unreadable'; echo json_encode($out); exit; }

/** Nom, icone et description, reduits a ce qui se compare. */
function entree($v, $slug) {
    if (!is_array($v)) return array('name' => (string) $v, 'icon' => '', 'description' => '');
    return array(
        'name' => (string) ($v['name'] ?? $slug),
        'icon' => (string) ($v['icon'] ?? ''),
        'description' => (string) ($v['description'] ?? ''),
    );
}
foreach ($maintenant as $slug => $v) $out['now'][(string) $slug] = entree($v, (string) $slug);
foreach ($alors as $slug => $v) $out['then'][(string) $slug] = entree($v, (string) $slug);

// Les articles de chaque rubrique qui s'en irait : l'agent doit savoir ce qui devient
// inatteignable. Comptes ici, ou les fichiers sont.
$out['articles'] = array();
foreach (array_keys($out['now']) as $slug) {
    if (isset($out['then'][$slug])) continue;
    $fichiers = glob($doc . '/' . $slug . '/*.php') ?: array();
    $n = 0;
    foreach ($fichiers as $f) if (basename($f) !== 'index.php') $n++;
    $out['articles'][$slug] = $n;
}

echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;

/**
 * Ce que le retour à un point changerait, calculé en JavaScript pour s'éprouver sans
 * serveur : ce qui revient, ce qui part, ce qui retrouve son nom, et ce qui ne bouge pas.
 */
export function diffPoint({ now = {}, then = {}, articles = {} } = {}) {
  const avant = Object.keys(then);
  const apres = Object.keys(now);
  const revient = avant.filter((s) => !apres.includes(s));
  const part = apres.filter((s) => !avant.includes(s));
  const change = avant
    .filter((s) => apres.includes(s))
    .filter((s) => ['name', 'icon', 'description'].some((k) => (then[s]?.[k] ?? '') !== (now[s]?.[k] ?? '')));
  // L'ordre du menu compte autant que son contenu : c'est lui que voit le visiteur.
  const memeOrdre = avant.length === apres.length && avant.every((s, i) => apres[i] === s);
  return {
    revient,
    part,
    change,
    // Les articles qui deviendraient inatteignables : ceux des rubriques qui s'en vont.
    orphelins: part.reduce((n, s) => n + (articles[s] ?? 0), 0),
    articlesParRubrique: Object.fromEntries(part.map((s) => [s, articles[s] ?? 0])),
    ordreChange: !memeOrdre,
    // Rien ne bougerait : l'écran peut le dire plutôt que de proposer un geste inutile.
    identique: revient.length === 0 && part.length === 0 && change.length === 0 && memeOrdre,
  };
}

/**
 * Remet les pages de rubrique en accord avec le `config.php` qui vient d'être restauré.
 *
 * Entrées : LKM_ROOT, LKM_DOMAIN, LKM_MODE (scan | apply).
 *
 * En mode `scan`, rien n'est écrit : le script dit ce qu'il ferait. C'est ce qui permet
 * à l'écran d'annoncer des nombres avant que l'agent décide.
 */
export const CATEGORY_RECONCILE = String.raw`<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$domain = (string) getenv('LKM_DOMAIN');
$mode = getenv('LKM_MODE') === 'apply' ? 'apply' : 'scan';

$out = array(
    'domain' => $domain, 'mode' => $mode,
    // Les pages reposees pour les rubriques declarees qui n'en avaient plus.
    'restored' => array(),
    // Les pages retirees : leur rubrique n'est plus au menu.
    'removed' => array(),
    // Les dossiers gardes parce qu'il reste des articles dedans.
    'kept' => array(),
    // Les pages retouchees a la main : on n'y touche pas, et on le dit.
    'custom' => array(),
    'failed' => array(),
    'declared' => array(),
    'summary' => false,
);

if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain)) {
    $out['error'] = 'invalid';
    echo json_encode($out);
    exit;
}

$doc = $root . '/' . $domain . '/public_html';
if (!is_file($doc . '/config.php')) { $out['error'] = 'missing'; echo json_encode($out); exit; }

/** Les rubriques que le config.php restaure declare, lues par PHP lui-meme. */
$declarees = (function ($f) {
    try {
        $c = (function ($x) { ob_start(); include $x; ob_end_clean(); return $categories ?? null; })($f);
    } catch (\Throwable $e) {
        return null;
    }
    return is_array($c) ? $c : null;
})($doc . '/config.php');

// Un config.php illisible ne doit RIEN entrainer : sans la liste des rubriques, toute
// reconciliation serait une destruction a l'aveugle.
if ($declarees === null) { $out['error'] = 'unreadable'; echo json_encode($out); exit; }
$out['declared'] = array_keys($declarees);

/** La page que le back-office ecrit pour une rubrique. Deterministe : on la refabrique. */
function pageDe($slug) {
    return "<?php\n" . '$category = ' . var_export($slug, true) . ";\n" . "include __DIR__ . '/../category.php';\n";
}

// ── 1. Chaque rubrique declaree doit avoir sa page. C'est ce qui fait revenir une
//      rubrique supprimee, et avec elle ses articles : ils n'avaient jamais bouge.
foreach (array_keys($declarees) as $slug) {
    $slug = (string) $slug;
    if (!preg_match('/^[a-z0-9][a-z0-9-]{0,60}$/', $slug)) continue;
    $dossier = $doc . '/' . $slug;
    $index = $dossier . '/index.php';
    if (is_file($index)) continue;
    if ($mode !== 'apply') { $out['restored'][] = $slug; continue; }
    if ((is_dir($dossier) || @mkdir($dossier, 0755, true)) && @file_put_contents($index, pageDe($slug)) !== false) {
        @chmod($index, 0644);
        $out['restored'][] = $slug;
    } else {
        $out['failed'][] = $slug;
    }
}

// ── 2. Une page dont la rubrique n'est plus declaree n'a plus rien a servir :
//      category.php y chercherait une rubrique que config.php ne connait pas, et le
//      visiteur verrait une page en erreur. Elle part — mais seulement si c'est bien
//      NOTRE page, et le dossier ne part que s'il est vide.
$exclus = array('parts', 'fonts', 'images', 'cache', 'wp-content');
foreach ((glob($doc . '/*', GLOB_ONLYDIR) ?: array()) as $dossier) {
    $slug = basename($dossier);
    if ($slug === '' || $slug[0] === '.' || in_array($slug, $exclus, true)) continue;
    if (isset($declarees[$slug])) continue;
    $index = $dossier . '/index.php';
    if (!is_file($index)) continue;

    // LA GARDE : on n'efface que la page EXACTE que le back-office ecrit. Une page
    // retouchee a la main reste, et l'agent l'apprend.
    $contenu = @file_get_contents($index);
    if ($contenu === false || trim((string) $contenu) !== trim(pageDe($slug))) {
        $out['custom'][] = $slug;
        continue;
    }
    if ($mode !== 'apply') { $out['removed'][] = $slug; continue; }
    if (!@unlink($index)) { $out['failed'][] = $slug; continue; }
    $out['removed'][] = $slug;
    $restes = array_values(array_diff(@scandir($dossier) ?: array(), array('.', '..')));
    // LES ARTICLES PRIMENT : un dossier qui en contient encore reste en place.
    if ($restes) $out['kept'][] = $slug;
    else @rmdir($dossier);
}

// ── 3. Le resume WordPress se RECALCULE a partir du menu restaure. Le sauvegarder
//      a part aurait ajoute un fichier a tenir a jour ; il ne porte rien que
//      config.php ne porte deja.
$jsonFile = $doc . '/wp_summary.json';
if ($mode === 'apply' && is_file($jsonFile)) {
    $resume = json_decode((string) @file_get_contents($jsonFile), true);
    if (is_array($resume)) {
        $liste = array();
        foreach ($declarees as $slug => $v) {
            $liste[] = array('slug' => (string) $slug, 'name' => (string) (is_array($v) ? ($v['name'] ?? $slug) : $v));
        }
        $resume['wp_categories_list'] = $liste;
        $resume['wp_categories'] = count($liste);
        @copy($jsonFile, $jsonFile . '.bak-' . date('Ymd-His'));
        $out['summary'] = @file_put_contents($jsonFile, json_encode($resume, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) !== false;
    }
}

echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;
