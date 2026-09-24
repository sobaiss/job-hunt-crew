"""FilterSupport (docs/adr/0030): how faithfully each site honours each
Search filter key, declared per (site, filter) pair with the reason why.

Declared here, in code beside nothing but the enum it keys on, because both
services/api (which serves it in `GET /site-configs`) and services/ingestion
(whose Site adapters it describes) already depend on py-db and on nothing of
each other's. services/ingestion's `test_filter_support.py` fails when a
declaration disagrees with what the site is actually sent.

Declarations state today's truth, not the intended end state: a pair that a
later ticket will fix is UNSUPPORTED until that ticket lands, and its reason
says so — so nobody "fixes" a deliberate UNSUPPORTED back into a broken
mapping.

Hand-written (not sqlacodegen output), like `section_type.py`.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum

from .models import Siteconfigsitekey


class FilterSupportLevel(str, Enum):
    # The candidate gets what they asked for, whether the site filtered it
    # or this pipeline did so afterwards.
    SUPPORTED = "SUPPORTED"
    # The site shifts relevance or filters on a neighbouring concept, so
    # results outside the filter still come back.
    APPROXIMATED = "APPROXIMATED"
    # The filter cannot be expressed and is not applied.
    UNSUPPORTED = "UNSUPPORTED"


@dataclass(frozen=True)
class Derogation:
    """How one canonical value is treated differently from the rest of its
    pair. A derogation widens the filter, never narrows it: an offer outside
    the filter arrives carrying what lets the candidate dismiss it, while an
    offer never returned cannot be noticed.
    """

    level: FilterSupportLevel
    # The canonical value the site is sent instead, named to the candidate.
    substitute: str | None = None


@dataclass(frozen=True)
class FilterSupport:
    level: FilterSupportLevel
    reason: str
    # Keyed by canonical value; empty on most pairs.
    derogations: Mapping[str, Derogation] = field(default_factory=dict)
    # For a `location` the site only takes as a resolved code: the level a
    # value `py_db.locations` cannot resolve falls to, for that one search.
    # None where the site takes the text as typed.
    when_unresolved: FilterSupportLevel | None = None


SEARCH_FILTER_KEYS = (
    "keywords",
    "location",
    "postedWithin",
    "contractType",
    "remote",
    "experienceLevel",
)

# `contractType`'s canonical values: French contract codes, validated on
# write and stored as a list (#214). Each Site adapter translates them into
# its own codes.
CONTRACT_TYPE_VALUES = ("CDI", "CDD", "INTERIM", "STAGE", "ALTERNANCE", "FREELANCE")

_S = FilterSupportLevel.SUPPORTED
_A = FilterSupportLevel.APPROXIMATED
_U = FilterSupportLevel.UNSUPPORTED

_EXPERIENCE_LEVEL_NOWHERE = (
    "No site in scope is sent an experience level, so the field is hidden "
    "from the form; its key stays so restoring it needs no migration."
)

_WTTJ_STALE = (
    "WTTJ's search is stale: every search renders its jobs landing page and "
    "discovers no offer, so no filter reaches a result (see its SiteConfig "
    "notes)."
)

FILTER_SUPPORT: dict[Siteconfigsitekey, dict[str, FilterSupport]] = {
    Siteconfigsitekey.FRANCE_TRAVAIL: {
        "keywords": FilterSupport(_S, "Sent as `motsCles`."),
        "location": FilterSupport(
            _S,
            "Resolved against py_db.locations and sent as an INSEE `region` "
            "or `departement` code; the API rejects a label with a 400. A "
            "value that resolves to nothing is not sent, so the search runs "
            "wider instead of failing (#215).",
            when_unresolved=_U,
        ),
        "postedWithin": FilterSupport(
            _S,
            "Sent as an absolute `minCreationDate`/`maxCreationDate` window; "
            "honoured by `make verify-sites`.",
        ),
        "contractType": FilterSupport(
            _S,
            "Sent as the API's own codes, comma-separated: CDI, CDD, INTERIM "
            "-> `MIS` and FREELANCE -> `LIB` in `typeContrat`, ALTERNANCE -> "
            "`E2,FS` (apprenticeship, professionalisation) in `natureContrat`, "
            "which the API ORs with it; honoured by `make verify-sites`. The "
            "API has no internship contract, so a selection holding STAGE is "
            "not sent at all and the search runs wider (#214).",
            derogations={"STAGE": Derogation(_U)},
        ),
        "remote": FilterSupport(
            _U,
            "The Offres d'emploi v2 API has no telework criterion. The "
            "`travailATemps` it used to be sent is not a parameter and was "
            "silently ignored.",
        ),
        "experienceLevel": FilterSupport(
            _U,
            "The API has an experience parameter, deliberately left unmapped. "
            + _EXPERIENCE_LEVEL_NOWHERE,
        ),
    },
    Siteconfigsitekey.HELLOWORK: {
        "keywords": FilterSupport(_S, "Sent as `k`."),
        "location": FilterSupport(
            _S,
            "Resolved against py_db.locations and sent as the table's label "
            "`l` plus the companion region URL `l_autocomplete` "
            "(`…/localite/region/11`, `…/localite/departement/69`) that "
            "HelloWork's own form submits; honoured by `make verify-sites`. "
            "HelloWork matches an unknown label as text and narrows to a "
            "handful of offers, so a value that resolves to nothing is not "
            "sent and the search runs wider instead (#216).",
            when_unresolved=_U,
        ),
        "postedWithin": FilterSupport(
            _S,
            "Sent as freshness `d`: 24h -> `h`, 7d -> `w`, 30d -> `m`; "
            "honoured by `make verify-sites`, except `m`, which covers nearly "
            "the whole listing so its count barely moves. HelloWork has no "
            "14-day value, so 14d widens to a month.",
            derogations={"14d": Derogation(_A, substitute="30d")},
        ),
        "contractType": FilterSupport(
            _S,
            "Sent as `c`, repeated per value: INTERIM -> `Travail_temp`, "
            "STAGE -> `Stage`, ALTERNANCE -> `Alternance`, FREELANCE -> "
            "`Freelance` and `Independant`, CDI and CDD as themselves; "
            "honoured by `make verify-sites` (#214).",
        ),
        "remote": FilterSupport(
            _S,
            "Sent as telework `t`, repeatable: onsite -> `Pas_teletravail`, "
            "hybrid -> `Partiel` and `Occasionnel`, remote -> `Complet`; "
            "honoured by `make verify-sites`.",
        ),
        "experienceLevel": FilterSupport(_U, _EXPERIENCE_LEVEL_NOWHERE),
    },
    Siteconfigsitekey.LINKEDIN: {
        "keywords": FilterSupport(_S, "Sent as `keywords`."),
        "location": FilterSupport(
            _S, "Sent as `location`; honoured by `make verify-sites`."
        ),
        "postedWithin": FilterSupport(
            _S,
            "Sent as freshness `f_TPR`, a seconds count behind `r` (7d -> "
            "`r604800`); honoured for all four windows by `make verify-sites`. "
            "It ignored the canonical token it used to be sent.",
        ),
        "contractType": FilterSupport(
            _U,
            "Not sent: `f_JT` showed no effect on the guest search page the "
            "pipeline scrapes, in `make verify-sites` and in a hand check "
            "(django/Lyon, 171 offers, the same ones for F, C, T, I and F,C) "
            "(#214). Even where honoured it classifies by working time and "
            "engagement, not contract duration, so it could never tell a CDI "
            "from a CDD: a part-time CDI exists.",
        ),
        "remote": FilterSupport(
            _U,
            "Not sent: `f_WT` showed no effect on the guest search page the "
            "pipeline scrapes, in any of its values 1/2/3, on two runs of "
            "`make verify-sites` and on an uncapped hand check (#212). Its "
            "filter bar exposes no workplace type.",
        ),
        "experienceLevel": FilterSupport(_U, _EXPERIENCE_LEVEL_NOWHERE),
    },
    Siteconfigsitekey.WTTJ: {key: FilterSupport(_U, _WTTJ_STALE) for key in SEARCH_FILTER_KEYS},
    Siteconfigsitekey.ADZUNA: {
        "keywords": FilterSupport(_S, "Sent as `what`."),
        "location": FilterSupport(_S, "Sent as `where`, a free-text place."),
        "postedWithin": FilterSupport(
            _S, "Sent as `max_days_old`, and applied again to the offers returned."
        ),
        "contractType": FilterSupport(
            _A,
            "Adzuna has boolean contract facets, not a list: CDI becomes "
            "`permanent`, CDD, INTERIM and FREELANCE share one `contract` "
            "facet. A selection spanning both facets, or holding STAGE or "
            "ALTERNANCE, which have none, is not applied.",
        ),
        "remote": FilterSupport(
            _A,
            "Adzuna has no telework facet: `remote` is added to the search "
            "terms, which shifts relevance without excluding anything; onsite "
            "and hybrid are not applied.",
        ),
        "experienceLevel": FilterSupport(_U, _EXPERIENCE_LEVEL_NOWHERE),
    },
    Siteconfigsitekey.REMOTIVE: {
        "keywords": FilterSupport(_S, "Sent as `search`."),
        "location": FilterSupport(
            _U, "Remotive has no location parameter: every listing is remote."
        ),
        "postedWithin": FilterSupport(
            _S,
            "Remotive has no date parameter; the window is applied to the "
            "offers it returns.",
        ),
        "contractType": FilterSupport(_U, "Remotive has no contract parameter."),
        "remote": FilterSupport(
            _U,
            "Remotive has no telework parameter: every offer is fully remote, "
            "whatever was asked.",
        ),
        "experienceLevel": FilterSupport(_U, _EXPERIENCE_LEVEL_NOWHERE),
    },
}


def filter_support_for(site_key: Siteconfigsitekey) -> dict[str, FilterSupport]:
    """A site's declarations, keyed by Search filter key. Empty for a site
    with none (the disabled ones, which no candidate can pick)."""
    return FILTER_SUPPORT.get(site_key, {})
