# Scout panel absorbs the full detail page, superseding ADR 0006

Supersedes docs/adr/0006. That ADR picked the Quick view shape for the Scout
panel specifically because Configuration, run history, the patterns panel,
and Finds were "each substantial enough to want full-page real estate" —
full absorption (the CV panel's shape) was considered and rejected on that
basis, with `/scouts/[id]` staying the panel's link-out target for all of it.

This reverses that call: `/scouts/[id]` is deleted, and the panel now renders
all five sections in place — Configuration, Statistiques (`ApplicationStatsHeader`,
scoped to the Scout), Historique des exécutions (`ScoutRunHistory`), Patterns
(`ScoutPatternsPanel`), and Finds (`ScoutFinds`) — with no separate page left
to link out to.

## Why the reversal

ADR 0006's density concern hasn't gone away — the panel is materially longer
and taller than before. What changed is the trade-off being made against it:
a second surface for the same Scout (a summary in the panel, the rest one
click away on its own page) was judged not worth the navigation hop it costs,
now that the panel already has to support quick actions (Run now / Pause /
Resume / Archive / Edit) that a candidate reaches for right after skimming
exactly this content. Widening the panel to the CV panel's `sm:max-w-6xl` (it
was `sm:max-w-5xl`) buys back some of the room a separate page had.

## Consequences

- **Three now-orphaned links** that pointed at `/scouts/[id]` (the Edit-Scout
  page's back-link, `ScoutForm`'s post-edit redirect, and an Application
  detail page's "view Scout" back-link) target `/scouts?open=<id>` instead —
  a new, minimal deep-link convention: `ScoutsPage` reads `?open=` once on
  mount to seed which Scout's panel opens, then strips it from the URL.
- `ScoutRunHistory` and `ScoutFinds` are new standalone components, extracted
  from the deleted detail page's local `RunHistory`/`Finds` functions so the
  panel (and nothing else, for now) can render them; `ScoutPatternsPanel` and
  `ApplicationStatsHeader` were already reusable and needed no change beyond
  being mounted here too.
- If a Scout's content ever grows enough to want full-page space again (e.g.
  a bulkier Finds list, or a new section), that pressure now falls on the
  panel directly rather than on a page a candidate has to navigate to reach —
  the next revisit would need its own ADR rather than reopening this one.
