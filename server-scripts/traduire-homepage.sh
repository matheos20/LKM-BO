#!/usr/bin/env bash
#
# traduire-homepage.sh — Traduit les textes de la page d'accueil restés dans une
# autre langue que celle du site (slogan, bannière, blocs, FAQ, témoignages…).
#
# Complément de traduire-langue.sh, qui traite les GABARITS (parts/, homepage.php).
# Celui-ci traite le CONTENU, qui vit dans config.php : $site_tagline, $header_cta_text
# et le tableau $homepage. C'est là que subsistent les textes non traduits.
#
# 1. Détecte la langue cible : $site_lang de config.php > TLD du domaine > contenu.
# 2. Détecte la langue de CHAQUE texte de la page d'accueil et repère les intrus.
# 3. Traduit :
#      a) par le dictionnaire intégré, pour les expressions courantes ;
#      b) par un service de traduction, si une clé est fournie (--deepl / --api-url) ;
#      c) sinon, signale la phrase, son chemin exact et son domaine.
# 4. Réécrit config.php CHIRURGICALEMENT : seuls les littéraux concernés changent,
#    la mise en forme du fichier reste intacte, et php -l valide avant écriture.
#
# Usage :
#   ./traduire-homepage.sh                          # tous les sites sous /srv/www
#   ./traduire-homepage.sh /srv/www/mondomaine.com  # un seul site
#   ./traduire-homepage.sh -n                       # simulation, n'écrit rien
#   ./traduire-homepage.sh --deepl=CLE -j 8         # traduction réelle, 8 en parallèle
#
# Options :
#   -n, --dry-run        simulation : affiche tout, n'écrit rien
#   -j, --jobs N         sites traités en parallèle (défaut : 4)
#       --lang=XX        force la langue cible (FR UK ES PT DE IT NL)
#       --deepl=CLE      traduit via DeepL (clé gratuite : 500 000 caractères/mois)
#       --api-url=URL    service compatible LibreTranslate (auto-hébergé)
#       --api-key=CLE    clé de ce service, si nécessaire
#       --only=CHAMPS    limite aux chemins voulus (ex. --only=site_tagline,homepage.hero)
#       --min-score=N    prudence du détecteur : 2 = normal, 3 = strict (défaut : 2)
#       --rapport=FIC    écrit un rapport TSV (domaine, chemin, langue, avant, après)
#       --no-backup      n'écrit pas de .bak-traduire (déconseillé)
#   -v, --verbose        affiche aussi les textes déjà dans la bonne langue
#   -h, --help           cette aide
#
#   --restore            remet les config.php d'origine (.bak-traduire)
#   --clean              supprime les sauvegardes .bak-traduire des config.php
#
# Prérequis : bash, php (≥ 7.4), curl et jq pour la traduction en ligne.
#
set -u
umask 022
# Une locale UTF-8 est nécessaire pour compter les caractères accentués à l'affichage.
export LC_ALL=${LC_ALL:-C.UTF-8}

ROOT=""; DRYRUN=0; JOBS=4; FORCE=""; DEEPL=""; APIURL=""; APIKEY=""
ONLY=""; MINSCORE=2; RAPPORT=""; BACKUP=1; VERBOSE=0; RESTORE=0; CLEAN=0

usage() { sed -n '2,/^set -u$/p' "$0" | sed 's/^# \{0,1\}//; /^set -u$/d'; }

for a in "$@"; do
  case "$a" in
    -n|--dry-run)   DRYRUN=1 ;;
    -j)             : ;;                      # valeur lue au tour suivant
    -j[0-9]*)       JOBS=${a#-j} ;;
    --jobs=*)       JOBS=${a#--jobs=} ;;
    --lang=*)       FORCE=$(printf '%s' "${a#--lang=}" | tr '[:lower:]' '[:upper:]') ;;
    --deepl=*)      DEEPL=${a#--deepl=} ;;
    --api-url=*)    APIURL=${a#--api-url=} ;;
    --api-key=*)    APIKEY=${a#--api-key=} ;;
    --only=*)       ONLY=${a#--only=} ;;
    --min-score=*)  MINSCORE=${a#--min-score=} ;;
    --rapport=*)    RAPPORT=${a#--rapport=} ;;
    --no-backup)    BACKUP=0 ;;
    --restore)      RESTORE=1 ;;
    --clean)        CLEAN=1 ;;
    -v|--verbose)   VERBOSE=1 ;;
    -h|--help)      usage; exit 0 ;;
    -*)             echo "Option inconnue : $a" >&2; exit 2 ;;
    *)              if [ "${PREV:-}" = "-j" ]; then JOBS=$a; else ROOT=$a; fi ;;
  esac
  PREV=$a
