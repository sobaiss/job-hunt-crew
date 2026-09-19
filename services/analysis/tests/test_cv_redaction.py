"""The deterministic Redaction safety net (issue #166, docs/adr/0022).

Pure text checks, no LLM and no DB: given a candidate Markdown rendition and
the CVVersion owner's account name/email, report which identity categories are
still present. Tests assert on the observable verdict (which categories were
found), never on the regexes themselves.
"""

import pytest

from analysis.cv_redaction import find_identity_leaks

CLEAN_CV = (
    "## Experience\n\n"
    "- **Senior Backend Engineer**, Acme Corp, Lyon, France (2019–2024)\n"
    "- Backend Engineer, Globex (Jan 2016 – Dec 2018)\n\n"
    "## Skills\n\n- Python\n- AWS\n- PostgreSQL\n\n"
    "## Links\n\n- https://linkedin.com/in/janedoe\n- https://github.com/janedoe\n"
)


def test_a_clean_redacted_cv_has_no_leaks():
    assert find_identity_leaks(CLEAN_CV, user_name="Jane Doe", user_email=None) == []


@pytest.mark.parametrize(
    "text",
    [
        "Contact: someone@example.com",
        "reach me at first.last+cv@sub.example.co.uk today",
    ],
)
def test_an_email_shaped_substring_is_a_leak(text):
    assert find_identity_leaks(text, user_name=None, user_email=None) == ["email"]


@pytest.mark.parametrize(
    "text",
    [
        "Tel: 06 12 34 56 78",
        "Phone +33 6 12 34 56 78",
        "Mobile: (415) 555-2671",
        "0612345678",
        "+1.415.555.2671",
    ],
)
def test_a_phone_shaped_substring_is_a_leak(text):
    assert find_identity_leaks(text, user_name=None, user_email=None) == ["phone"]


@pytest.mark.parametrize(
    "text",
    [
        "Acme Corp (2019-2024)",
        "Acme Corp 2019 – 2024",
        "Earned certifications in 2015 2018 2021",
        "Salary band 45 000 – 55 000 EUR",
        "Managed a team of 12 across 3 sites, 99.9% uptime",
    ],
)
def test_dates_and_ordinary_numbers_are_not_phone_numbers(text):
    assert find_identity_leaks(text, user_name=None, user_email=None) == []


def test_the_accounts_own_name_is_a_leak_case_insensitively():
    leaks = find_identity_leaks(
        "# JANE   doe\n\n## Skills", user_name="Jane Doe", user_email=None
    )
    assert leaks == ["account name"]


def test_the_accounts_name_only_matches_whole_words():
    assert (
        find_identity_leaks(
            "Built a Janet-Doerr style parser", user_name="Jane Doe", user_email=None
        )
        == []
    )
    assert (
        find_identity_leaks(
            "Tuned a scheduling algorithm", user_name="Al", user_email=None
        )
        == []
    )


def test_the_accounts_own_email_is_reported_distinctly():
    leaks = find_identity_leaks(
        "Reach Jane.Doe@Example.com", user_name=None, user_email="jane.doe@example.com"
    )
    assert leaks == ["account email", "email"]


def test_a_missing_or_blank_account_name_is_never_a_leak():
    assert find_identity_leaks(CLEAN_CV, user_name=None, user_email=None) == []
    assert find_identity_leaks(CLEAN_CV, user_name="  ", user_email="") == []
    assert find_identity_leaks(CLEAN_CV, user_name="\n", user_email="  ") == []


def test_several_categories_are_all_reported():
    text = "Jane Doe — jane@example.com — 06 12 34 56 78"
    assert find_identity_leaks(text, user_name="Jane Doe", user_email=None) == [
        "account name",
        "email",
        "phone",
    ]
