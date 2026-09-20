import json

from analysis.comparison_analysis_agent import (
    ComparisonAnalysisError,
    run_comparison_analysis,
)
from analysis.llm_provider import LLMProvider

JOB_OFFER_STRUCTURED_DATA = {
    "description": "Senior Backend Engineer role focused on Python services.",
    "requirements": ["5+ years Python", "AWS experience"],
}
CV_MARKDOWN = (
    "# Jane Doe\n\n"
    "## Skills\n\n- Python\n- AWS\n- PostgreSQL\n\n"
    "## Experience\n\n"
    "### Backend Engineer — Acme Corp (2021-01 – present)\n\n"
    "Built backend services.\n"
)
VALID_COMPARISON_OUTPUT = json.dumps(
    {
        "match_score": 82,
        "matched_skills": [
            {"skill": "Python", "evidence": "5+ years Python experience"}
        ],
        "missing_skills": [{"skill": "Kubernetes", "importance": "nice_to_have"}],
        "strengths": ["Strong Python background"],
        "weaknesses": ["No Kubernetes experience"],
    }
)


class StubLLMProvider(LLMProvider):
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0
        self.model = "stub-model"
        self.last_system: str | None = None

    def generate(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int | None = None,
        response_schema=None,
        temperature: float | None = None,
    ) -> str:
        self.calls += 1
        self.last_system = system
        return self._responses[min(self.calls, len(self._responses)) - 1]


def test_run_comparison_analysis_returns_the_parsed_result():
    provider = StubLLMProvider([VALID_COMPARISON_OUTPUT])

    result = run_comparison_analysis(
        JOB_OFFER_STRUCTURED_DATA, CV_MARKDOWN, llm_provider=provider
    )

    assert result.match_score == 82
    assert result.strengths == ["Strong Python background"]
    assert provider.calls == 1


def test_run_comparison_analysis_system_prompt_instructs_matching_cv_offer_language():
    # Regression: ComparisonAnalysisAgent had no language instruction at all,
    # so it defaulted to English for strengths/weaknesses/evidence even when
    # the CV and job offer were both in another language (e.g. French) —
    # visible as English analysis content under correct French next-intl UI
    # chrome. Mirrors the fix already proven for CoverLetterWriterAgent/
    # CvTailoringAgent.
    provider = StubLLMProvider([VALID_COMPARISON_OUTPUT])

    run_comparison_analysis(JOB_OFFER_STRUCTURED_DATA, CV_MARKDOWN, llm_provider=provider)

    system = provider.last_system
    assert "same language as the CV and job offer" in system


def test_run_comparison_analysis_raises_after_max_attempts_of_malformed_output():
    provider = StubLLMProvider(["not valid json", "not valid json", "not valid json"])

    try:
        run_comparison_analysis(
            JOB_OFFER_STRUCTURED_DATA, CV_MARKDOWN, llm_provider=provider
        )
        raise AssertionError("expected ComparisonAnalysisError")
    except ComparisonAnalysisError:
        pass

    assert provider.calls == 3