done
[ -n "$ROOT" ] || ROOT=${PWD}
[ -d "$ROOT" ] || { echo "Dossier introuvable : $ROOT" >&2; exit 2; }
ROOT=$(cd "$ROOT" && pwd)
case "$JOBS" in ''|*[!0-9]*) JOBS=4 ;; esac
[ "$JOBS" -ge 1 ] || JOBS=1

command -v php >/dev/null || { echo "php est requis (lecture fidèle de config.php)." >&2; exit 2; }
if [ -n "$DEEPL" ] || [ -n "$APIURL" ]; then
  command -v curl >/dev/null || { echo "curl est requis pour la traduction en ligne." >&2; exit 2; }
  command -v jq   >/dev/null || { echo "jq est requis pour la traduction en ligne." >&2; exit 2; }
fi

# Couleurs seulement si la sortie est un terminal : les journaux restent lisibles.
if [ -t 1 ]; then
  C_T=$'\033[1m'; C_OK=$'\033[32m'; C_W=$'\033[33m'; C_E=$'\033[31m'; C_D=$'\033[90m'; C_0=$'\033[0m'
else
  C_T=''; C_OK=''; C_W=''; C_E=''; C_D=''; C_0=''
fi

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t trhp)
trap 'rm -rf "$TMP"' EXIT INT TERM

# ═════════════════════════ Outil PHP embarqué ═════════════════════════
# PHP lit et réécrit config.php : lui seul interprète exactement un tableau
# imbriqué et ses littéraux. Le shell orchestre, affiche et décide.

cat > "$TMP/outil.php" <<'PHP_OUTIL'
<?php
// scan  <config.php> <langue|auto> <min-score> [chemins]   → chemin<TAB>langue<TAB>score<TAB>base64(texte)
// apply <config.php>                                        ← base64(avant)<TAB>base64(après) sur l'entrée standard
error_reporting(0);

$STOP = [
 'FR' => "le la les des une un du de et ou pour avec vous nous votre notre nos est sont plus tous toutes qui que sur aux leur leurs chez sans entre vers quand comment pourquoi dans cette ces mais donc alors aussi très toujours jamais chaque plusieurs été être avoir fait faire peut doit ne pas plus rien tout",
 'UK' => "the and for with your our you this that are all more about best from how why what guide tips have has can will their there when which while each every into over also just because we us it is of to in on",
 'ES' => "el la los las una unos unas para con tu tus su sus nuestro nuestra más todos todas que como sobre donde cuando porque pero también siempre nunca cada varios ser estar hacer puede debe desde entre sin no en de",
 'PT' => "os as uma umas para com seu sua nosso nossa mais todos todas que como sobre onde quando porque mas também sempre nunca cada vários ser estar fazer pode deve desde entre sem não você em de",
 'IT' => "il lo la gli le una uno per con tuo tua nostro nostra più tutti tutte che come dove quando perché ma anche sempre mai ogni diversi essere fare può deve da tra senza sono questo questa di in",
 'DE' => "der die das den dem ein eine einen und oder für mit ihre ihr unser unsere mehr alle diese dieser wie wo wann warum aber auch immer nie jeder mehrere sein haben kann muss von zwischen ohne nicht ist",
 'NL' => "de het een en of voor met uw jouw onze meer alle deze hoe waar wanneer waarom maar ook altijd nooit elke verschillende zijn hebben kan moet van tussen zonder niet je is",
];
foreach ($STOP as $k => $v) $STOP[$k] = array_flip(preg_split('/\s+/', trim($v)));

