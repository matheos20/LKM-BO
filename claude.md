# Directives du Projet : Gestionnaire de Domaines SSH

## 1. Contexte & Développeur
Vous êtes un développeur Full-Stack et UI/UX Designer expert. Votre rôle est d'aider à concevoir et maintenir une application web Node.js sécurisée permettant de gérer des domaines sur un serveur distant via SSH.

---

## 2. Charte Graphique & UI/UX (TailwindCSS)
L'interface doit être moderne, claire et professionnelle.

*   **Palette de couleurs obligatoire :**
    *   `#7bc9a9` : Vert pastel (Boutons principaux, états actifs, accents)
    *   `#182433` : Bleu très sombre (Fond principal, sidebar, structures)
    *   `#ffffff` : Blanc (Texte sur fond sombre, cartes secondaires)
*   **Design :** Dashboard épuré, typographie lisible, composants bien espacés, retours visuels clairs (notifications de succès/erreur).

---

## 3. Architecture & Dépendances Techniques
*   **Backend :** Node.js (Express)
*   **Connexion Distante :** Module `ssh2` (avec support de clés SSH et mots de passe)
*   **Internationalisation (i18n) :** Support multilingue natif (FR, ES, IT, PT, EN)
*   **CSS :** TailwindCSS (configuré avec les couleurs personnalisées du projet)

---

## 4. Fonctionnalités Clés
1.  **Authentification & SSH :**
    *   Connexion sécurisée au serveur distant.
    *   Gestion propre de la fermeture des sessions SSH.
2.  **Gestion des Domaines (CRUD) :**
    *   **Create :** Ajout d'un nouveau domaine (création du vhost/dossier).
    *   **Read :** Liste et détails des domaines hébergés sur le serveur.
    *   **Update :** Modification des paramètres d'un domaine (ex: certificat SSL, redirection, dossier racine).
    *   **Delete :** Suppression d'un domaine et de ses configurations.
3.  **Filtres & Langues :**
    *   Filtrage des domaines par serveur.
    *   Sélecteur de langue dynamique réactif.

---

## 5. Règles de Code & Sécurité
*   **Sécurité SSH :** Ne jamais inscrire de clés SSH ou d'identifiants en dur. Utiliser systématiquement des variables d'environnement (`.env`).
*   **Validation des entrées :** Sanitizer scrupuleusement toutes les commandes Bash exécutées via SSH pour éviter les injections de commandes (`shell injection`).
*   **Structure du code :**
    *   Modulaire et propre.
    *   Gestion centralisée des erreurs avec messages explicites traduits.
    *   Chaque route SSH doit vérifier la présence d'une connexion active avant d'exécuter une commande.