"""CVTailoringAgent (issue #58, Scout slice 6).

Produces an offer-tailored copy of a candidate's CV as Markdown — reordered
and re-emphasised toward the target job offer — without ever mutating the
base CVVersion (ADR 0003, a future slice). Mirrors
cover_letter_writer_agent's design: prose Markdown output, so MAX_ATTEMPTS
only guards an empty/whitespace response.

Truthfulness constraint: the agent may reorder, re-emphasise, and re-word
only content the base CV already contains, and must never invent employers,
dates, titles, or credentials.
"""

import json

from .llm_provider import LLMProvider, get_llm_provider

MAX_ATTEMPTS = 3

SYSTEM_PROMPT = (
    "You produce an offer-tailored copy of a candidate's CV. You are given the "
    "candidate's base CV as Markdown (their full CV/resume), the job offer as "
    "structured JSON, and this CV's matched/missing skills against this offer. "
    "Reorder sections, re-emphasise relevant experience, and re-word bullet "
    "points to speak to this offer — but the tailored CV must contain ONLY "
    "employers, dates, titles, credentials, and experience that already appear "
    "in the base CV Markdown. Never invent or embellish anything absent from "
    "it. Lean on the matched skills to surface relevant experience that was "
    "buried. Write the tailored CV in {language}. "
    "Respond with ONLY the tailored CV as Markdown prose — no JSON, no "
    "commentary, no markdown code fences."
)


class CvTailoringError(Exception):
    pass


def run_cv_tailoring(
    *,
    cv_markdown: str,
    job_offer_structured_data: dict,
    matched_skills: list,
    missing_skills: list,
    language: str = "en",
    llm_provider: LLMProvider | None = None,
) -> str:
    """Runs the CVTailoringAgent, retrying up to MAX_ATTEMPTS on an
    empty/whitespace response. Raises CvTailoringError if every attempt
    fails.
    """
    provider = llm_provider or get_llm_provider()
    system = SYSTEM_PROMPT.format(language=language)
    prompt = json.dumps(
        {
            "cv_markdown": cv_markdown,
            "job_offer": job_offer_structured_data,
            "matched_skills": matched_skills,
            "missing_skills": missing_skills,
        }
    )

    last_error: Exception | None = None
    for _attempt in range(1, MAX_ATTEMPTS + 1):
        raw = provider.generate(system=system, prompt=prompt)
        text = (raw or "").strip()
        if text:
            return text
        last_error = ValueError("empty response")

    raise CvTailoringError(f"CVTailoringAgent failed after {MAX_ATTEMPTS} attempts: {last_error}")