/** Langue dominante d'un texte : [langue, score, score du suivant]. */
function langue(string $s): array {
    global $STOP;
    $nu = strip_tags(html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    $mots = preg_split("/[^\p{L}']+/u", mb_strtolower($nu), -1, PREG_SPLIT_NO_EMPTY);
    if (count($mots) < 3) return [null, 0, 0];
    $sc = [];
    foreach ($STOP as $lg => $set) {
        $n = 0;
        foreach ($mots as $m) if (isset($set[$m])) $n++;
        // Élisions : marqueur propre au français, que les listes de mots ne voient pas.
        if ($lg === 'FR') $n += preg_match_all("/(^|[\s>«\"'])(l'|d'|qu'|n'|s'|j'|m'|c'est)/iu", $nu);
        $sc[$lg] = $n;
    }
    arsort($sc);
    $v = array_values($sc);
    return [array_key_first($sc), $v[0], $v[1] ?? 0];
}

/** Aplatit une valeur de configuration en chemins « homepage.hero.title ». */
function aplatir($v, string $chemin, array &$out): void {
    if (is_string($v)) { if (mb_strlen(trim($v)) > 2) $out[$chemin] = $v; return; }
    if (is_array($v)) foreach ($v as $k => $x) aplatir($x, $chemin === '' ? (string) $k : "$chemin.$k", $out);
}

/** Variables de config.php, lues par PHP lui-même. */
function config(string $file): array {
    return (function ($f) { ob_start(); include $f; ob_end_clean(); return get_defined_vars(); })($file);
}

/** Langue cible : $site_lang, puis extension du domaine, puis contenu du site. */
function cible(array $data, string $file): array {
    $l = strtoupper(trim((string) ($data['site_lang'] ?? '')));
    $l = ['EN' => 'UK', 'GB' => 'UK', 'US' => 'UK', 'BR' => 'PT', 'MX' => 'ES', 'AT' => 'DE', 'BE' => 'NL'][$l] ?? $l;
    global $STOP;
    if (isset($STOP[$l])) return [$l, "config.php (\$site_lang = '$l')"];

    $dom = strtolower(basename(dirname(str_replace('/public_html', '', $file . '/x'))));
    $tld = substr(strrchr($dom, '.') ?: '', 1);
    $parTld = ['fr' => 'FR', 'es' => 'ES', 'pt' => 'PT', 'br' => 'PT', 'de' => 'DE', 'at' => 'DE',
               'it' => 'IT', 'nl' => 'NL', 'be' => 'NL', 'uk' => 'UK', 'ie' => 'UK'];
    if (isset($parTld[$tld])) return [$parTld[$tld], "extension .$tld"];

    $textes = [];
    foreach (['site_tagline', 'homepage'] as $k) if (isset($data[$k])) aplatir($data[$k], $k, $textes);
    $votes = [];
    foreach ($textes as $t) { [$lg, $s1] = langue($t); if ($lg) $votes[$lg] = ($votes[$lg] ?? 0) + $s1; }
    if ($votes) { arsort($votes); return [array_key_first($votes), 'analyse du contenu']; }
    return ['FR', 'aucun indice, FR par défaut'];
}

$mode = $argv[1] ?? '';
$file = $argv[2] ?? '';
if (!is_file($file)) { fwrite(STDERR, "config.php introuvable : $file\n"); exit(3); }

if ($mode === 'scan') {
    $data = config($file);
    [$lang, $comment] = ($argv[3] ?? 'auto') !== 'auto' ? [strtoupper($argv[3]), 'forcée par --lang'] : cible($data, $file);
    $min = max(1, (int) ($argv[4] ?? 2));
    $only = array_filter(explode(',', (string) ($argv[5] ?? '')));

    $textes = [];
    foreach (['site_tagline', 'header_cta_text', 'homepage'] as $k) if (isset($data[$k])) aplatir($data[$k], $k, $textes);

    printf("LANG\t%s\t%s\t%d\n", $lang, $comment, count($textes));
    foreach ($textes as $chemin => $texte) {
        if ($only) {
            $garde = false;
            foreach ($only as $p) if (str_starts_with($chemin, trim($p))) { $garde = true; break; }
            if (!$garde) continue;
        }
        [$lg, $s1, $s2] = langue($texte);
        $etat = 'OK';
        if ($lg && $lg !== $lang && $s1 >= $min && $s1 > $s2) $etat = 'INTRUS';
        elseif (!$lg) $etat = 'COURT';
        printf("%s\t%s\t%s\t%d\t%s\n", $etat, $chemin, $lg ?? '-', $s1, base64_encode($texte));
    }
    exit(0);
}

if ($mode === 'apply') {
    $paires = [];
    foreach (explode("\n", (string) stream_get_contents(STDIN)) as $ligne) {
        if (trim($ligne) === '') continue;
        [$a, $b] = array_pad(explode("\t", $ligne, 2), 2, '');
        $av = base64_decode($a, true); $ap = base64_decode($b, true);
        if ($av === false || $ap === false || $av === '' || $av === $ap) continue;
        $paires[$av] = $ap;
    }
    if (!$paires) { echo "0\n"; exit(0); }

    // Réécriture par le lexer de PHP : seuls les littéraux visés changent, tout le
    // reste du fichier — indentation, commentaires, ordre — est recopié tel quel.
    $src = file_get_contents($file);
    $sortie = ''; $n = 0;
    foreach (token_get_all($src) as $tok) {
        if (!is_array($tok) || $tok[0] !== T_CONSTANT_ENCAPSED_STRING) {
            $sortie .= is_array($tok) ? $tok[1] : $tok;
            continue;
        }
        $lit = $tok[1];
        $q = $lit[0];
        // Une chaîne à guillemets doubles peut interpoler une variable : on n'y touche pas.
        if ($q === '"' && preg_match('/[$\{]/', $lit)) { $sortie .= $lit; continue; }
        $valeur = $q === "'"
            ? strtr(substr($lit, 1, -1), ["\\'" => "'", '\\\\' => '\\'])
            : stripcslashes(substr($lit, 1, -1));
        if (!isset($paires[$valeur])) { $sortie .= $lit; continue; }
        $sortie .= "'" . strtr($paires[$valeur], ["\\" => '\\\\', "'" => "\\'"]) . "'";
        $n++;
    }
    if ($n === 0) { echo "0\n"; exit(0); }

    $tmp = $file . '.lkm-new';
    if (file_put_contents($tmp, $sortie) === false) { fwrite(STDERR, "écriture impossible : $tmp\n"); exit(4); }
    exec('php -l ' . escapeshellarg($tmp) . ' 2>&1', $sortieLint, $code);
    if ($code !== 0) { @unlink($tmp); fwrite(STDERR, "PHP refuse le fichier produit : " . implode(' ', $sortieLint) . "\n"); exit(5); }
    echo "$n\t$tmp\n";
    exit(0);
}

fwrite(STDERR, "mode inconnu : $mode\n");
exit(2);
PHP_OUTIL

# ═════════════════ Dictionnaire des expressions courantes ═════════════════
# FR | UK | ES | PT | DE | IT | NL — évite un appel réseau pour ce qui revient
# partout. Les phrases éditoriales, elles, passent par le service de traduction.

cat > "$TMP/dico.txt" <<'DICO'
Nos articles|Our articles|Nuestros artículos|Os nossos artigos|Unsere Artikel|I nostri articoli|Onze artikelen
Voir les articles|View articles|Ver los artículos|Ver os artigos|Artikel ansehen|Vedi gli articoli|Bekijk artikelen
Voir tous les articles|View all articles|Ver todos los artículos|Ver todos os artigos|Alle Artikel ansehen|Vedi tutti gli articoli|Bekijk alle artikelen
Derniers articles|Latest articles|Últimos artículos|Últimos artigos|Neueste Artikel|Ultimi articoli|Laatste artikelen
Questions fréquentes|Frequently asked questions|Preguntas frecuentes|Perguntas frequentes|Häufige Fragen|Domande frequenti|Veelgestelde vragen
Quelques chiffres|Some numbers|Algunas cifras|Alguns números|Einige Zahlen|Alcuni numeri|Enkele cijfers
Nos rubriques|Our sections|Nuestras secciones|As nossas secções|Unsere Rubriken|Le nostre rubriche|Onze rubrieken
Découvrir|Discover|Descubrir|Descobrir|Entdecken|Scopri|Ontdekken
En savoir plus|Learn more|Más información|Saber mais|Mehr erfahren|Scopri di più|Meer informatie
Lire la suite|Read more|Leer más|Ler mais|Weiterlesen|Continua a leggere|Lees verder
Nous contacter|Contact us|Contáctanos|Contacte-nos|Kontaktieren Sie uns|Contattaci|Neem contact op
S'abonner|Subscribe|Suscribirse|Subscrever|Abonnieren|Iscriviti|Abonneren
Votre adresse email|Your email address|Tu correo electrónico|O seu endereço de email|Ihre E-Mail-Adresse|Il tuo indirizzo email|Uw e-mailadres
Commencer|Get started|Comenzar|Começar|Loslegen|Inizia|Beginnen
DICO

# code de colonne du dictionnaire pour une langue
col_dico() { case "$1" in UK) echo 2;; ES) echo 3;; PT) echo 4;; DE) echo 5;; IT) echo 6;; NL) echo 7;; *) echo 0;; esac; }

