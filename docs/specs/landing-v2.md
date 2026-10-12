# Spec — Landing v2 : raconter le parcours complet

## Contexte

La Landing page (`apps/web/components/landing-page.tsx`, textes sous
`landing.*` dans `messages/{fr,en}.json`) décrit encore le produit du jalon
M6 : « collez une URL, choisissez un CV, lisez l'analyse ». Depuis, le
produit a gagné les agents autonomes (Scouts), la génération de lettre de
motivation et de CV adapté, le suivi des candidatures, les formules
`free` / `standard` / `premium` et l'anonymisation du CV avant l'IA. Rien de
tout cela n'apparaît sur la page.

Elle contient aussi des erreurs factuelles :

- la FAQ cite Indeed et Glassdoor, tous deux désactivés dans `seed.js` ;
- la FAQ affirme que l'IA « ne réécrit pas votre CV », alors qu'elle produit
  désormais un CV adapté (sans jamais modifier le CV d'origine) ;
- la limite d'analyses est un placeholder ⚠, alors que les quotas existent.

Vocabulaire : voir l'entrée **Landing page** de `apps/web/CONTEXT.md`.

---

## Décisions

| # | Décision |
|---|---|
| Récit | Le parcours complet **trouver → analyser → adapter → postuler → suivre**. Les agents sont l'élément différenciant, mis en avant ; l'analyse est le moteur de toutes les étapes. |
| Terme public | Un Scout s'appelle toujours **agent** sur la page, comme dans la navigation une fois connecté. Jamais « Scout ». |
| Formules | Section **Formules** affichant les trois formules par leurs quotas, **sans prix** : il n'y a ni facturation ni changement de formule en libre-service. |
| Quotas affichés | Lus en direct depuis `PlanQuotaDefault` via un nouvel endpoint, pour rester vrais quand un administrateur modifie les plafonds (ADR 0014). |
| Appel à l'action | **« Commencer gratuitement »** comme action principale. « Se connecter » reste uniquement dans l'en-tête. |
| Sites cités | France Travail, Welcome to the Jungle, HelloWork, Remotive, plus « toute offre via son URL ». **LinkedIn n'est pas cité comme source** (risque CGU, PRD §14). Adzuna n'est pas cité tant que ses identifiants ne sont pas configurés. |
| Confidentialité | L'anonymisation du CV (ADR 0022) devient le premier argument. |
| Visuels | Carte d'agent illustrative dans le hero. Vraies captures clair/sombre pour les sections Agents, Documents et Candidatures. La section « Aperçu du tableau de bord » est supprimée. |
| Langue | Cette spec fixe les textes FR définitifs. L'EN est traduit à l'implémentation. |

---

## Structure de la page

Dans l'ordre :

1. En-tête
2. Hero
3. Parcours en 5 étapes (`#how`)
4. Agents autonomes (`#agents`)
5. Lettre et CV adaptés
6. Suivi des candidatures
7. Et aussi (`#features`)
8. Confidentialité
9. Formules (`#plans`)
10. FAQ (`#faq`)
11. Bandeau final + pied de page

### 1. En-tête

Liens d'ancre : **Fonctionnement** (`#how`) · **Agents** (`#agents`) ·
**Formules** (`#plans`) · **FAQ** (`#faq`), puis `LocaleSwitch` et le bouton
**Se connecter** (`/sign-in`).

### 2. Hero

- Surtitre : **Recherche d'emploi assistée par IA**
- Titre : **Vos agents cherchent les offres. Vous choisissez où postuler.**
- Description : *Job Hunt Crew lance chaque jour des agents de recherche sur
  les sites d'emploi, compare chaque offre à votre CV et vous montre celles
  qui correspondent. Pour chacune, une lettre de motivation et un CV adaptés,
  puis le suivi de votre candidature.*
- Bouton principal : **Commencer gratuitement** → `/sign-in`
- Lien secondaire : **Comment ça marche** → `#how`
- Mention : *Formule Free incluse à l'inscription. Connexion par e-mail,
  Google ou LinkedIn.*

**Visuel : `HeroAgentCard`**, qui remplace `HeroPreviewCard`. C'est une
carte illustrative, `aria-hidden`, avec des données d'exemple et non une
capture :

- En-tête : **Agent · Data Engineer — Paris**, avec le badge « À jour »
- Ligne d'état : *Exécuté ce matin · 31 offres analysées · 4 pertinentes*
- Seuil : *Seuil de pertinence : 70*
- Trois lignes d'offres avec leur score (réutiliser `MatchScoreGauge` en
  `sm` sur la première, ou une pastille de score par ligne) :
  - Senior Data Engineer · Payflow — 91
  - Data Engineer Spark · Kessel — 84
  - Analytics Engineer · Novable — 76

