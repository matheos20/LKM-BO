/**
 * L'empreinte des articles d'un site, pour y chercher les doublons.
 *
 * ELLE NE S'EXECUTE JAMAIS. Les articles sont lus COMME DU TEXTE, jamais inclus : exécuter
 * un article du parc reviendrait à lancer, sur une machine de production, du code qu'on
 * n'a pas écrit. Le prix à payer est de reconnaître leur forme à la lecture — ce qui est
 * mesuré, pas supposé.
 *
 * CE QU'EST UN ARTICLE SUR CE PARC, relevé le 05/10/2026 sur vps-004 :
 *
 *     <?php
 *     $article_meta = ['title' => '…', 'meta_description' => '…', 'date' => '…', …];
 *     require_once __DIR__ . '/../parts/picture.php';
 *     if (isset($meta_only) && $meta_only) return;
 *     $content .= <<<'HTML'
 *     <p>le corps de l'article…</p>
 *     HTML;
 *
 * Il vit dans `<site>/public_html/<rubrique>/<nom>.php`. Sur 1 200 fichiers de cette
 * profondeur, 1 135 portent `$article_meta` et 1 103 la marque du corps ; les autres sont
 * les fichiers de `parts/`, qui ne sont pas des articles et sont écartés par leur dossier.
 *
 * DEUX EMPREINTES SONT CALCULEES, parce que « identique » et « similaire » ne se mesurent
 * pas pareil :
 *
 *   - `md5` du texte nu : deux articles au même contenu, à la mise en forme près, ont la
 *     même. C'est la détection EXACTE ;
 *   - `simhash` 64 bits sur des groupes de trois mots : deux articles proches ont des
 *     empreintes qui ne diffèrent que de quelques bits. C'est la détection APPROCHEE, et
 *     la distance se compte ensuite côté Node, où elle se teste sans serveur.
 *
 * Le hachage des groupes de mots passe par `crc32`, et non `md5` : il est appelé deux fois
 * par groupe et un article médian en compte plus de mille.
 */

/** Dossiers qui ne contiennent pas d'articles, quoi qu'ils contiennent. */
export const DOSSIERS_EXCLUS = ['parts', 'fonts', 'images', 'wp-content', 'cache'];

/**
 * En dessous, un texte ne dit rien de sa ressemblance.
 *
 * Mesuré : quatre articles de ZERO mot se sont retrouvés groupés comme « identiques »
 * lors du premier essai. Ils ne se ressemblent pas, ils sont vides — et les signaler
 * comme doublons aurait envoyé l'agent corriger un problème qui n'en est pas un. Ils sont
 * comptés à part, sous leur vrai nom.
 */
export const MOTS_MINIMUM = 50;

