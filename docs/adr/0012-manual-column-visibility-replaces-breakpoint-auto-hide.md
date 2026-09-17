# Manual Column visibility replaces breakpoint-driven auto-hide

Analyses already narrowed its table on small screens via a fixed `COLUMN_VISIBILITY` map (Tailwind `hidden <breakpoint>:table-cell` per column), independent of anything the candidate chose. Adding candidate-controlled Column visibility (Analyses, CV versions, Agents) meant deciding whether the two mechanisms should coexist — we retired the breakpoint map in favor of the candidate's explicit choice being the only thing that decides which columns render, at every viewport. Two competing sources of "is this column shown" would have let a candidate mark a column visible only to have it silently disappear on a narrower window; Analyses already falls back to `AnalysisCard` below 640px, so the breakpoint map's job was mostly redundant with that fallback anyway.

## Consequences

- CV versions and Agents still have no responsive fallback below the point where their table overflows — Column visibility gives a candidate a manual way to shrink the table, but a card layout for those two pages (like Analyses' `AnalysisCard`) was deliberately left out of scope here.
