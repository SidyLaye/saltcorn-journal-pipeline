/**
 * journal-pipeline — suivi d'exécution du workflow de traitement des leads.
 *
 * Le problème qu'il résout
 * ───────────────────────
 * Les 21 nœuds du workflow appellent depuis le premier jour :
 *
 *     emitEvent("journal_pipeline", "<nom du nœud>", { ... })
 *
 * Mais un événement personnalisé n'apparaît dans la liste « When » d'un
 * déclencheur que s'il est déclaré par un module. Dans `models/trigger.js` :
 *
 *     static get when_options() {
 *       return [ "Never", "Insert", ...,
 *                ...Object.keys(getState().eventTypes) ];   // ← ici
 *     }
 *
 * Aucun module ne déclarait `journal_pipeline`. Aucun déclencheur ne pouvait
 * donc l'écouter : chaque émission partait dans le vide, et le pipeline
 * n'avait aucune trace de son propre passage.
 *
 * Pourquoi un module séparé
 * ─────────────────────────
 * La déclaration aurait pu tenir dans `imap-idle` ou `smtp-envoi`. Un module
 * à part évite de redéployer une pièce du chemin des e-mails pour une
 * fonction d'observation. Le journal ne doit jamais être la raison pour
 * laquelle la relève ou l'envoi s'arrête.
 *
 * Pourquoi il ne lève jamais
 * ──────────────────────────
 * L'action est branchée sur un événement émis PENDANT le traitement d'un
 * lead. Une exception ici remonterait dans le workflow et ferait perdre le
 * lead — pour un défaut de journalisation. Toute erreur est donc absorbée et
 * consignée dans les logs Saltcorn, jamais propagée.
 */
const Table = require("@saltcorn/data/models/table");
const { getState } = require("@saltcorn/data/db/state");

const log = (level, msg) => {
  try {
    getState().log(level, `[journal-pipeline] ${msg}`);
  } catch (e) {
    console.log(`[journal-pipeline] ${msg}`);
  }
};

/**
 * Clés posées par Saltcorn autour de la charge utile.
 *
 * Selon le chemin d'appel, l'action reçoit son contenu à plat, sous `row`,
 * ou les deux. On fusionne les deux sources, puis on retire ce que le
 * moteur a ajouté — sans quoi la colonne `donnees` se remplirait de la
 * configuration du déclencheur et de l'objet utilisateur à chaque ligne.
 */
const CLES_MOTEUR = new Set([
  "row", "user", "configuration", "table", "trigger_id", "channel",
  "req", "res", "mode", "old_row", "updated_fields", "referrer",
  "rndid", "Table", "Actions", "emitEvent",
]);

const chargeUtile = (args) => {
  const out = { ...(args && args.row && typeof args.row === "object" ? args.row : {}) };
  for (const [k, v] of Object.entries(args || {}))
    if (!CLES_MOTEUR.has(k)) out[k] = v;
  return out;
};

const entier = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

module.exports = {
  sc_plugin_api_version: 1,

  /* `hasChannel` : les nœuds passent leur nom en canal. Un déclencheur peut
   * donc n'écouter qu'une étape précise, sans filtrer dans le code. Laissez
   * le canal vide pour tout capter — c'est l'usage attendu. */
  eventTypes: () => ({ journal_pipeline: { hasChannel: true } }),

  actions: () => ({
    journal_enregistrer: {
      configFields: [
        {
          name: "table_journal",
          label: "Table de journalisation",
          type: "String",
          default: "journal_pipeline",
          sublabel:
            "Colonnes attendues : noeud, action, email_brut, lead, "
            + "donnees, horodatage. Créée par E9-journal-execution.js.",
        },
        {
          name: "max_donnees",
          label: "Taille maximale du JSON",
          type: "Integer",
          default: 4000,
          sublabel:
            "Le nœud `if_produit` peut émettre un bien entier. Sans coupe, "
            + "une ligne de journal pèserait plus que le lead lui-même.",
        },
      ],

      run: async (args) => {
        try {
          const cfg = (args && args.configuration) || {};
          const nom = cfg.table_journal || "journal_pipeline";
          const t = Table.findOne({ name: nom });
          if (!t) {
            log(2, `table « ${nom} » introuvable — ligne perdue`);
            return {};
          }

          const p = chargeUtile(args);
          const { noeud, action, email_brut, lead, ...reste } = p;

          let donnees = "";
          try {
            donnees = JSON.stringify(reste);
          } catch (e) {
            // Référence circulaire : on garde au moins les clés.
            donnees = JSON.stringify({ __cles: Object.keys(reste) });
          }
          const max = Number(cfg.max_donnees) || 4000;
          if (donnees.length > max)
            donnees = donnees.slice(0, max) + `…[coupé, ${donnees.length} car.]`;

          await t.insertRow({
            // ★ Repli sur le canal : si un nœud oublie `noeud` dans sa charge
            //   utile, le canal porte déjà son nom. Une ligne anonyme dans un
            //   journal d'exécution ne sert à rien.
            noeud: noeud || (args && args.channel) || null,
            action: action || null,
            email_brut: entier(email_brut),
            lead: entier(lead),
            donnees,
            horodatage: new Date(),
          });
          return {};
        } catch (e) {
          // ★ Jamais de propagation : voir l'en-tête du fichier.
          log(2, `écriture impossible : ${e.message}`);
          return {};
        }
      },
    },
  }),
};