# Codes DeepL : la cible accepte une variante régionale (EN-GB, PT-PT), la source non.
code_deepl() { case "$1" in UK) echo 'EN-GB';; PT) echo 'PT-PT';; FR|ES|DE|IT|NL) echo "$1";; *) echo '';; esac; }
code_deepl_src() { case "$1" in UK) echo 'EN';; FR|ES|PT|DE|IT|NL) echo "$1";; *) echo '';; esac; }
code_libre() { case "$1" in UK) echo 'en';; FR) echo 'fr';; ES) echo 'es';; PT) echo 'pt';; DE) echo 'de';; IT) echo 'it';; NL) echo 'nl';; *) echo '';; esac; }

# ═════════════════════════ --restore / --clean ═════════════════════════

if [ $RESTORE -eq 1 ] || [ $CLEAN -eq 1 ]; then
  [ $RESTORE -eq 1 ] && ACTION="restauration" || ACTION="nettoyage"
  printf '%s╔══ traduire-homepage ══════════════════════════%s\n' "$C_T" "$C_0"
  printf '║ Racine : %s\n║ Mode   : %s des sauvegardes de config.php%s\n' "$ROOT" "$ACTION" \
         "$([ $DRYRUN -eq 1 ] && echo ' (simulation)' || echo '')"
  printf '╚═══════════════════════════════════════════════\n\n'
  n=0
  while IFS= read -r b; do
    [ -n "$b" ] || continue
    orig=${b%.bak-traduire}
    n=$((n + 1))
    if [ $RESTORE -eq 1 ]; then
      printf '   ↩ %s\n' "${orig#"$ROOT"/}"
      [ $DRYRUN -eq 1 ] || cat "$b" > "$orig"
    else
      printf '   ✗ %s\n' "${b#"$ROOT"/}"
      [ $DRYRUN -eq 1 ] || rm -f "$b"
    fi
  done < <(find "$ROOT" -type f -name 'config.php.bak-traduire' 2>/dev/null | sort)
  printf '\n   %d fichier(s)%s\n\n' "$n" "$([ $DRYRUN -eq 1 ] && echo '   [simulation]' || echo '')"
  exit 0
