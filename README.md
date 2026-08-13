# journal-pipeline

Suivi d'exécution du workflow de traitement des leads, pour Saltcorn.

## Le problème

Les nœuds du workflow `automatisation` émettent, à chaque étape :

```js
emitEvent("journal_pipeline", "<nom du nœud>", { ... });
```

Un événement personnalisé n'apparaît dans la liste **When** d'un déclencheur
que s'il est déclaré par un module. Dans `@saltcorn/data/models/trigger.js` :

```js
static get when_options() {
  return [ "Never", "Insert", "Update", ...,
           ...Object.keys(getState().eventTypes) ];   // ← ici
}
```

Sans déclaration, aucun déclencheur ne peut écouter l'événement : les
émissions partent dans le vide. C'était le cas de `journal_pipeline`.

## Ce que fait ce module

1. Il **déclare** le type d'événement `journal_pipeline`, qui apparaît alors
   dans la liste **When**.
2. Il fournit l'action **`journal_enregistrer`**, qui écrit la charge utile
   dans une table.

## Installation

Modules → Ajouter un module → depuis git.

> **Nom : `journal-pipeline`** — il doit être identique au champ `name` du
> `package.json`, sinon Saltcorn ne retrouve pas le module après installation.

## Mise en service

1. Créer la table `journal_pipeline` — script `E9-journal-execution.js` :

   | colonne      | type    |
   |--------------|---------|
   | `noeud`      | String  |
   | `action`     | String  |
   | `email_brut` | Integer |
   | `lead`       | Integer |
   | `donnees`    | String  |
   | `horodatage` | Date    |

   `email_brut` et `lead` sont des entiers simples, **pas des clés
   étrangères** : un journal qui échoue sur une contrainte d'intégrité ment
   au moment précis où on a besoin de lui.

2. Créer un déclencheur :
   - Nom : `enregistrer_journal`
   - When : **`journal_pipeline`**
   - Canal : **vide** (pour capter tous les nœuds)
   - Action : `journal_enregistrer`

3. Créer une vue *List* sur `journal_pipeline`, triée sur `horodatage`, avec
   une recherche sur `email_brut`.

## Lecture

Un numéro de message dans la recherche donne son parcours complet, dans
l'ordre. **La dernière ligne écrite désigne l'étape qui a échoué** : c'est
celle qui n'a pas eu le temps d'émettre la suivante.

## Garanties

- **Ne lève jamais.** L'action est appelée pendant le traitement d'un lead ;
  une exception ferait perdre le lead pour un défaut de journalisation. Toute
  erreur est consignée dans les logs Saltcorn, jamais propagée.
- **Aucune dépendance npm.** Rien à installer, donc rien qui puisse échouer
  au chargement.
- **Module séparé.** Ne partage aucun code avec `imap-idle` ni `smtp-envoi` :
  l'observation ne doit jamais être la raison pour laquelle la relève ou
  l'envoi s'arrête.
