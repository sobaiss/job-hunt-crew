# Scout panel follows Quick view, not CV panel, for scope

The Scouts list is moving to a full-width, sortable table with a right-hand
slide-over, on the same principle as the cv-versions page. Two shapes for
that slide-over already exist in this codebase: the CV panel, which absorbs
a CVVersion's entire detail with no separate detail route, and the Analyses
list's Quick view, a light summary that links out to a still-existing full
detail page. We picked the Quick view shape for the new Scout panel:
Scout's own detail page (config, run history, ScoutPatternsPanel, and Finds
— two `AnalysisRow` lists) is dense enough that folding it all into a
slide-over would make the panel unwieldy, and `/scouts/[id]` already exists
and works well as its own page — there's no CV-versions-style gap to fill.

## Considered Options

- **Full absorption** (CV panel shape): retire `/scouts/[id]`, move config,
  run history, patterns, and finds into the panel. Rejected — those
  sections are each substantial enough to want full-page real estate, and
  duplicating or dismantling `/scouts/[id]` to avoid a bloated panel wasn't
  worth it just to match cv-versions literally.
- **Quick view shape** (chosen): the panel shows Status, Base CV, Sites,
  Threshold, Filters, Last run, and the Run now / Pause / Resume / Archive
  / Edit actions; a link out reaches the unchanged `/scouts/[id]` for run
  history, patterns, and finds.
