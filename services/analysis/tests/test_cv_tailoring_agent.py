from analysis import cv_tailoring_agent
from analysis.cv_tailoring_agent import CvTailoringError, run_cv_tailoring
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
        response = self._responses[min(self.calls, len(self._responses)) - 1]
        if isinstance(response, Exception):
            raise response
        return response


def test_run_cv_tailoring_returns_the_provider_text():
    provider = StubLLMProvider(["# Jane Doe\n\n## Skills\n\n- Python\n"])

    result = run_cv_tailoring(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        language="fr",
        llm_provider=provider,
    )

    assert result == "# Jane Doe\n\n## Skills\n\n- Python"
    assert provider.calls == 1
    assert "fr" in provider.last_system


def test_run_cv_tailoring_retries_on_empty_response_then_succeeds():
    provider = StubLLMProvider(["", "# Jane Doe tailored"])

    result = run_cv_tailoring(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    assert result == "# Jane Doe tailored"
    assert provider.calls == 2


def test_run_cv_tailoring_raises_after_max_attempts_of_empty_responses():
    provider = StubLLMProvider(["", "", ""])

    try:
        run_cv_tailoring(
            cv_markdown=CV_MARKDOWN,
            job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
            matched_skills=MATCHED_SKILLS,
            missing_skills=MISSING_SKILLS,
            llm_provider=provider,
        )
        raise AssertionError("expected CvTailoringError")
    except CvTailoringError:
        pass

    assert provider.calls == 3


def test_run_cv_tailoring_retries_on_provider_error_then_succeeds(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(cv_tailoring_agent, "_sleep", sleeps.append)
    provider = StubLLMProvider([ConnectionError("boom"), "# Jane Doe tailored"])

    result = run_cv_tailoring(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    assert result == "# Jane Doe tailored"
    assert provider.calls == 2
    assert sleeps == [2]


def test_run_cv_tailoring_backs_off_between_provider_error_retries(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(cv_tailoring_agent, "_sleep", sleeps.append)
    provider = StubLLMProvider(
        [ConnectionError("boom"), ConnectionError("boom"), "# Jane Doe tailored"]
    )

    run_cv_tailoring(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    assert sleeps == [2, 4]


def test_run_cv_tailoring_raises_after_max_attempts_of_provider_errors(monkeypatch):
    monkeypatch.setattr(cv_tailoring_agent, "_sleep", lambda seconds: None)
    provider = StubLLMProvider(
        [ConnectionError("boom"), ConnectionError("boom"), ConnectionError("boom")]
    )

    try:
        run_cv_tailoring(
            cv_markdown=CV_MARKDOWN,
            job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
            matched_skills=MATCHED_SKILLS,
            missing_skills=MISSING_SKILLS,
            llm_provider=provider,
        )
        raise AssertionError("expected CvTailoringError")
    except CvTailoringError:
        pass

    assert provider.calls == 3
