from analysis import cover_letter_writer_agent
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
        response = self._responses[min(self.calls, len(self._responses)) - 1]
        if isinstance(response, Exception):
            raise response
        return response


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


def test_run_cover_letter_writer_defaults_to_matching_cv_offer_language_not_english():
    # Regression: this used to default to "en", which instructed the model to
    # answer in English regardless of the CV/offer's actual language. Against
    # an all-French CV/offer that mismatch made the local dev model degenerate
    # into dumping the raw CV instead of writing a letter (analysis
    # 8132ec06-6d99-4624-8d0e-60904dfa4a19).
    provider = StubLLMProvider(["Dear Hiring Manager, ...\n\nSincerely, Jane"])

    run_cover_letter_writer(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    system = provider.last_system
    assert "Write the letter in en" not in system
    assert "same language as the CV and job offer" in system


def test_run_cover_letter_writer_system_prompt_names_supported_markdown_constructs():
    provider = StubLLMProvider(["Dear Hiring Manager, ...\n\nSincerely, Jane"])

    run_cover_letter_writer(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    system = provider.last_system
    assert "###" in system
    assert "**bold**" in system
    assert "*italic*" in system
    assert "---" in system
    assert "-" in system or "*" in system
    lowered = system.lower()
    for unsupported in ("table", "numbered list", "link", "blockquote"):
        assert unsupported in lowered


def test_run_cover_letter_writer_system_prompt_includes_length_and_style_rules():
    # These apply regardless of language: the prompt previously had no length
    # cap at all (falling back to DEFAULT_MAX_TOKENS=4096) and explicitly
    # permitted bullet lists, producing letters that ran too long and used
    # bullet-point formatting real cover letters shouldn't.
    provider = StubLLMProvider(["Dear Hiring Manager, ...\n\nSincerely, Jane"])

    run_cover_letter_writer(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        language="en",
        llm_provider=provider,
    )

    system = provider.last_system
    assert "2000 characters" in system
    assert "bullet-point lists" in system
    assert "naming former employers" in system
    assert "grammar and spelling" in system


def test_run_cover_letter_writer_system_prompt_gates_french_structure_by_language():
    # The French "Vous/Moi/Nous" structure and Objet/date header are a French
    # business-letter convention, not a universal one. There's no reliable
    # structured language signal in JobOffer/User today (see
    # generation_pipeline._offer_language), so this instruction is always
    # present and left to the model to apply based on the language it ends up
    # writing in, rather than gated in Python on the `language` argument.
    provider = StubLLMProvider(["Dear Hiring Manager, ...\n\nSincerely, Jane"])

    run_cover_letter_writer(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    system = provider.last_system
    assert "Vous / Moi / Nous" in system
    assert "Objet : Candidature au poste de" in system
    assert "applies only in French" in system


def test_run_cover_letter_writer_system_prompt_forbids_vous_moi_nous_as_literal_headings():
    # Regression: a generated letter printed "Vous", "Moi", and "Nous" as
    # literal bold section headings instead of using that structure as
    # invisible guidance (analysis cover-letter-9b4f58d7-05e8-4675-bc1d-
    # a08d566e8cec.pdf).
    provider = StubLLMProvider(["Dear Hiring Manager, ...\n\nSincerely, Jane"])

    run_cover_letter_writer(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    system = provider.last_system
    assert "Do NOT print" in system
    assert "as section headings or labels" in system


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


def test_run_cover_letter_writer_retries_on_provider_error_then_succeeds(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(cover_letter_writer_agent, "_sleep", sleeps.append)
    provider = StubLLMProvider([ConnectionError("boom"), "Dear Hiring Manager, ..."])

    result = run_cover_letter_writer(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    assert result == "Dear Hiring Manager, ..."
    assert provider.calls == 2
    assert sleeps == [2]


def test_run_cover_letter_writer_backs_off_between_provider_error_retries(monkeypatch):
    sleeps: list[float] = []
    monkeypatch.setattr(cover_letter_writer_agent, "_sleep", sleeps.append)
    provider = StubLLMProvider(
        [ConnectionError("boom"), ConnectionError("boom"), "Dear Hiring Manager, ..."]
    )

    run_cover_letter_writer(
        cv_markdown=CV_MARKDOWN,
        job_offer_structured_data=JOB_OFFER_STRUCTURED_DATA,
        matched_skills=MATCHED_SKILLS,
        missing_skills=MISSING_SKILLS,
        llm_provider=provider,
    )

    assert sleeps == [2, 4]


def test_run_cover_letter_writer_raises_after_max_attempts_of_provider_errors(
    monkeypatch,
):
    monkeypatch.setattr(cover_letter_writer_agent, "_sleep", lambda seconds: None)
    provider = StubLLMProvider(
        [ConnectionError("boom"), ConnectionError("boom"), ConnectionError("boom")]
    )

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
