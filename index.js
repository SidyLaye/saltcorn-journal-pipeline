/**
 * journal-pipeline — suivi d'exécution du workflow de traitement des leads.
 *
 * Le problème qu'il résout
 * ───────────────────────
 * Les nœuds du workflow appellent depuis le premier jour :
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
 * Personne ne déclarait `journal_pipeline`. Aucun déclencheur ne pouvait
 * l'écouter : chaque émission partait dans le vide.
 *
 * Pourquoi la politique de taille est ICI et non dans les nœuds
 * ────────────────────────────────────────────────────────────
 * Un nœud qui verse ses entrées verse `corps_html` avec : 40 Ko par e-mail.
 * Vingt-et-un nœuds, entrée et sortie, une centaine de leads par jour, et le
 * journal pèse plus lourd que les données qu'il observe.
 *
 * Écrêter dans chaque nœud reviendrait à répéter la même précaution vingt et
 * une fois, et à l'oublier au vingt-deuxième. Ici, elle est unique et
 * s'applique même si un nœud déverse son contexte entier par accident.
 *
 * Pourquoi il ne lève jamais
 * ──────────────────────────
 * L'action est appelée PENDANT le traitement d'un lead. Une exception
 * remonterait dans le workflow et ferait perdre le lead — pour un défaut de
 * journalisation. Toute erreur est absorbée et consignée dans les logs
 * Saltcorn, jamais propagée.
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
 * ou les deux. On fusionne, puis on retire ce que le moteur a ajouté — sans
 * quoi `donnees` se remplirait de la configuration du déclencheur et de
 * l'objet utilisateur à chaque ligne.
 */
const CLES_MOTEUR = new Set([
  "row", "user", "configuration", "table", "trigger_id", "channel",
  "req", "res", "mode", "old_row", "updated_fields", "referrer",
  "rndid", "Table", "Actions", "emitEvent",
]);

/**
 * ★ SECRETS — masqués, jamais écrits.
 *
 * Le jeton Immofacile circule dans le contexte du workflow. Un nœud qui
 * verse ses entrées le verserait avec. Il finirait dans une table affichée
 * sur un tableau de bord et présente dans chaque `pg_dump` — un porteur
 * valide sept jours, lisible par quiconque ouvre la sauvegarde.
 * Aucune taille n'est indiquée : elle renseignerait déjà sur le secret.
 */
const CLES_SECRETES = new Set([
  "jeton", "password", "mot_de_passe", "client_secret", "entete_basic",
  "authorization", "access_token", "secret",
]);

/**
 * ★ DÉJÀ AILLEURS — remplacées par un renvoi, pas par leur contenu.
 *
 * `corps_html` fait 40 Ko et se trouve déjà dans
 * `email_brut_selection_habitat`. Le recopier à chaque nœud, c'est stocker
 * cent fois la même chose et rendre le journal illisible. La ligne porte
 * déjà `email_brut` : le renvoi suffit, et il reste cliquable au tableau
 * de bord.
 */
const CLES_AILLEURS = new Set([
  "corps_html", "corps_texte", "corps", "msg",
]);

/**
 * ★ RÉSUMABLES — on garde ce qui sert au diagnostic, on jette le reste.
 *
 * Un bien Immofacile fait 3 Ko dont on ne relit jamais que quatre champs.
 * Les garder répond à « quel bien, chez qui » sans porter le reste.
 */
const RESUME = {
  bien: (v) => (v && typeof v === "object"
    ? { id: v.id, model: v.model, price: v.price,
        agence: v.manufacturers_id, nego: v.assigned_to && v.assigned_to.id }
    : v),
};

const chargeUtile = (args) => {
  const out = { ...(args && args.row && typeof args.row === "object" ? args.row : {}) };
  for (const [k, v] of Object.entries(args || {}))
    if (!CLES_MOTEUR.has(k)) out[k] = v;
  return out;
};

const taille = (v) => {
  try {
    return typeof v === "string" ? v.length : JSON.stringify(v).length;
  } catch (e) {
    return -1;
  }
};

/**
 * Applique les trois politiques, dans cet ordre — le secret d'abord, pour
 * qu'aucune autre règle ne puisse le laisser passer.
 */
const alleger = (obj, seuil, emailBrut) => {
  const out = {};
  const renvoi = emailBrut != null
    ? `«voir email_brut #${emailBrut}»`
    : "«déjà stocké ailleurs»";

  for (const [k, v] of Object.entries(obj)) {
    const cle = String(k).toLowerCase();

    if (CLES_SECRETES.has(cle)) { out[k] = "«masqué»"; continue; }
    if (v === null || v === undefined) { out[k] = v; continue; }
    if (CLES_AILLEURS.has(cle)) { out[k] = renvoi; continue; }
    if (RESUME[cle]) { out[k] = RESUME[cle](v); continue; }

    // Repli générique : ce qu'on n'a pas prévu et qui est gros.
    const n = taille(v);
    out[k] = n > seuil ? `«${n} car.»` : v;
  }
  return out;
};

const entier = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const date = (x) => {
  if (!x) return null;
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d;
};

module.exports = {
  sc_plugin_api_version: 1,

  /* `hasChannel` : les nœuds passent leur nom en canal. Un déclencheur peut
   * donc n'écouter qu'une étape précise sans filtrer dans le code. Laissez
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
            "Colonnes : email_brut, recu_le, objet, noeud, phase, action, "
            + "lead, donnees, horodatage. Créée par E9-journal-execution.js.",
        },
        {
          name: "seuil_valeur",
          label: "Seuil par valeur (caractères)",
          type: "Integer",
          default: 500,
          sublabel:
            "Au-delà, la valeur est remplacée par sa taille. Protège le "
            + "journal même si un nœud déverse son contexte entier.",
        },
        {
          name: "max_donnees",
          label: "Taille maximale de la ligne (caractères)",
          type: "Integer",
          default: 8000,
          sublabel: "Coupe finale du JSON, après allègement.",
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
          const {
            noeud, phase, action, email_brut, lead, recu_le, objet, ...reste
          } = p;

          const seuil = Number(cfg.seuil_valeur) || 500;
          let donnees = "";
          try {
            donnees = JSON.stringify(alleger(reste, seuil, entier(email_brut)));
          } catch (e) {
            // Référence circulaire : on garde au moins les clés.
            donnees = JSON.stringify({ __cles: Object.keys(reste) });
          }
          const max = Number(cfg.max_donnees) || 8000;
          if (donnees.length > max)
            donnees = donnees.slice(0, max) + `…«coupé, ${donnees.length} car.»`;

          await t.insertRow({
            email_brut: entier(email_brut),
            recu_le: date(recu_le),
            objet: objet ? String(objet).slice(0, 300) : null,
            // ★ Repli sur le canal : si un nœud oublie `noeud` dans sa charge
            //   utile, le canal porte déjà son nom. Une ligne anonyme dans un
            //   journal d'exécution ne sert à rien.
            noeud: noeud || (args && args.channel) || null,
            phase: phase || null,
            action: action || null,
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
