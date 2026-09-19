"""Finds and reads a schema.org JobPosting block embedded as JSON-LD.

Most job boards emit this (`<script type="application/ld+json">`) for
Google for Jobs visibility, so it's a free, deterministic source for
title/company/location/postedAt ahead of the LLM fallback in
job_offer_extraction_agent — see docs/adr/0010.
"""

import html as html_lib
import json
import re
from datetime import datetime

_SCRIPT_RE = re.compile(
    r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.IGNORECASE | re.DOTALL,
)

_TAG_RE = re.compile(r"<[^>]+>")


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


def _strip_html(value: object) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    text = html_lib.unescape(_TAG_RE.sub(" ", value))
    text = re.sub(r"\s+", " ", text).strip()
    return text or None


def _first(value: object) -> object:
    if isinstance(value, list):
        return value[0] if value else None
    return value


def _contract_type_from(employment_type: object) -> str | None:
    value = _first(employment_type)
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower().replace("-", "_")


def _remote_policy_from(job_location_type: object) -> str | None:
    value = _first(job_location_type)
    if isinstance(value, str) and value.strip().upper() == "TELECOMMUTE":
        return "remote"
    return None


def _salary_amount(value: object) -> str | None:
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, dict):
        min_value = value.get("minValue")
        max_value = value.get("maxValue")
        if min_value is not None and max_value is not None:
            return f"{min_value}-{max_value}"
        exact = value.get("value")
        if exact is not None:
            return str(exact)
    return None


def _salary_from(base_salary: object) -> str | None:
    if not isinstance(base_salary, dict):
        return None
    value = base_salary.get("value")
    amount = _salary_amount(value)
    if not amount:
        return None
    parts = [amount]
    currency = base_salary.get("currency")
    if currency:
        parts.append(str(currency))
    text = " ".join(parts)
    unit = value.get("unitText") if isinstance(value, dict) else None
    if isinstance(unit, str) and unit:
        text += f"/{unit.lower()}"
    return text


def _requirements_from(job_posting: dict) -> list[str]:
    skills = job_posting.get("skills")
    if isinstance(skills, list):
        return [item.strip() for item in skills if isinstance(item, str) and item.strip()]
    if isinstance(skills, str) and skills.strip():
        return [skills.strip()]
    return []


def structured_data_from_job_posting(job_posting: dict) -> dict | None:
    """Best-effort JobOffer.structuredData read straight from a JobPosting
    JSON-LD block (description/qualifications/skills/baseSalary/
    employmentType/jobLocationType), so `extract_job_offer` can skip its LLM
    tier entirely for the common case of a rich block -- see ADR 0010.

    Returns None when the block doesn't carry a usable `description` (schema.org
    doesn't require one), signalling the caller must still fall back to the LLM
    tier: `JobOfferStructuredData.description` is a required, non-empty field
    the comparison agent depends on, and no other JSON-LD property reliably
    substitutes for it.
    """
    description = _strip_html(job_posting.get("description"))
    if not description:
        return None
    qualifications = _strip_html(job_posting.get("qualifications"))
    if qualifications:
        description = f"{description}\n\n{qualifications}"
    return {
        "description": description,
        "requirements": _requirements_from(job_posting),
        "salary": _salary_from(job_posting.get("baseSalary")),
        "contractType": _contract_type_from(job_posting.get("employmentType")),
        "remotePolicy": _remote_policy_from(job_posting.get("jobLocationType")),
        "seniority": None,
    }