### 3. Parcours en 5 étapes (`#how`)

Titre : **De l'offre à la candidature, au même endroit**

| # | Titre | Texte |
|---|---|---|
| 01 | **Trouver** | Un agent explore chaque jour les sites que vous ciblez, avec vos filtres. Ou collez simplement l'URL d'une offre. |
| 02 | **Analyser** | Chaque offre est comparée à votre CV : score de correspondance, compétences retrouvées, manques à combler. |
| 03 | **Adapter** | Pour les offres qui vous intéressent, générez une lettre de motivation et un CV adaptés. |
| 04 | **Postuler** | Vous relisez, téléchargez et postulez vous-même, sur le site de l'offre. |
| 05 | **Suivre** | Chaque candidature garde son statut et son historique jusqu'à la réponse. |

Mise en page : 5 colonnes sur grand écran, empilées sur mobile. Mêmes
pastilles numérotées et icônes que les 3 étapes actuelles.

### 4. Agents autonomes (`#agents`)

Section texte + capture, avec le visuel à droite.

- Surtitre : **Agents autonomes**
- Titre : **Des agents autonomes qui cherchent et analysent pour vous**
- Texte : *Configurez un agent une fois : il tourne chaque jour sans vous et
  vous attend avec les offres qui valent d'être lues.*
- Points :
  - Un CV de référence, les sites à interroger et vos filtres : mots-clés,
    lieu, date de publication, type de contrat, télétravail, niveau
    d'expérience.
  - Un seuil de pertinence (70 par défaut) : seules les offres qui
    l'atteignent sont présentées comme pertinentes ; les autres restent
    consultables.
  - Une exécution automatique chaque jour, ou à la demande, au plus une fois
    par heure.
  - Avant le lancement, vous voyez pour chaque site quels filtres seront
    respectés, approximés ou non pris en charge.
  - Un historique des exécutions et un état lisible d'un coup d'œil : en
    cours, à jour, en échec.

Capture : le **panneau Agent** (Configuration, Statistiques, Résultats
pertinents), fichiers `public/landing-agents-{light,dark}.png`.

### 5. Lettre et CV adaptés

Section texte + capture, avec le visuel à gauche (alternance).

- Surtitre : **Lettre et CV adaptés**
- Titre : **Une lettre de motivation et un CV taillés pour chaque offre**
- Texte : *À partir de l'analyse, Job Hunt Crew rédige une lettre de
  motivation et une version de votre CV qui met en avant ce que l'offre
  demande.*
- Points :
  - Fidèle à votre parcours : l'IA réordonne et reformule ce que contient
    votre CV, sans jamais inventer d'employeur, de date ou de diplôme.
  - Dans votre style : le CV adapté reprend autant que possible les polices,
    les couleurs et la mise en page de votre CV d'origine (PDF ou Word).
  - Rédigés dans la langue de l'offre.
  - Téléchargeables en PDF, Word, Markdown ou texte brut.
  - Produits uniquement à votre demande, document par document. Votre CV
    d'origine n'est jamais modifié.

Capture : un **CV adapté** affiché dans la Quick view d'une analyse,
fichiers `public/landing-documents-{light,dark}.png`.

### 6. Suivi des candidatures

Section texte + capture, avec le visuel à droite.

- Surtitre : **Suivi des candidatures**
- Titre : **Toutes vos candidatures, de l'envoi à la réponse**
- Texte : *Dès que vous générez un document ou marquez une offre comme
  postulée, elle rejoint votre suivi.*
- Points :
  - Des statuts clairs : à postuler, en cours, refusé, accepté, retiré.
  - Un historique daté de chaque changement, avec vos notes.
  - Au même endroit : le CV utilisé, l'agent qui a trouvé l'offre, la lettre
    et le CV générés.
  - Des statistiques sur 30 jours ou depuis le début, et un export CSV.

Capture : la **table Applications** avec l'Application quick view ouverte,
fichiers `public/landing-applications-{light,dark}.png`.

### 7. Et aussi (`#features`)

Titre : **Et aussi**. Grille de 3 cartes, sur le modèle des cartes actuelles.

| Icône | Titre | Texte |
|---|---|---|
| `Target` | **Une analyse qui se justifie** | Chaque compétence retrouvée est appuyée par la ligne de votre CV qui la justifie. Les manques sont classés indispensables ou optionnels, les suggestions par priorité. |
| `GitCompare` | **Plusieurs CV, comparés côte à côte** | Gérez plusieurs versions de votre CV, remplacez-les sans perdre l'historique et comparez-les sur une même offre. |
| `Link2` | **Une recherche ponctuelle** | Pas besoin d'agent pour une seule offre : collez son URL, ou interrogez un site avec vos filtres et obtenez les offres classées par score. |

