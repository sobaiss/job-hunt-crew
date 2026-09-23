"""The shared "an API already gave us structured data" ingestion path.

France Travail proved the shape this pipeline actually wants: when a source
returns structured offers, there is nothing to scrape and nothing for an LLM
to extract — the offer goes straight to `extractionStatus=READY` with
`structuredData` filled in. That is both the cheapest path (no HTML fetch, no
extraction LLM call) and the only one no anti-bot system can interrupt.

`ingest_france_travail_offers` grew that loop inline. This module lifts the
site-agnostic half out of it — dedupe-and-cap, get-or-create the globally
deduplicated `JobOffer` by `sourceUrl`, link it to the job, roll the
aggregate up — so every API source in `api_sources.py` shares one
implementation instead of each re-deriving the same JobOffer lifecycle.

What stays per-source is only the mapping from that API's own JSON to
`NormalisedOffer`.
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from py_db.models import (
    IngestionJob,
    IngestionJobOffer,
    JobOffer,
    Jobofferextractionstatus,
    Joboffersourcesite,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .fanout import dedupe_and_cap_urls, update_ingestion_job_aggregate


def _now() -> datetime:
    # DB columns are TIMESTAMP WITHOUT TIME ZONE (Prisma's DateTime); asyncpg
    # rejects tz-aware values against them, so strip tzinfo after computing in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


@dataclass(frozen=True)
class NormalisedOffer:
    """One offer as any API source hands it over: the `JobOffer` columns the
    source can fill directly, plus the `structuredData` blob the Analysis
    context consumes. Deliberately the same field set France Travail's
    `_offer_job_offer_fields` already produced, so the two paths land
    identical rows."""

    source_url: str
    title: str | None = None
    company: str | None = None
    location: str | None = None
    posted_at: datetime | None = None
    structured_data: dict = field(default_factory=dict)

    def job_offer_fields(self) -> dict:
        return {
            "title": self.title,
            "company": self.company,
            "location": self.location,
            "postedAt": self.posted_at,
            "structuredData": self.structured_data,
        }


def parse_iso_datetime(raw: str | None) -> datetime | None:
    """A naive-UTC `datetime` from an ISO-8601 string, or `None`.

    Tolerant on purpose: these strings come from third-party APIs that vary
    between `Z`, `+00:00` and a bare local-looking timestamp, and a posting
    date is never worth failing an otherwise-good offer over.
    """
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(UTC).replace(tzinfo=None)
    return parsed


async def link_api_offers(
    session: AsyncSession,
    ingestion_job: IngestionJob,
    offers: list[NormalisedOffer],
    *,
    source_site: Joboffersourcesite,
) -> list[JobOffer]:
    """Dedupe-and-cap `offers`, create/reuse one `JobOffer` per retained URL
    at `READY`, link each to `ingestion_job`, and roll the job's aggregate
    counts up.

    Reuses an existing `JobOffer` untouched when one already exists for the
    URL (PRD Section 6's global dedup: "avoid re-scraping/re-extracting the
    same posting for every user") — including one an HTML_SCRAPE path created
    earlier, which is why this never downgrades a row it didn't create.
    """
    by_url: dict[str, NormalisedOffer] = {}
    for offer in offers:
        if offer.source_url:
            by_url.setdefault(offer.source_url, offer)
    retained_urls = dedupe_and_cap_urls(list(by_url.keys()), ingestion_job.maxOffers)

    job_offers: list[JobOffer] = []
    for url in retained_urls:
        job_offer = await session.scalar(
            select(JobOffer).where(JobOffer.sourceUrl == url)
        )
        if job_offer is None:
            job_offer = JobOffer(
                id=str(uuid.uuid4()),
                sourceUrl=url,
                sourceSite=source_site,
                extractionStatus=Jobofferextractionstatus.READY,
                updatedAt=_now(),
                **by_url[url].job_offer_fields(),
            )
            session.add(job_offer)
            await session.flush()
        job_offers.append(job_offer)

        existing_link = await session.scalar(
            select(IngestionJobOffer).where(
                IngestionJobOffer.ingestionJobId == ingestion_job.id,
                IngestionJobOffer.jobOfferId == job_offer.id,
            )
        )
        if existing_link is None:
            session.add(
                IngestionJobOffer(
                    id=str(uuid.uuid4()),
                    ingestionJobId=ingestion_job.id,
                    jobOfferId=job_offer.id,
                )
            )

    await session.commit()
    await update_ingestion_job_aggregate(session, ingestion_job.id)
    return job_offers