export const ARTICLE_FINGERPRINTS = String.raw`<?php
error_reporting(0);
$root = rtrim((string) getenv('LKM_ROOT'), '/');
$domaines = json_decode((string) base64_decode((string) getenv('LKM_B64'), true), true) ?: array();
$exclus = json_decode((string) base64_decode((string) getenv('LKM_SKIP'), true), true) ?: array();
$motsMin = (int) (getenv('LKM_MIN_WORDS') ?: 50);

/**
 * Le corps de l'article : ce qui vit entre les marques de document.
 *
 * Rend null quand la marque manque — l'appelant le compte, il ne le devine pas.
 */
function corpsDe($texte) {
    $debut = strpos($texte, "<<<'HTML'");
    if ($debut === false) return null;
    $debut = strpos($texte, "\n", $debut);
    if ($debut === false) return null;
    $fin = strpos($texte, "\nHTML;", $debut);
    if ($fin === false) return null;
    return substr($texte, $debut + 1, $fin - $debut - 1);
}

/**
 * Le texte nu : sans balises, sans casse, sans ponctuation, sans blancs superflus.
 *
 * Deux articles qui ne different que par leur mise en forme doivent avoir le meme texte
 * nu, sans quoi la detection exacte raterait l'essentiel des doublons reels.
 */
function texteNu($html) {
    $t = preg_replace('/<(script|style)\b[^>]*>.*?<\/\1>/isu', ' ', $html);
    $t = preg_replace('/<[^>]*>/u', ' ', $t);
    $t = html_entity_decode($t, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $t = mb_strtolower($t, 'UTF-8');
    $t = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $t);
    return trim(preg_replace('/\s+/u', ' ', $t));
}

/**
 * Une empreinte de PROXIMITE sur 64 bits (simhash).
 *
 * Chaque groupe de trois mots vote, bit par bit : un bit a 1 ajoute une voix, un bit a 0
 * en retire une. Le bit final est le signe du total. Deux textes proches partagent la
 * plupart de leurs groupes, donc la plupart de leurs voix, donc presque tous leurs bits.
 *
 * Rendue en hexadecimal : JSON ne sait pas porter un entier 64 bits sans l'abimer.
 */
function simhash($mots) {
    $n = count($mots);
    if ($n < 3) return null;
    $poids = array_fill(0, 64, 0);
    for ($i = 0; $i + 2 < $n; $i++) {
        $groupe = $mots[$i] . ' ' . $mots[$i + 1] . ' ' . $mots[$i + 2];
        // Deux crc32 donnent les 64 bits, et coutent bien moins qu'un md5 par groupe.
        $bas = crc32($groupe);
        $haut = crc32(strrev($groupe));
        for ($b = 0; $b < 32; $b++) {
            $poids[$b] += ($bas >> $b) & 1 ? 1 : -1;
            $poids[$b + 32] += ($haut >> $b) & 1 ? 1 : -1;
        }
    }
    $hex = '';
    for ($mot = 0; $mot < 4; $mot++) {
        $v = 0;
        for ($b = 0; $b < 16; $b++) {
            if ($poids[$mot * 16 + $b] > 0) $v |= (1 << $b);
        }
        $hex = sprintf('%04x', $v) . $hex;
    }
    return $hex;
}

$sites = array();
foreach ($domaines as $domain) {
    $domain = (string) $domain;
    if (!preg_match('/^[a-z0-9][a-z0-9.-]{1,252}$/i', $domain)) continue;
    $doc = $root . '/' . $domain . '/public_html';
    $site = array(
        'domain' => $domain, 'articles' => array(),
        'total' => 0, 'unreadable' => 0, 'noBody' => 0, 'tooShort' => 0, 'bytes' => 0,
    );
    if (!is_dir($doc)) { $site['error'] = 'missing'; $sites[] = $site; continue; }

    foreach ((glob($doc . '/*', GLOB_ONLYDIR) ?: array()) as $dossier) {
        $slug = basename($dossier);
        if ($slug === '' || $slug[0] === '.' || in_array($slug, $exclus, true)) continue;
        foreach ((glob($dossier . '/*.php') ?: array()) as $f) {
            if (basename($f) === 'index.php') continue;
            $site['total']++;
            $texte = @file_get_contents($f);
            if ($texte === false) { $site['unreadable']++; continue; }
            $site['bytes'] += strlen($texte);

            $titre = '';
            if (preg_match("/'title'\s*=>\s*'((?:[^'\\\\]|\\\\.)*)'/u", $texte, $m)) {
                $titre = str_replace(array("\\'", '\\\\'), array("'", '\\'), $m[1]);
            }

            $corps = corpsDe($texte);
            if ($corps === null) { $site['noBody']++; continue; }
            $nu = texteNu($corps);
            $mots = $nu === '' ? array() : explode(' ', $nu);
            $compte = count($mots);

            // UN ARTICLE TROP COURT N'EST PAS COMPARABLE : il ressemble a tous les autres
            // textes courts, et les grouper inventerait des doublons.
            if ($compte < $motsMin) { $site['tooShort']++; continue; }

            $site['articles'][] = array(
                'path' => substr($f, strlen($doc) + 1),
                'title' => $titre,
                'words' => $compte,
                'bytes' => strlen($texte),
                'mtime' => (int) @filemtime($f),
                'md5' => md5($nu),
                'sim' => simhash($mots),
            );
        }
    }
    $sites[] = $site;
}

echo json_encode(array('sites' => $sites), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
`;
