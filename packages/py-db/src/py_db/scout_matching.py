"""Cost-bounded Scout matching (issue #55): the per-run analysis ceiling and
the no-LLM lexical pre-rank that decides which discovered offers spend it.

`create_analyses_for_ready_offers` (`services/ingestion`) is the sole caller
today; the pure/query pieces live here — rather than in either
`services/ingestion` or `services/scout` — so neither context needs to depend
on the other to share this rule (the same shape as `quota.py`'s
`DAILY_ANALYSIS_CAP`). Hand-written, not sqlacodegen output.
"""

import os
import re

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Analysis, IngestionJob

DEFAULT_SCOUT_MAX_ANALYSES_PER_RUN = 20

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def scout_max_analyses_per_run() -> int:
    """`SCOUT_MAX_ANALYSES_PER_RUN` from the environment, or
    `DEFAULT_SCOUT_MAX_ANALYSES_PER_RUN` when it is unset, non-numeric, or not
    a positive integer.
    """
    raw = os.environ.get("SCOUT_MAX_ANALYSES_PER_RUN")
    try:
        parsed = int(raw) if raw else None
    except ValueError:
        parsed = None
    return parsed if parsed is not None and parsed > 0 else DEFAULT_SCOUT_MAX_ANALYSES_PER_RUN


async def analyses_created_for_scout_run(session: AsyncSession, scout_run_id: str) -> int:
    """How many `Analysis` rows already exist for `scout_run_id`, across every
    `IngestionJob` (one per targeted site) the run has fanned out to so far —
    the running total the per-run ceiling is measured against.
    """
    count = await session.scalar(
        select(func.count())
        .select_from(Analysis)
        .join(IngestionJob, Analysis.ingestionJobId == IngestionJob.id)
        .where(IngestionJob.scoutRunId == scout_run_id)
    )
    return count or 0


def _tokens(text: str) -> set[str]:
    return set(_TOKEN_RE.findall(text.lower()))


def lexical_similarity(a: str, b: str) -> float:
    """No-LLM Jaccard token-overlap between two texts, in `[0.0, 1.0]`. Used to
    pre-rank a Scout run's discovered offers against the base CV's Markdown
    rendition, so the per-run analysis ceiling is spent on the most promising
    offers first (PRD "cost-bounded matching"). Either text being empty scores
    0.0 rather than dividing by zero.
    """
    tokens_a, tokens_b = _tokens(a or ""), _tokens(b or "")
    if not tokens_a or not tokens_b:
        return 0.0
    return len(tokens_a & tokens_b) / len(tokens_a | tokens_b)