### 8. Confidentialité

- Titre : **Vos données restent les vôtres**
- Texte : *Vos CV, vos analyses, vos documents et vos candidatures sont
  rattachés à votre compte, et à lui seul.*
- Points :
  1. Votre nom, vos coordonnées, votre date de naissance et votre
     nationalité sont retirés de votre CV avant toute analyse par l'IA. Ils
     ne sont réintégrés que dans les documents générés pour vous.
  2. CV, analyses, documents et candidatures sont privés à votre compte.
  3. Seules les annonces sont partagées, comme données publiques
     dédupliquées.
  4. Connexion via Google, LinkedIn ou un lien e-mail : aucun mot de passe à
     compromettre.

### 9. Formules (`#plans`)

- Surtitre : **Formules**
- Titre : **Commencez gratuitement, montez en volume si besoin**
- Texte : *Toutes les fonctionnalités sont incluses dans chaque formule.
  Seuls les volumes changent.*

Trois cartes côte à côte, empilées sur mobile :

| | Free | Standard | Premium |
|---|---|---|---|
| Sous-titre | Pour découvrir | Pour une recherche active | Pour une recherche intensive |
| Ligne 1 | `{n}` agents actifs | idem | idem |
| Ligne 2 | `{n}` analyses par jour | idem | idem |
| Ligne 3 | `{n}` analyses par mois | idem | idem |
| Ligne 4 | `{n}` documents générés par jour | idem | idem |
| Action | **Commencer gratuitement** (bouton principal) | **Commencer gratuitement** (bouton secondaire) | **Commencer gratuitement** (bouton secondaire) |

- Une limite `null` s'affiche **Illimité** à la place de `{n}` et du
  libellé.
- Sous les cartes : *Standard et Premium sont attribuées sur demande une fois
  inscrit. Pas de paiement en ligne pour l'instant.*
- **Repli** si `/v1/plans` échoue : les trois cartes s'affichent avec leur
  sous-titre seulement, sans lignes chiffrées, avec la même phrase sous les
  cartes. On n'affiche jamais de chiffre codé en dur.

À titre indicatif, les valeurs initiales des migrations sont :

| | Free | Standard | Premium |
|---|---|---|---|
| Agents actifs | 2 | 5 | 15 |
| Analyses / jour | 15 | 50 | 150 |
| Analyses / mois | 300 | 1000 | 3000 |
| Documents générés / jour | 5 | 20 | 60 |

### 10. FAQ (`#faq`)

Titre : **Questions fréquentes**

1. **Quels formats de CV puis-je importer ?**
   PDF, DOCX, Markdown ou texte brut, jusqu'à 10 Mo par fichier.
2. **Quels sites d'emploi sont pris en charge ?**
   Vos agents peuvent interroger France Travail, Welcome to the Jungle,
   HelloWork et Remotive. Vous pouvez aussi coller l'URL d'une offre publiée
   sur n'importe quel site.
3. **À quelle fréquence tournent les agents ?**
   Une fois par jour, automatiquement, tant que l'agent est actif. Vous
   pouvez aussi le lancer à la demande, au plus une fois par heure.
4. **Postulez-vous à ma place ?**
   Non. Rien n'est généré ni envoyé automatiquement : vous choisissez les
   lettres et les CV à produire, vous les relisez et vous postulez vous-même.
5. **L'IA invente-t-elle des expériences ?**
   Non. Elle réordonne et reformule ce que contient votre CV, sans jamais
   ajouter d'employeur, de date, d'intitulé de poste ni de diplôme.
6. **Tous les filtres fonctionnent-ils sur tous les sites ?**
   Pas toujours. Lorsque vous configurez un agent, le formulaire indique pour
   chaque site si un filtre est respecté, approximé ou non pris en charge,
   avant le lancement.
7. **Qui peut voir mes CV et mes analyses ?**
   Vous seul. Chaque requête est filtrée par votre compte, et vos
   informations d'identité sont retirées de votre CV avant toute analyse par
   l'IA.
8. **Comment passer en Standard ou Premium ?**
   Inscrivez-vous gratuitement, puis demandez le passage à la formule
   souhaitée. Les formules Standard et Premium sont attribuées sur demande,
   sans paiement en ligne pour l'instant.

Le placeholder ⚠ « limite d'analyses quotidienne » est supprimé.

