"""Finds and reads a schema.org JobPosting block embedded as JSON-LD.

Most job boards emit this (`<script type="application/ld+json">`) for
Google for Jobs visibility, so it's a free, deterministic source for
title/company/location/postedAt ahead of the LLM fallback in
job_offer_extraction_agent — see docs/adr/0010.
"""

import json
import re
from datetime import datetime

_SCRIPT_RE = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)


def _is_job_posting(node: object) -> bool:
    if not isinstance(node, dict):
        return False
    node_type = node.get("@type")
    if isinstance(node_type, list):
        return "JobPosting" in node_type
    return node_type == "JobPosting"


def _iter_candidates(parsed: object):
    if isinstance(parsed, list):
        for item in parsed:
            yield from _iter_candidates(item)
    elif isinstance(parsed, dict):
        yield parsed
        graph = parsed.get("@graph")
        if isinstance(graph, list):
            yield from _iter_candidates(graph)


def find_job_posting(html: str) -> dict | None:
    """Returns the first schema.org JobPosting JSON-LD block in `html`, if any."""
    for match in _SCRIPT_RE.finditer(html):
        try:
            parsed = json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            continue
        for candidate in _iter_candidates(parsed):
            if _is_job_posting(candidate):
                return candidate
    return None


def _parse_date(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def _location_from(job_location: object) -> str | None:
    if isinstance(job_location, list):
        job_location = job_location[0] if job_location else None
    if not isinstance(job_location, dict):
        return None
    address = job_location.get("address")
    if isinstance(address, str):
        return address or None
    if not isinstance(address, dict):
        return None
    parts = [
        address.get("streetAddress"),
        address.get("postalCode"),
        address.get("addressLocality"),
        address.get("addressRegion"),
        address.get("addressCountry"),
    ]
    joined = ", ".join(part for part in parts if part)
    return joined or None


def _company_from(hiring_organization: object) -> str | None:
    if isinstance(hiring_organization, str):
        return hiring_organization or None
    if isinstance(hiring_organization, dict):
        name = hiring_organization.get("name")
        return name or None
    return None


def job_posting_fields(job_posting: dict) -> dict:
    """Maps a JobPosting JSON-LD block to JobOffer's title/company/location/postedAt."""
    return {
        "title": job_posting.get("title") or None,
        "company": _company_from(job_posting.get("hiringOrganization")),
        "location": _location_from(job_posting.get("jobLocation")),
        "postedAt": _parse_date(job_posting.get("datePosted")),
    }
