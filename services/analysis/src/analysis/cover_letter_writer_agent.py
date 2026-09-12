"""CoverLetterWriterAgent (issue #58, Scout slice 6).

Writes a personalised cover letter for one (JobOffer, CVVersion) pair, built
on top of the LLM provider abstraction, mirroring comparison_analysis_agent's
design. Unlike the comparison/recommendation agents the output is prose
Markdown, not JSON, so MAX_ATTEMPTS only guards an empty/whitespace response —
there is no schema to validate.

Unlike those other agents, a raw provider exception here is also retried with
exponential backoff (base RETRY_BASE_SECONDS, rate RETRY_BACKOFF_RATE) instead
of propagating immediately — mirroring the Retry block AnalysisWorkflow's ASL
definition puts around each of its steps (3x, base 2s, backoff 2.0), since
GenerationWorkflow has no Step Functions state machine of its own yet (issue
#58's deferred item; local dev runs this in-process, see generation_pipeline).

Truthfulness constraint (ADR 0003, a future slice): the prompt instructs the
agent to reorder, re-emphasise, and re-word only what the base CV already
contains, and never invent employers, dates, titles, or credentials.
"""

import json
import time

from .llm_provider import LLMProvider, get_llm_provider

MAX_ATTEMPTS = 3
RETRY_BASE_SECONDS = 2
RETRY_BACKOFF_RATE = 2.0


def _sleep(seconds: float) -> None:
    time.sleep(seconds)

SYSTEM_PROMPT = (
    "You write a personalised cover letter for a candidate applying to a job offer. "
    "You are given the candidate's CV as Markdown (their full CV/resume), the job "
    "offer as structured JSON, and this CV's matched/missing skills against this "
    "offer. Use ONLY experience, employers, dates, titles, and credentials that "
    "already appear in the CV Markdown — you may reorder, re-emphasise, and "
    "re-word freely, but never invent or embellish anything the CV does not "
    "contain. Lean on the matched skills to surface relevant experience that "
    "answers the offer. Write the letter in {language}. "
    "Respond with ONLY the cover letter body as Markdown prose — no JSON, no "
    "commentary, no markdown code fences."
)


class CoverLetterWriterError(Exception):
    pass


def run_cover_letter_writer(
    *,
    cv_markdown: str,
    job_offer_structured_data: dict,
    matched_skills: list,
    missing_skills: list,
    language: str = "en",
    llm_provider: LLMProvider | None = None,
) -> str:
    """Runs the CoverLetterWriterAgent, retrying up to MAX_ATTEMPTS on an
    empty/whitespace response. Raises CoverLetterWriterError if every attempt
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
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            raw = provider.generate(system=system, prompt=prompt)
        except Exception as exc:  # noqa: BLE001 - any provider error is retried with backoff
            last_error = exc
            if attempt < MAX_ATTEMPTS:
                _sleep(RETRY_BASE_SECONDS * (RETRY_BACKOFF_RATE ** (attempt - 1)))
            continue
        text = (raw or "").strip()
        if text:
            return text
        last_error = ValueError("empty response")

    raise CoverLetterWriterError(
        f"CoverLetterWriterAgent failed after {MAX_ATTEMPTS} attempts: {last_error}"
    )
