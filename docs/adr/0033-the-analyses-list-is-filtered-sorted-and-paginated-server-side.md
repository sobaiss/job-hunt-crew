# The Analyses list is filtered, sorted and paginated server-side

`GET /v1/analyses` returned every Analysis a candidate had, each with its full `resultJSON`, and `apps/web/lib/analyses-filters.ts` did the rest in the browser: search, six filters, twelve sort columns, 25 rows to a page. The Dashboard fetched the same list again to average it. That worked while a candidate had tens of analyses and gets worse with every Scout run, since a Scout fans out 25 offers per site per day.

We decided the endpoint takes the filters, the sort and the page, and answers with `{analyses, total, page, pageSize}`.

Paginating without moving the filter and the sort was never an option: a page of 25 sliced before the filter runs is not a page of the filtered list. So the whole narrowing went, or none of it.

## What that costs, deliberately

**The selection is the page's.** Bulk actions read the *rows*, not just their ids — which are terminal, which are stuck, which still need a document, and the ten fields the CSV export writes. Rows on other pages are no longer in memory to ask, so "Sélectionner les 347 correspondant à vos filtres" is gone and the selection empties when the page changes.

The alternatives were weighed and rejected. Keeping a client-side cache of every row ever seen re-creates the memory problem one page at a time and still cannot answer for pages never visited. An ids-plus-flags endpoint would restore the banner, but every bulk action would then need its own server-side counterpart taking a filter instead of a list of ids — a much larger change than the one that prompted it. Bulk actions on a selection you can see is a smaller promise, and an honest one.

**The CSV export follows the selection**, so it now covers at most one page. Exporting a whole filtered set is a server-side job and is not built here.

**Filtering is no longer instant.** The two free-text boxes commit on a pause (`useDebouncedField`, 300ms) instead of on every keystroke, and the table keeps the previous page on screen while the next loads (`placeholderData: keepPreviousData`) rather than blanking to skeletons — which is what the Admin analyses table does today, and what we did not copy.

## Consequences worth knowing

- **Every sort gets a tie-break.** `requestedAt DESC, id` is appended after the requested column. Rows tied on the sort value have no order of their own, and an unordered remainder is what makes a paginated list drop and repeat rows between two requests. The default sort is `postedAt`, which is NULL in bulk — the common case, not a corner. NULLs sort last in both directions and text sorts case-insensitively, both matching the comparator the client used.
- **The server clamps a page past the end** to the last page and reports the page it served in the envelope. A `?page=9` outlived by a filter or a deletion is a stale link, not a request for nothing — and clamping client-side would have meant a wasted empty request first.
- **Two reads came with it.** `GET /v1/analyses/stats` answers the Dashboard's tiles and score trend over every Analysis — otherwise the Dashboard would have been the one screen still fetching all of them. `GET /v1/analyses/cv-labels` backs the CV filter's options, which the table used to read off the list; computed over the filtered set it would hide the labels the filter exists to switch between.
- **The rows still carry `resultJSON`.** Bounded to a page, it is affordable, and it is what lets the Quick view render a full result breakdown from the row it was opened on rather than fetching again on every arrow press.
- **The Quick view's arrows still walk the whole filtered list**, fetching the page they land on. They now identify their target by *rank* while crossing a boundary, since the row's id only arrives with the page — which is why the panel has its own open state rather than being open exactly when it has a row.
- **A filter matching nothing is told apart from having no analyses** by whether a filter is set, not by the row count, and the filter panel renders whenever one is. Getting that wrong hid the panel — and with it "Effacer les filtres" — leaving the candidate on an empty table with no way back but editing the URL.
- **The filter vocabulary is now shared in SQL**, `api/analysis_filters.py`, with the Admin analyses table. What the two still do not share is the interaction: any number of buckets here, exactly one there.
- **`filterAnalyses`, `sortAnalyses`, `paginate` and `cvLabelsOf` are deleted**, with their unit tests. The semantics they held are tested where they run now, in `services/api/tests/test_v1_analyses_list.py`; the frontend's own suite asserts that the right query goes out and that what comes back is rendered.