fi

# ═════════════════════════ Traduction en ligne ═════════════════════════
# Entrée : fichier de textes (un par ligne, base64) ; sortie : traductions (base64),
# dans le même ordre. Une ligne vide signale un texte non traduit.

traduire_lot() {  # $1 = fichier base64, $2 = langue source, $3 = langue cible
  local fichier=$1 src=$2 dst=$3 i=0
  if [ -n "$DEEPL" ]; then
    local s d args=()
    s=$(code_deepl_src "$src"); d=$(code_deepl "$dst")
    [ -n "$d" ] || { awk '{print ""}' "$fichier"; return; }
    while IFS= read -r b64; do
      args+=(--data-urlencode "text=$(printf '%s' "$b64" | base64 -d)")
    done < "$fichier"
    [ ${#args[@]} -gt 0 ] || return
    local rep
    rep=$(curl -s -m 60 -X POST 'https://api-free.deepl.com/v2/translate' \
          -H "Authorization: DeepL-Auth-Key $DEEPL" \
          -d "target_lang=$d" ${s:+-d "source_lang=$s"} -d 'tag_handling=html' \
          "${args[@]}" 2>/dev/null)
    # Un refus du service (clé invalide, quota) doit se voir, pas se deviner.
    if ! printf '%s' "$rep" | jq -e '.translations' >/dev/null 2>&1; then
      printf '%s\n' "$(printf '%s' "$rep" | jq -r '.message // empty' 2>/dev/null)" >> "${LKM_API_ERR:-/dev/null}"
    fi
    # jq encode lui-même en base64 : le texte traduit ne transite jamais par le shell,
    # qui lui ajouterait un retour à la ligne — celui-ci finirait dans le fichier du site.
    printf '%s' "$rep" | jq -r '.translations[]?.text | @base64' 2>/dev/null
    return
  fi
  if [ -n "$APIURL" ]; then
    local s d
    s=$(code_libre "$src"); d=$(code_libre "$dst")
    [ -n "$d" ] || { awk '{print ""}' "$fichier"; return; }
    while IFS= read -r b64; do
      local texte rep
      texte=$(printf '%s' "$b64" | base64 -d)
      rep=$(curl -s -m 30 -X POST "$APIURL" -H 'Content-Type: application/json' \
            -d "$(jq -n --arg q "$texte" --arg s "${s:-auto}" --arg t "$d" --arg k "$APIKEY" \
                  '{q:$q, source:$s, target:$t, format:"html"} + (if $k == "" then {} else {api_key:$k} end)')" 2>/dev/null)
      printf '%s' "$rep" | jq -r 'if .translatedText then (.translatedText | @base64) else "" end' 2>/dev/null | head -1
    done < "$fichier"
    return
  fi
  awk '{print ""}' "$fichier"            # aucun service configuré
}

# ═════════════════════════ Traitement d'un site ═════════════════════════
# Écrit son rapport dans $TMP/rap/<n> : le shell principal l'affiche dans l'ordre.

traiter() {  # $1 = dossier du site, $2 = numéro d'ordre
  local site=$1 num=$2
  local cfg="$site/config.php" dom rap="$TMP/rap/$num" trav="$TMP/w/$num"
  dom=$(basename "$(dirname "$site")")
  [ "$(basename "$site")" = "public_html" ] || dom=$(basename "$site")
  mkdir -p "$trav"
  : > "$rap"

  if ! php "$TMP/outil.php" scan "$cfg" "${FORCE:-auto}" "$MINSCORE" "$ONLY" > "$trav/scan" 2>"$trav/err"; then
    # Un config.php illisible est fatal et silencieux : php -l, lui, dit pourquoi.
    local motif
    motif=$(head -1 "$trav/err" | tr '\t' ' ')
    [ -n "$motif" ] || motif=$(php -l "$cfg" 2>&1 | head -1 | tr '\t' ' ')
    [ -n "$motif" ] || motif="config.php illisible"
    printf 'DOM\t%s\t-\t-\tERREUR\t%s\n' "$dom" "$motif" >> "$rap"
    return
  fi

  local lang comment total
  lang=$(awk -F'\t' '$1=="LANG"{print $2; exit}' "$trav/scan")
  comment=$(awk -F'\t' '$1=="LANG"{print $3; exit}' "$trav/scan")
  total=$(awk -F'\t' '$1=="LANG"{print $4; exit}' "$trav/scan")
  # Le dictionnaire est consulté pour TOUS les textes, sans attendre le verdict
  # statistique : « Questions fréquentes » ne fait que deux mots, trop peu pour que
  # le détecteur se prononce, alors que sa traduction, elle, ne fait aucun doute.
  awk -F'\t' '$1!="LANG"' "$trav/scan" > "$trav/tous"

  local colonne; colonne=$(col_dico "$lang")
  : > "$trav/paires"; : > "$trav/reste"
  while IFS=$'\t' read -r etat chemin lg score b64; do
    local texte trad=""
    texte=$(printf '%s' "$b64" | base64 -d)
    if [ "$colonne" -ge 2 ]; then
      # Le texte passe par l'environnement : « -v » interpréterait ses échappements.
      trad=$(LKM_SRC="$texte" awk -F'|' -v c="$colonne" '$1 == ENVIRON["LKM_SRC"] { print $c; exit }' "$TMP/dico.txt")
      [ "$trad" = "$texte" ] && trad=""
    fi
    [ -n "$trad" ] || [ "$etat" = "INTRUS" ] || continue
    if [ -n "$trad" ]; then
      printf '%s\t%s\n' "$b64" "$(printf '%s' "$trad" | base64 -w0)" >> "$trav/paires"
      printf 'TRAD\t%s\t%s\tdictionnaire\t%s\t%s\n' "$chemin" "$lg" "$texte" "$trad" >> "$rap"
    else
      printf '%s\t%s\t%s\t%s\n' "$chemin" "$lg" "$score" "$b64" >> "$trav/reste"
    fi
  done < "$trav/tous"

  local nintrus
  nintrus=$(( $(wc -l < "$trav/paires" | tr -d ' ') + $(wc -l < "$trav/reste" | tr -d ' ') ))
  if [ "$nintrus" -eq 0 ]; then
    printf 'DOM\t%s\t%s\t%s\t0\t0\t0\n' "$dom" "$lang" "$comment" >> "$rap"
    [ $VERBOSE -eq 1 ] && printf 'INFO\t%s textes contrôlés, tous dans la bonne langue\n' "$total" >> "$rap"
    return
  fi

  # 2) service de traduction, par langue source
  export LKM_API_ERR="$trav/api-err"
  if [ -s "$trav/reste" ] && { [ -n "$DEEPL" ] || [ -n "$APIURL" ]; }; then
    cut -f2 "$trav/reste" | sort -u | while IFS= read -r src; do
      awk -F'\t' -v s="$src" '$2==s{print $4}' "$trav/reste" > "$trav/lot.$src"
      traduire_lot "$trav/lot.$src" "$src" "$lang" > "$trav/out.$src"
      paste -d'\t' <(awk -F'\t' -v s="$src" '$2==s{print $1"\t"$4}' "$trav/reste") "$trav/out.$src" \
        | while IFS=$'\t' read -r chemin b64 trad64; do
            if [ -n "${trad64:-}" ]; then
              printf '%s\t%s\n' "$b64" "$trad64" >> "$trav/paires"
              printf 'TRAD\t%s\t%s\ttraduction\t%s\t%s\n' "$chemin" "$src" \
                     "$(printf '%s' "$b64" | base64 -d)" "$(printf '%s' "$trad64" | base64 -d)" >> "$rap"
            else
              printf 'MANQUE\t%s\t%s\t%s\n' "$chemin" "$src" "$(printf '%s' "$b64" | base64 -d)" >> "$rap"
            fi
          done
    done
  else
    while IFS=$'\t' read -r chemin lg _ b64; do
      printf 'MANQUE\t%s\t%s\t%s\n' "$chemin" "$lg" "$(printf '%s' "$b64" | base64 -d)" >> "$rap"
    done < "$trav/reste"
  fi

  # 3) écriture
  local ecrits=0
  if [ -s "$trav/paires" ]; then
    if [ $DRYRUN -eq 1 ]; then
      ecrits=$(wc -l < "$trav/paires" | tr -d ' ')
    else
      local res
      if res=$(php "$TMP/outil.php" apply "$cfg" < "$trav/paires" 2>"$trav/err2"); then
        ecrits=$(printf '%s' "$res" | cut -f1)
        local produit; produit=$(printf '%s' "$res" | cut -f2)
        if [ "$ecrits" -gt 0 ] && [ -n "$produit" ]; then
          [ $BACKUP -eq 1 ] && [ ! -f "$cfg.bak-traduire" ] && cp -p "$cfg" "$cfg.bak-traduire"
          cat "$produit" > "$cfg" && rm -f "$produit"
        fi
      else
        printf 'ERR\t%s\n' "$(head -1 "$trav/err2" | tr '\t' ' ')" >> "$rap"
        ecrits=0
      fi
    fi
  fi

  # Un service qui refuse doit se voir dans le rapport du site, pas se deviner.
  if [ -s "$trav/api-err" ]; then
    printf 'SERVICE\t%s\n' "$(grep -v '^$' "$trav/api-err" | sort -u | head -1)" >> "$rap"
  fi

  local nmanque; nmanque=$(grep -c '^MANQUE' "$rap" 2>/dev/null || echo 0)
  printf 'DOM\t%s\t%s\t%s\t%s\t%s\t%s\n' "$dom" "$lang" "$comment" "$nintrus" "$ecrits" "$nmanque" >> "$rap"
}

# ═════════════════════════ Recensement des sites ═════════════════════════

printf '%s╔══ traduire-homepage ══════════════════════════════════════════%s\n' "$C_T" "$C_0"
printf '║ Racine     : %s\n' "$ROOT"
printf '║ Mode       : %s\n' "$([ $DRYRUN -eq 1 ] && echo 'SIMULATION — rien n’est écrit' || echo "ÉCRITURE$([ $BACKUP -eq 1 ] && echo ' + sauvegarde .bak-traduire')")"
printf '║ Traduction : %s\n' "$([ -n "$DEEPL" ] && echo 'DeepL' || { [ -n "$APIURL" ] && echo "service $APIURL" || echo 'dictionnaire seul — les phrases seront signalées'; })"
printf '║ Parallèle  : %s site(s) à la fois\n' "$JOBS"
printf '╚═══════════════════════════════════════════════════════════════\n\n'

find "$ROOT" \( -name images -o -name img -o -name assets -o -name node_modules -o -name .git \
     -o -name vendor -o -name cache -o -name parts \) -prune \
     -o -type f -name config.php -print 2>/dev/null | sed 's|/config\.php$||' | sort > "$TMP/sites"
NSITES=$(wc -l < "$TMP/sites" | tr -d ' ')
[ "$NSITES" -gt 0 ] || { echo "Aucun site trouvé (aucun config.php sous $ROOT)" >&2; exit 1; }

mkdir -p "$TMP/rap" "$TMP/w"

# ═════════════════════════ Exécution ═════════════════════════

num=0
while IFS= read -r site; do
  num=$((num + 1))
  traiter "$site" "$num" &
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n 2>/dev/null || sleep 0.1; done
done < "$TMP/sites"
wait

# ═════════════════════════ Restitution ═════════════════════════

TOT_SITES=0; TOT_INTRUS=0; TOT_ECRITS=0; TOT_MANQUE=0; TOT_ERR=0
[ -n "$RAPPORT" ] && printf 'domaine\tchemin\tlangue\torigine\tavant\taprès\n' > "$RAPPORT"

for i in $(seq 1 "$num"); do
  rap="$TMP/rap/$i"; [ -f "$rap" ] || continue
  dom=$(awk -F'\t' '$1=="DOM"{print $2; exit}' "$rap")
  lang=$(awk -F'\t' '$1=="DOM"{print $3; exit}' "$rap")
  comment=$(awk -F'\t' '$1=="DOM"{print $4; exit}' "$rap")
  nintrus=$(awk -F'\t' '$1=="DOM"{print $5; exit}' "$rap")
  ecrits=$(awk -F'\t' '$1=="DOM"{print $6; exit}' "$rap")
  nmanque=$(awk -F'\t' '$1=="DOM"{print $7; exit}' "$rap")

  if [ "$nintrus" = "ERREUR" ]; then
    printf '%s✗%s %-38s %s\n' "$C_E" "$C_0" "$dom" "$(awk -F'\t' '$1=="DOM"{print $6; exit}' "$rap")"
    TOT_ERR=$((TOT_ERR + 1)); continue
  fi
  TOT_SITES=$((TOT_SITES + 1))
  TOT_INTRUS=$((TOT_INTRUS + nintrus)); TOT_ECRITS=$((TOT_ECRITS + ecrits)); TOT_MANQUE=$((TOT_MANQUE + nmanque))

  if [ "$nintrus" -eq 0 ]; then
    [ $VERBOSE -eq 1 ] && printf '%s·%s %-38s %-3s %s%s%s\n' "$C_D" "$C_0" "$dom" "$lang" "$C_D" "rien à traduire" "$C_0"
    continue
  fi

  printf '%s▸ %-36s%s langue %s%s%s   (%s)\n' "$C_T" "$dom" "$C_0" "$C_T" "$lang" "$C_0" "$comment"
  awk -F'\t' -v ok="$C_OK" -v w="$C_W" -v e="$C_E" -v z="$C_0" '
    $1 == "TRAD"   { printf "   %s✓%s %-30s %s[%s]%s %s\n       → %s\n", ok, z, $2, "", $3, "", substr($5, 1, 78), substr($6, 1, 78) }
    $1 == "MANQUE" { printf "   %s!%s %-30s %s[%s]%s %s\n", w, z, $2, "", $3, "", substr($4, 1, 78) }
    $1 == "SERVICE" { printf "   %s⚠ service de traduction : %s%s\n", w, ($2 == "" ? "aucune réponse exploitable" : $2), z }
    $1 == "ERR"    { printf "   %s✗%s %s\n", e, z, $2 }
  ' "$rap"
  printf '   %s%d traduit(s), %d à traiter à la main%s\n\n' "$C_D" "$ecrits" "$nmanque" "$C_0"

  if [ -n "$RAPPORT" ]; then
    awk -F'\t' -v d="$dom" -v OFS='\t' '
      $1 == "TRAD"   { print d, $2, $3, $4, $5, $6 }
      $1 == "MANQUE" { print d, $2, $3, "non traduit", $4, "" }' "$rap" >> "$RAPPORT"
  fi
done

printf '%s───────────────────────────────────────────────────────────────%s\n' "$C_D" "$C_0"
# Les libellés accentués fausseraient %-28s, qui compte les octets : on aligne
# sur le nombre de caractères, que ${#…} donne en locale UTF-8.
bilan() {  # $1 = libellé, $2 = valeur, $3 = couleur éventuelle
  printf '  %s%s%*s%s%s\n' "${3:-}" "$1" $((30 - ${#1})) '' "$2" "$C_0"
}
bilan "sites examinés" "$TOT_SITES"
bilan "textes dans une autre langue" "$TOT_INTRUS"
bilan "traduits" "$TOT_ECRITS" "$C_OK"
[ "$TOT_MANQUE" -gt 0 ] && bilan "à traduire à la main" "$TOT_MANQUE" "$C_W"
[ "$TOT_ERR" -gt 0 ] && bilan "sites en erreur" "$TOT_ERR" "$C_E"
[ $DRYRUN -eq 1 ] && printf '  %s(simulation : aucun fichier modifié)%s\n' "$C_D" "$C_0"
[ -n "$RAPPORT" ] && printf '  rapport écrit : %s\n' "$RAPPORT"
if [ $DRYRUN -eq 0 ] && [ $BACKUP -eq 1 ] && [ "$TOT_ECRITS" -gt 0 ]; then
  printf '  pour tout annuler : %s "%s" --restore\n' "$0" "$ROOT"
fi
printf '\n'

[ "$TOT_ERR" -gt 0 ] && exit 1
exit 0
