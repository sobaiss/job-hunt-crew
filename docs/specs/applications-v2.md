# Spec — Applications v2 : table calquée sur Analyses

## Contexte

La page `/applications` est aujourd'hui une liste étroite (`ApplicationRow` +
`ApplicationStatsHeader`). Elle doit devenir une vraie table avec les mêmes
conventions que `/analyses` : colonnes cachables, filtres avancés, sélection
multiple, Quick view.

Référence de départ : `apps/web/app/(app)/analyses/page.tsx`.

---

## Ce qui change

### 1. Stats masquées par défaut

`ApplicationStatsHeader` disparaît de la page. À la place, un bouton
**"Statistiques"** dans la toolbar ouvre un **modal** (Dialog) contenant le
même composant. Aucune modification du composant lui-même.

### 2. Table (remplace la liste de `ApplicationRow`)

Reprendre la structure de `AnalysisTableRow` / `AnalysisCard` depuis
`analyses/page.tsx`.

**Colonnes** (même mécanique que Analyses — `useColumnVisibility`) :

| Colonne | Visible par défaut | Clé |
|---|---|---|
| Titre | ✅ (toujours) | — |
| Entreprise | ✅ | `company` |
| Lieu | — | `location` |
| Plateforme | — | `sourceSite` |
| Date de candidature | ✅ | `appliedAt` |
| Score (match) | ❌ | `score` |
| Statut CV tailored | — | `tailoredCv` |
| Statut lettre | — | `coverLetter` |
| Statut tracking | ✅ (toujours) | — |
| Lien externe | ✅ (toujours) | — |

Clé localStorage : `column-visibility:applications`.

Tri par défaut : `appliedAt` desc (le plus récent en premier).

### 3. Filtres

**Toujours visibles :**
- Recherche texte (titre / entreprise / lieu) — `q`
- Statut (Tracking status, multi-select `CheckboxFilterMenu`) — `status`

**Panel avancé ("Plus de filtres") :**
- Date de candidature depuis (`appliedAtFrom`)
- Date de candidature jusqu'à (`appliedAtTo`)
- Scout (`scoutId`, select des scouts de l'utilisateur)
- Plateforme (`sourceSite`, `CheckboxFilterMenu` sur `JOB_OFFER_SOURCE_SITES`)
- Lieu (`location`, texte libre)

Comportement identique à Analyses : URL-synced, "Clear filters", compteur de
filtres actifs sur le toggle.

Fichier à créer : `apps/web/lib/applications-filters.ts` (calqué sur
`analyses-filters.ts`).

### 4. Actions bulk

Apparaissent quand au moins une ligne est sélectionnée (même mécanique que
Analyses — select-page, select-all-matching).

| Action | Hook |
|---|---|
| Changer le statut tracking | `useBulkSetApplicationStatus` (déjà existe) |
| Export CSV | à créer dans `apps/web/lib/applications-csv.ts` |

**À ne pas implémenter ici :**
- Génération de documents (appartient à `/analyses`)
- Relancer l'analyse / Requeue

### 5. Application Quick View

Nouveau composant `ApplicationQuickView` dans
`apps/web/components/application-quick-view.tsx`, calqué sur
`AnalysisQuickView`.

Contenu minimal :
- Titre + entreprise + lieu + lien externe
- Statut tracking + boutons de changement de statut
- Timeline des StatusEvents
- Liens : "Voir l'analyse", "Voir le Scout", "Documents générés"
- Navigation Précédent / Suivant (même pattern que Quick view navigation)

Le click sur une ligne ouvre le panel (même mécanique slide-over que
`AnalysisQuickView`).

---

## Ce qui ne change pas

- Les hooks `useApplications`, `useApplicationStats`, `useBulkSetApplicationStatus`
  restent tels quels — on n'ajoute que ce qui manque.
- Le composant `ApplicationStatsHeader` reste tel quel — seul son point
  d'entrée change (modal au lieu d'inline).

---

## Fichiers à créer / modifier

| Fichier | Action |
|---|---|
| `apps/web/app/(app)/applications/page.tsx` | Réécrire |
| `apps/web/lib/applications-filters.ts` | Créer (calqué sur `analyses-filters.ts`) |
| `apps/web/lib/applications-csv.ts` | Créer (calqué sur `analyses-csv.ts`) |
| `apps/web/components/application-quick-view.tsx` | Créer |
| `apps/web/hooks/use-applications.ts` | Vérifier que `useApplications` accepte les nouveaux paramètres de filtre/tri ; compléter si besoin |

---

## Hors périmètre

- Filtre par CV utilisé
- Génération de documents depuis `/applications`
- Modification du backend / API

---

## Addendum — suppression de `/applications/[id]`

- La page `/applications/[id]` est supprimée ; l'Application quick view devient
  l'unique vue d'une candidature. La route BFF `/api/applications/[id]` et le
  hook `useApplication` restent (ils alimentent la Quick view).
- Le lien « Voir l'historique complet » et les clés i18n `detail.*` orphelines
  disparaissent ; la timeline affiche tous les StatusEvents (plus de limite à 3).
- La Quick view affiche : statut + actions, date de candidature, CV utilisé
  (`cvVersion.label`), Scout, titre / entreprise / lieu / plateforme / lien de
  l'offre, résumé + score de l'Analysis (via `analysisId`, chargée à l'ouverture,
  section masquée si non `COMPLETED` ou sans résumé), documents générés, timeline.
- Aucune modification d'API.
