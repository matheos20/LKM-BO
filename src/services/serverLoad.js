import { AppError } from '../errors.js';

/**
 * Le frein commun à toutes les analyses de masse.
 *
 * IL A ÉTÉ PAYÉ CHER, et il est partagé pour qu'il ne soit pas réinventé à moitié.
 *
 * Le 02/10/2026, une analyse de 300 sites à dix sondes en parallèle a fait passer la
 * charge moyenne de vps-001 de 6 à 138 sur 8 cœurs : 1 276 connexions, 653 processus
 * php-fpm, et de vrais visiteurs servis en 8,8 s au lieu de 2. La machine est revenue
 * d'elle-même en quatre minutes, sans dégât — mais la leçon est acquise.
 *
 * DEUX BARRIÈRES, PARCE QU'UNE SEULE NE VOIT PAS TOUT :
 *
 *  1. LA CHARGE, ramenée au nombre de cœurs. Une charge de 8 est confortable sur 16 cœurs
 *     et critique sur 2 ; c'est le rapport qui compte. Et le plafond ne peut pas être un
 *     nombre fixe : mesuré, vps-002 vit à 1,78 par cœur au repos et vps-001 à 0,57. Un
 *     plafond fixe serait franchi avant la première sonde sur l'une et jamais atteint sur
 *     l'autre. Le frein se cale donc sur ce que la machine fait D'HABITUDE.
 *
 *  2. LA PRESSION DISQUE (`/proc/pressure/io`), et c'est elle qui compte le plus sur ce
 *     parc. Le 05/10/2026, vps-003 affichait 182 de charge avec 234 processus bloqués en
 *     attente de disque et UN SEUL en calcul : la pression CPU était à 15 %, la pression
 *     I/O à 99,8 %. Ces machines ne manquent pas de processeur, elles manquent de disque —
 *     7 Go de cache pour 5 000 sites, donc chaque page repart le lire.
 *
 *     Mesuré le même jour sur les cinq machines : 0,02 % · 1,33 % · 4,03 % · 0,28 % pour
 *     les quatre saines, 99,60 % pour celle qui souffrait. La séparation est franche, et
 *     c'est pourquoi le seuil peut être généreux sans rien laisser passer.
 *
 * Renoncer n'est pas un échec de l'analyse : c'est un résultat. L'écran dit « le serveur
 * était trop chargé », l'agent recommence plus tard, et aucun site n'a été déclaré en
 * panne à tort.
 */

/** Charge par cœur admise tant qu'on ne connaît pas encore le train de vie d'une machine. */
export const CHARGE_MAX = 2;

/** Ce qu'une analyse s'autorise au-dessus de l'état habituel de la machine. */
export const MARGE_CHARGE = 0.75;

/**
 * Plafond de charge absolu, par cœur.
 *
 * Il protège du cas où la première lecture tombe pendant une crise : vps-003 à 32 par cœur
 * deviendrait sa « référence », et l'analyse s'autoriserait 33. Au-delà de ce plafond, on
 * n'ajoute rien, quelle que soit l'habitude de la machine.
 */
export const CHARGE_PLAFOND = 4;

/**
 * Part du temps (sur 10 s) où au moins une tâche attend le disque, au-delà de laquelle on
 * n'ajoute rien. Mesuré : 0 à 4 % sur une machine saine, 99,6 % sur une machine à genoux.
 */
export const PRESSION_MAX = 50;

/** Combien de temps une analyse accepte d'attendre que la machine se calme. */
export const ATTENTE_MAX = 120000;

/** Entre deux relectures de la charge. */
const RESPIRATION = 5000;

export class ServerLoad {
  constructor(ssh) {
    this.ssh = ssh;
    // Ce que chaque machine fait quand on ne lui demande rien. Rempli à la première
    // lecture, et perdu au redémarrage — ce qui n'est pas grave : il sera remesuré.
    this.repos = new Map();
  }

  /**
   * L'état de la machine, en une commande.
   *
   * `io` est le pourcentage de temps, sur les dix dernières secondes, où au moins une
   * tâche attendait le disque. Une machine sans `/proc/pressure` rend 0 : on ne refuse pas
   * de travailler faute de thermomètre, la charge reste là pour trancher.
   */
  async lire(serverId) {
    const { stdout } = await this.ssh.exec(
      serverId,
      "awk '{print $1}' /proc/loadavg; nproc; awk '/^some/{sub(/avg10=/, \"\", $2); print $2; exit}' /proc/pressure/io 2>/dev/null || echo 0",
      { timeout: 30000 },
    );
    const [load, cores, io] = String(stdout).trim().split(/\s+/);
    const coeurs = Number(cores) || 1;
    const valeur = Number(load) || 0;
    return { load: valeur, cores: coeurs, parCoeur: valeur / coeurs, io: Number(io) || 0 };
  }

  /** Le plafond propre à une machine : son train de vie habituel, plus la marge. */
  plafond(serverId) {
    const repos = this.repos.get(serverId);
    return repos === undefined ? CHARGE_MAX : Math.min(CHARGE_PLAFOND, repos + MARGE_CHARGE);
  }

  /**
   * Attend que la machine redescende, et renonce plutôt que d'insister.
   *
   * Les deux barrières portent des messages DIFFÉRENTS, parce que le remède diffère : une
   * machine à court de processeur et une machine à court de disque ne se soignent pas de
   * la même façon, et l'agent qui transmet le message à son administrateur doit pouvoir
   * dire laquelle.
   */
  async attendre(serverId, { plafond = null, pression = PRESSION_MAX, attenteMax = ATTENTE_MAX } = {}) {
    const debut = Date.now();
    let vue = await this.lire(serverId);
    // La toute première lecture sur un serveur fait référence : c'est son état avant que
    // nos sondes n'y aient rien ajouté.
    let limite = plafond ?? this.plafond(serverId);
    if (!this.repos.has(serverId)) {
      this.repos.set(serverId, vue.parCoeur);
      if (plafond === null) limite = Math.min(CHARGE_PLAFOND, vue.parCoeur + MARGE_CHARGE);
    }

    while (vue.parCoeur > limite || vue.io > pression) {
      if (Date.now() - debut >= attenteMax) {
        const nom = this.ssh.server(serverId).label ?? serverId;
        if (vue.io > pression) {
          throw new AppError('errors.health_server_io', {
            status: 503,
            vars: { server: nom, io: String(Math.round(vue.io)) },
          });
        }
        throw new AppError('errors.health_server_busy', {
          status: 503,
          vars: { server: nom, load: vue.load.toFixed(2), cores: String(vue.cores) },
        });
      }
      await new Promise((r) => setTimeout(r, RESPIRATION));
      vue = await this.lire(serverId);
    }
    return vue;
  }
}
