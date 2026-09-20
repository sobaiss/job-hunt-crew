import json

from analysis.comparison_analysis_agent import ComparisonResult
from analysis.llm_provider import LLMProvider
from analysis.recommendation_writer_agent import (
    RecommendationWriterError,
    run_recommendation_writer,
)

COMPARISON_RESULT = ComparisonResult(
    match_score=82,
    matched_skills=[{"skill": "Python", "evidence": "5+ years Python experience"}],
    missing_skills=[{"skill": "Kubernetes", "importance": "nice_to_have"}],
    strengths=["Strong Python background"],
    weaknesses=["No Kubernetes experience"],
)
VALID_RECOMMENDATION_OUTPUT = json.dumps(
    {
        "improvement_suggestions": [
            {
                "area": "Kubernetes",
                "suggestion": "Get hands-on Kubernetes experience.",
                "priority": "medium",
            }
        ],
        "summary": "Strong match on core skills; consider closing the Kubernetes gap.",
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


def test_run_recommendation_writer_returns_the_parsed_result():
    provider = StubLLMProvider([VALID_RECOMMENDATION_OUTPUT])

    result = run_recommendation_writer(COMPARISON_RESULT, llm_provider=provider)

    assert result.summary
    assert result.improvement_suggestions[0].area == "Kubernetes"
    assert provider.calls == 1


def test_run_recommendation_writer_system_prompt_instructs_matching_comparison_language():
    # Regression: RecommendationWriterAgent had no language instruction, so it
    # kept answering in English even once ComparisonAnalysisAgent's own output
    # — this agent's only input, since it never sees the raw CV/offer — was
    # fixed to follow the CV/offer's language. Mirrors the fix already proven
    # for CoverLetterWriterAgent/CvTailoringAgent.
    provider = StubLLMProvider([VALID_RECOMMENDATION_OUTPUT])

    run_recommendation_writer(COMPARISON_RESULT, llm_provider=provider)

    system = provider.last_system
    assert "same language as that comparison JSON" in system


def test_run_recommendation_writer_raises_after_max_attempts_of_malformed_output():
    provider = StubLLMProvider(["not valid json", "not valid json", "not valid json"])

    try:
        run_recommendation_writer(COMPARISON_RESULT, llm_provider=provider)
        raise AssertionError("expected RecommendationWriterError")
    except RecommendationWriterError:
        pass

    assert provider.calls == 3
