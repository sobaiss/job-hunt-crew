# Live site verification — `make verify-sites`

One command asks the real sites, per site and per filter, whether a Search
filter is actually honoured (#209). It is the instrument that keeps a mapping
from being believed without evidence. It is **never** run by `make test` or
CI: a third party's rate limiting must not fail a build that contains no
fault.

```bash
make verify-sites                  # France Travail, HelloWork, LinkedIn
make verify-sites SITES=LINKEDIN   # only some sites (space-separated keys)
```

It needs no local infrastructure. France Travail's credentials are read from
`.env`; without them that site is skipped and the others still run. A run
takes about 40 seconds, because each fetch is paced.

Code: `services/ingestion/src/ingestion/site_verification.py`.

## What it does

Per site, it runs one baseline search, then the same search once per probe:

- **Canonical probes** drive a Search filter (`postedWithin=7d`,
  `remote=hybrid`, …) through the site's Site adapter. This is what a Scout
  really sends today.
- **Raw probes** replace one parameter on the baseline query
  (`raw d=w`). They prove a site's own vocabulary before an adapter is
  written to use it.

## Reading a verdict

| Verdict | Means |
|---|---|
| `honoured` | Fewer results with the filter than without. |
| `not honoured` | The adapter sends nothing for the filter, the API rejected it, the count did not move, or two capped counts list the very same offers. |
| `could not tell` | No count could be read, the fetch was blocked, two capped counts differ in their offers, or the filter *raised* the count. A filter never widens a search, so a higher count means the site answered a different search or the listing moved. |
| `empty result` | One side matched nothing. This is a valid answer, not an error, but it cannot separate a working filter from a value the site matched to nothing. |

Everything turns on a **differential count**, including on API sources. A
rejection alone is not enough. France Travail answers 400 to a bad *value*
(`region=Ile-de-France`), but silently ignores an unknown *parameter*
(`travailATemps`, `fooBar`) and returns the unfiltered count.

Per-site caveats:

- **LinkedIn** caps every count past 1,000 ("Plus de 1 000"). It also pads a
  thin search with unrelated offers, which is why `keywords=elixir` went
  from 992 to "5 000+" with a one-week window. The baseline is therefore a
  capped search, and two equal caps are settled by comparing the first page
  of offers. The offer set rotates slightly between requests, so identical
  probes can come back `could not tell` from one run to the next. Read
  several rows together, not one. LinkedIn may also answer with a
  reputation-based denial under volume, so read a failure there before
  believing it.
- **HelloWork** states an exact count in its results heading. Its one-month
  window covers nearly its whole listing, so `d=m` barely moves the count.

## Last recorded run — 2026-09-23

```
FRANCE_TRAVAIL   postedWithin=24h             honoured        3287 -> 247
FRANCE_TRAVAIL   postedWithin=7d              honoured        3287 -> 1044
FRANCE_TRAVAIL   postedWithin=14d             honoured        3287 -> 1884
FRANCE_TRAVAIL   postedWithin=30d             honoured        3287 -> 2620
FRANCE_TRAVAIL   remote=onsite                not honoured    3287 -> 3287
FRANCE_TRAVAIL   remote=hybrid                not honoured    3287 -> 3287
FRANCE_TRAVAIL   remote=remote                not honoured    3287 -> 3287
FRANCE_TRAVAIL   contractType=CDI             honoured        3287 -> 2238
FRANCE_TRAVAIL   location=Ile-de-France       not honoured    rejected: Valeur du paramètre « commune » incorrecte.
FRANCE_TRAVAIL   experienceLevel=senior       not honoured    the adapter sends nothing for this filter
FRANCE_TRAVAIL   raw region=11                honoured        3287 -> 1311
FRANCE_TRAVAIL   raw departement=69           honoured        3287 -> 247
HELLOWORK        postedWithin=24h             not honoured    the adapter sends nothing for this filter
HELLOWORK        postedWithin=7d              not honoured    the adapter sends nothing for this filter
HELLOWORK        postedWithin=14d             not honoured    the adapter sends nothing for this filter
HELLOWORK        postedWithin=30d             not honoured    the adapter sends nothing for this filter
HELLOWORK        remote=onsite                not honoured    the adapter sends nothing for this filter
HELLOWORK        remote=hybrid                not honoured    the adapter sends nothing for this filter
HELLOWORK        remote=remote                not honoured    the adapter sends nothing for this filter
HELLOWORK        contractType=CDI             honoured        1030 -> 709
HELLOWORK        location=Ile-de-France       honoured        1030 -> 420
HELLOWORK        experienceLevel=senior       not honoured    the adapter sends nothing for this filter
HELLOWORK        raw d=h                      honoured        1030 -> 91
HELLOWORK        raw d=d                      honoured        1030 -> 224
HELLOWORK        raw d=w                      honoured        1030 -> 428
HELLOWORK        raw d=m                      could not tell  1030 -> 1034 (more with the filter)
HELLOWORK        raw t=Complet                honoured        1030 -> 8
HELLOWORK        raw t=Partiel                honoured        1030 -> 293
HELLOWORK        raw t=Occasionnel            honoured        1030 -> 85
HELLOWORK        raw t=Pas_teletravail        honoured        1030 -> 271
LINKEDIN         postedWithin=24h             not honoured    1000+ -> 1000+ (both capped, same offers)
LINKEDIN         postedWithin=7d              not honoured    1000+ -> 1000+ (both capped, same offers)
LINKEDIN         postedWithin=14d             could not tell  1000+ -> 1000+ (both capped)
LINKEDIN         postedWithin=30d             could not tell  1000+ -> 1000+ (both capped)
LINKEDIN         remote=onsite                not honoured    1000+ -> 1000+ (both capped, same offers)
LINKEDIN         remote=hybrid                not honoured    1000+ -> 1000+ (both capped, same offers)
LINKEDIN         remote=remote                not honoured    1000+ -> 1000+ (both capped, same offers)
LINKEDIN         contractType=CDI             not honoured    1000+ -> 1000+ (both capped, same offers)
LINKEDIN         location=Ile-de-France       honoured        1000+ -> 785
LINKEDIN         experienceLevel=senior       not honoured    the adapter sends nothing for this filter
LINKEDIN         raw f_TPR=r86400             honoured        1000+ -> 115
LINKEDIN         raw f_TPR=r604800            honoured        1000+ -> 416
LINKEDIN         raw f_TPR=r2592000           honoured        1000+ -> 803
LINKEDIN         raw f_WT=1                   could not tell  1000+ -> 1000+ (both capped)
LINKEDIN         raw f_WT=2                   not honoured    1000+ -> 1000+ (both capped, same offers)
LINKEDIN         raw f_WT=3                   not honoured    1000+ -> 1000+ (both capped, same offers)
```

## What it established

**France Travail**
- `region` and `departement` are the right parameter names, and they take
  INSEE codes (`region=11`, `departement=69`). A label is rejected with 400.
  This confirms the secondary sources behind #215.
- The API silently ignores `travailATemps`, so `remote` has never filtered
  anything. The API has no telework criterion (#210).
- `typeContrat` also takes a comma-separated list: `CDI,CDD` returned 2504
  against 2238 for `CDI` alone (probed by hand, #214).
- `tempsPlein=true` is a real working-time parameter (769 of 3285). It is
  noted for the out-of-scope working-time filter, not used.

**HelloWork** (#213): these are the raw values, unknown until this run. They
are also the values HelloWork's own search form submits.
- Freshness is `d`: `h` = 24 hours, `d` = 3 days, `w` = 1 week, `m` =
  1 month (`all` = any). There is no 14-day value, which confirms the
  derogation: `14d` widens to `m`.
- Telework is `t`, with four values: `Complet` (full remote), `Partiel`,
  `Occasionnel`, `Pas_teletravail` (none). `t` is repeatable:
  `t=Complet&t=Partiel` returned 300 against 8 + 292.
- Working time is **not** in the same parameter. It is its own `ctt`
  (`ft` / `pt` / `np`), so `t` carries telework alone. This corrects the
  spec's assumption in #207 and #213.
- `c` is repeatable for contracts (`c=CDI&c=CDD`: 747 against 707). Its
  values are `CDI`, `CDD`, `Stage`, `Alternance`, `Freelance`,
  `Independant`, …
- `l=Ile-de-France` is honoured as a plain label.

**LinkedIn** (#212)
- `f_TPR` is honoured in its `r<seconds>` form and ignored as a canonical
  token. This confirms the fix #212 plans.
- **`f_WT` is not demonstrably honoured on the guest search page** that the
  pipeline scrapes. `f_WT=2` and `f_WT=3` returned the very same offers as
  the baseline. A hand-run check with `keywords=django&location=Lyon` (174
  results, uncapped) found `f_WT` and `f_JT` both leave the count and the
  offer set unchanged. The guest page's own filter bar exposes `f_TPR`,
  `f_C`, `f_EA` and `f_AL`, and no workplace or job type. #212 assumes
  `remote` becomes SUPPORTED on LinkedIn. Re-check that before declaring it.

## HelloWork after #213 — 2026-09-24

HelloWork's adapter now sends freshness `d` and telework `t`:

```
HELLOWORK        postedWithin=24h             honoured        1034 -> 91
HELLOWORK        postedWithin=7d              honoured        1034 -> 428
HELLOWORK        postedWithin=14d             not honoured    1034 -> 1034
HELLOWORK        postedWithin=30d             honoured        1034 -> 1027
HELLOWORK        remote=onsite                honoured        1034 -> 271
HELLOWORK        remote=hybrid                honoured        1034 -> 375
HELLOWORK        remote=remote                honoured        1034 -> 8
```

`14d` and `30d` send the very same query (`d=m`, the derogation). The month
covers nearly the whole listing, so the verdict for either one depends on
how the listing moved between two requests a second apart. Read the pair
together: `d=m` is honoured, and the raw `d=m` row agreed (1034 -> 1027).
`hybrid` sends `t=Partiel&t=Occasionnel`: 375, against 293 + 85 for the two
values alone.

## LinkedIn after #212 — 2026-09-23

LinkedIn's adapter now sends freshness `f_TPR` as a seconds count
(`r86400`, `r604800`, `r1209600`, `r2592000`). The raw `f_TPR` probes were
dropped: the canonical ones now send the same values.

```
LINKEDIN         postedWithin=24h             honoured        1000+ -> 115
LINKEDIN         postedWithin=7d              honoured        1000+ -> 416
LINKEDIN         postedWithin=14d             honoured        1000+ -> 830
LINKEDIN         postedWithin=30d             honoured        1000+ -> 803
LINKEDIN         raw f_WT=1                   not honoured    1000+ -> 1000+ (both capped, same offers)
LINKEDIN         raw f_WT=2                   not honoured    1000+ -> 1000+ (both capped, same offers)
LINKEDIN         raw f_WT=3                   not honoured    1000+ -> 1000+ (both capped, same offers)
```

The 14d count (830) is above 30d's (803). The offer set rotates between
requests, so this does not mean the window is inverted. What matters is that
each window moved the count away from the cap.

`f_WT` is still not honoured, so `remote` stays UNSUPPORTED on LinkedIn. A
second hand check (`keywords=django&location=Lyon`, 174 results, uncapped)
got 174 with the baseline's offers for `f_WT=1` and `2`. `f_WT=3` got 172
once and then 174 with the baseline's offers again on a repeat, so that was
rotation.

## France Travail after #215 — 2026-09-23

France Travail's adapter now resolves `location` against `py_db.locations`
(18 regions, 101 departments) and sends the INSEE code as `region` or
`departement`. A value that resolves to nothing is not sent at all.

```
FRANCE_TRAVAIL   location=Ile-de-France       honoured        3287 -> 1311
FRANCE_TRAVAIL   location=Rhône               honoured        3287 -> 247
FRANCE_TRAVAIL   raw region=11                honoured        3287 -> 1311
FRANCE_TRAVAIL   raw departement=69           honoured        3287 -> 247
```

Each canonical row matches its raw row, so the adapter sends exactly the
code the raw probe proved.

## HelloWork after #216 — 2026-09-24

HelloWork's adapter now resolves `location` against `py_db.locations` and
sends the table's label `l` together with the companion region URL its own
search form submits in `l_autocomplete`:
`http://www.rj.com/commun/localite/region/11`,
`…/localite/departement/69`. HelloWork keys that URL on the same INSEE
codes as France Travail, departments included (`departement/2A`,
`departement/971`), so a department needs no derogation.

```
HELLOWORK        location=Ile-de-France       honoured        1027 -> 415
HELLOWORK        location=Rhône               honoured        1027 -> 84
```

Established by hand, `keywords=developpeur` (17,711):
- HelloWork resolves a label it recognises to the same URL itself, and the
  count follows `l`: `l=Bretagne` gave 1,276 with or without
  `l_autocomplete=…/region/53`, and still 1,276 with a mismatched
  `…/region/11`. The companion is sent for parity with the site's own form.
- An unrecognised label is matched as text and narrows the search:
  `l=Lyonn` gave 18. That is why a value that resolves to nothing is not
  sent, as on France Travail, and the search runs wider instead.
