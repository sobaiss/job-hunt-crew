"""ComparisonAnalysisAgent (PRD Section 10 step 6, M2-T6).

Compares a JobOffer's structuredData against a CVVersion's Markdown rendition
and produces the matched/missing skills, strengths, weaknesses, and
match_score portion of the Section 8.6 Analysis result schema. Built on top
of the LLM provider abstraction (analysis.llm_provider), mirroring
job_offer_extraction_agent's design (M2-T4).
"""

import json
from typing import Literal

from pydantic import BaseModel, ValidationError

from .llm_provider import LLMProvider, get_llm_provider

MAX_ATTEMPTS = 3

_RESPONSE_SHAPE = (
    "Respond with ONLY a single JSON object, no markdown fences, no commentary, "
    "matching this shape: "
    '{"match_score": integer 0-100, '
    '"matched_skills": [{"skill": string, "evidence": string}], '
    '"missing_skills": [{"skill": string, "importance": "required"|"nice_to_have"}], '
    '"strengths": [string], "weaknesses": [string]}.'
)

# The CV is the candidate's full CV/resume as Markdown prose (its Markdown
# rendition); the job offer is structured JSON.
SYSTEM_PROMPT = (
    "You compare a candidate's CV against a job offer. The CV is given as Markdown "
    "(the candidate's full CV/resume); the job offer is given as structured JSON. "
    + _RESPONSE_SHAPE
)


class MatchedSkill(BaseModel):
    skill: str
    evidence: str


class MissingSkill(BaseModel):
    skill: str
    importance: Literal["required", "nice_to_have"]


class ComparisonResult(BaseModel):
    match_score: int
    matched_skills: list[MatchedSkill]
    missing_skills: list[MissingSkill]
    strengths: list[str]
    weaknesses: list[str]


class ComparisonAnalysisError(Exception):
    pass


def _parse_llm_output(raw: str) -> ComparisonResult:
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[len("json") :]
    data = json.loads(text)
    return ComparisonResult.model_validate(data)


def run_comparison_analysis(
    job_offer_structured_data: dict,
    cv_markdown: str,
    *,
    llm_provider: LLMProvider | None = None,
) -> ComparisonResult:
    """Runs the ComparisonAnalysisAgent against the given job offer (structured
    JSON) and CV (its Markdown rendition), retrying up to MAX_ATTEMPTS on
    malformed LLM output (mirrors the extraction agent's bounded-retry design,
    M2-T4). Raises ComparisonAnalysisError if every attempt fails.
    """
    provider = llm_provider or get_llm_provider()
    system = SYSTEM_PROMPT
    prompt = json.dumps({"job_offer": job_offer_structured_data, "cv_markdown": cv_markdown})

    last_error: Exception | None = None
    for _attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            raw = provider.generate(system=system, prompt=prompt)
            return _parse_llm_output(raw)
        except (json.JSONDecodeError, ValidationError, TypeError) as exc:
            last_error = exc
            continue

    raise ComparisonAnalysisError(
        f"ComparisonAnalysisAgent failed after {MAX_ATTEMPTS} attempts: {last_error}"
    )