### 11. Bandeau final et pied de page

- Bandeau final, titre : **Laissez vos agents chercher pour vous.**
- Bouton : **Commencer gratuitement**
- Mention : *Formule Free incluse. Connexion par e-mail, Google ou LinkedIn.*
- Pied de page :
  - slogan : *Des agents qui cherchent, analysent et préparent vos
    candidatures.*
  - colonne Produit : Fonctionnement, Agents, Formules, FAQ ;
  - les placeholders Ressources et Légal sont inchangés.

---

## Technique

### `GET /v1/plans` (services/api)

- Nouvelle route dans `services/api/src/api/v1.py`, **sans** la dépendance
  `require_user_id`. Le secret interne reste exigé, comme sur toute l'API.
- Elle lit uniquement `PlanQuotaDefault`. Jamais de `QuotaOverride` : la page
  décrit les formules, pas un utilisateur.
- Réponse, ordonnée free → standard → premium :

  ```json
  {
    "plans": [
      {
        "plan": "free",
        "quotas": {
          "ACTIVE_SCOUTS": 2,
          "ANALYSES_DAILY": 15,
          "ANALYSES_MONTHLY": 300,
          "DOCUMENTS_DAILY": 5
        }
      }
    ]
  }
  ```

- `null` signifie illimité, comme partout ailleurs.

### Web

- `app/(public)/page.tsx` (composant serveur) appelle l'API via
  `internalApiFetch("/v1/plans")`, seulement pour un visiteur non connecté,
  et passe `plans: PlanSummary[] | null` à `LandingPage`.
- Délai d'attente court (2 s). En cas d'erreur ou de délai dépassé, on passe
  `null`, ce qui déclenche le repli de la section Formules. La Landing page
  ne doit jamais échouer ni bloquer à cause de cet appel.
- Pas de route BFF : l'appel est fait côté serveur, aucun navigateur ne
  l'émet.
- Messages i18n :
  - supprimer `landing.hero.preview.*`, `landing.preview.*`,
    `landing.features.{evidence,gaps,suggestions,batch,trend}*`,
    `landing.faq.{limits,model}*` et `landing.placeholders.dailyCap` ;
  - ajouter les clés des sections 2 à 11 ;
  - mettre à jour `en.json` avec les mêmes clés.

### Captures

- Étendre `design/capture/` avec trois scénarios, sur le même principe que
  `dashboard.capture.spec.ts` (session créée de toutes pièces, routes BFF
  simulées avec des données de démo) :
  - panneau Agent ouvert sur `/scouts?open=<id>` ;
  - Quick view d'une analyse avec un CV adapté `READY` ;
  - `/applications` avec l'Application quick view ouverte.
- Chaque scénario produit une paire clair/sombre dans `public/`.
- Les données de démo restent cohérentes avec la `HeroAgentCard` (même agent
  « Data Engineer — Paris », mêmes entreprises fictives).
- Supprimer `public/dashboard-preview-{light,dark}.png` s'ils ne sont plus
  référencés.

---

## Hors périmètre

- Prix, paiement, changement de formule en libre-service.
- Liens Ressources et Légal du pied de page (placeholders inchangés).
- Toute modification de la Landing page pour un utilisateur connecté (`/`
  redirige toujours vers le Dashboard ou `/admin`).

## Point ouvert

- **Canal de demande de formule payante.** La section Formules et la
  question 8 de la FAQ disent « sur demande », mais il n'existe aujourd'hui
  aucun canal (ni adresse de contact, ni formulaire). Il faut le définir avant
  la mise en production. Dès qu'une adresse existe, les cartes Standard et
  Premium passent à un bouton **Nous contacter** (`mailto:` avec un sujet
  prérempli), et la question 8 cite ce canal.

## Critères d'acceptation

- Un visiteur non connecté voit les 11 sections dans l'ordre ci-dessus, en FR
  comme en EN.
- Le mot « Scout » n'apparaît nulle part sur la page, ni en FR ni en EN.
- Ni Indeed, ni Glassdoor, ni LinkedIn ne sont cités comme sources d'offres.
  LinkedIn reste cité comme moyen de connexion.
- Les quotas de la section Formules correspondent aux valeurs de
  `PlanQuotaDefault` au moment du rendu. Après une modification sur
  `/admin/quotas`, un rechargement de `/` affiche les nouvelles valeurs.
- API arrêtée : `/` s'affiche quand même, avec la section Formules en mode
  repli.
- Les trois captures existent en clair et en sombre et suivent le thème du
  visiteur.
- Plus aucun placeholder ⚠ dans le corps de la page (ceux du pied de page
  restent).
