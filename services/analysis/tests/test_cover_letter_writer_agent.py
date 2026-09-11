from analysis.cover_letter_writer_agent import (
    CoverLetterWriterError,
    run_cover_letter_writer,
)
from analysis.llm_provider import LLMProvider

CV_MARKDOWN = (
    "# Jane Doe\n\n"
    "## Skills\n\n- Python\n- AWS\n- PostgreSQL\n\n"
    "## Experience\n\n"
    "### Backend Engineer — Acme Corp (2021-01 – present)\n\n"
    "Built backend services.\n"
)
JOB_OFFER_STRUCTURED_DATA = {
    "description": "Senior Backend Engineer role focused on Python services.",
    "requirements": ["5+ years Python", "AWS experience"],
}
MATCHED_SKILLS = [{"skill": "Python", "evidence": "5+ years Python experience"}]
MISSING_SKILLS = [{"skill": "Kubernetes", "importance": "nice_to_have"}]


class StubLLMProvider(LLMProvider):
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0
        self.model = "stub-model"
        self.last_system: str | None = None

    def generate(self, *, system: str, prompt: str, max_tokens: int | None = None) -> str:
        self.calls += 1
        self.last_system = system
        return self._responses[min(self.calls, len(self._responses)) - 1]


def test_run_cover_letter_writer_returns_the_provider_text():
    provider = StubLLMProvider(["Dear Hiring Manager, ...\n\nSincerely, Jane"])

    result = run_cover_letter_writer(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        language="en",
        llm_provider=provider,
    )

    assert result == "Dear Hiring Manager, ...\n\nSincerely, Jane"
    assert provider.calls == 1
    assert "en" in provider.last_system


def test_run_cover_letter_writer_retries_on_empty_response_then_succeeds():
    provider = StubLLMProvider(["", "   ", "Dear Hiring Manager, ..."])

    result = run_cover_letter_writer(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    assert result == "Dear Hiring Manager, ..."
    assert provider.calls == 3


def test_run_cover_letter_writer_raises_after_max_attempts_of_empty_responses():
    provider = StubLLMProvider(["", "", ""])

    try:
        run_cover_letter_writer(
            cv_markdown=CV_MARKDOWN,
            job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
            matched_skills=MATCHED_SKILLS,
            missing_skills=MISSING_SKILLS,
            llm_provider=provider,
        )
        raise AssertionError("expected CoverLetterWriterError")
    except CoverLetterWriterError:
        pass

    assert provider.calls == 3
