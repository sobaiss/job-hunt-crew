"""CV Redaction — strip candidate identity data from a Markdown rendition
(issue #166, docs/adr/0022-cv-redaction-strips-candidate-pii-...).

Redaction is part of Conversion. Two halves live here so every upload format
shares them:

- `REDACTION_INSTRUCTIONS`: the category list handed to the LLM, either folded
  into the PDF/DOCX normalisation prompt or (issue #167) used by the MD/TXT
  minimal-diff pass.
- `find_identity_leaks`: the deterministic, non-LLM safety net run on the LLM's
  output. An LLM's imperfect instruction-following must never let PII through
  undetected, so a hit fails Conversion rather than being patched in place.
"""

import re

REDACTION_INSTRUCTIONS = (
    "Remove the candidate's own identifying data: full name, email address, "
    "phone number, full postal/street address, date of birth or age, "
    "nationality, marital status and gender. Also remove the name, phone and "
    "email of any third-party reference. Omit each removed span cleanly — do "
    "not leave a placeholder such as [REDACTED] and do not leave an empty "
    "label or heading behind. Keep everything else unchanged: the city and "
    "country of residence or desired location, employer and school names, job "
    "titles, dates, skills, certifications, languages, project descriptions "
    "and every URL (LinkedIn, GitHub, portfolio, personal site)."
)

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")

# A digit-led run of digits, spaces, dots, dashes and parentheses (optionally
# behind a leading "+"). Whether it is really a phone number is decided in
# `_has_phone_number`, since plain date ranges ("2019-2024") match this shape.
_PHONE_CANDIDATE_RE = re.compile(r"(?<!\w)\+?\(?\d[\d\s().\-]{6,}\d(?!\w)")
_YEAR_RE = re.compile(r"(?:19|20)\d\d")
_MIN_PHONE_DIGITS = 9
_MAX_PHONE_DIGITS = 15


def _has_phone_number(text: str) -> bool:
    for match in _PHONE_CANDIDATE_RE.finditer(text):
        groups = re.findall(r"\d+", match.group())
        if not _MIN_PHONE_DIGITS <= sum(map(len, groups)) <= _MAX_PHONE_DIGITS:
            continue
        # "2015 2018 2021" is a run of years, not a phone number.
        if all(_YEAR_RE.fullmatch(group) for group in groups):
            continue
        return True
    return False


def _contains_name(text: str, name: str) -> bool:
    # Whole-word and whitespace-flexible: a name split across a line break
    # still counts, but "Al" must not match inside "algorithm".
    words = [re.escape(word) for word in name.split()]
    pattern = r"(?<!\w)" + r"\s+".join(words) + r"(?!\w)"
    return re.search(pattern, text, re.IGNORECASE) is not None


def find_identity_leaks(
    markdown: str, *, user_name: str | None, user_email: str | None
) -> list[str]:
    """Returns the identity categories still present in `markdown`, in a fixed
    order, or an empty list when it is clean. Categories are labels only — the
    matched text is never returned, so it can be safely persisted in a
    `conversionError` without re-leaking the PII."""
    leaks: list[str] = []
    if user_name and user_name.strip() and _contains_name(markdown, user_name):
        leaks.append("account name")
    email = (user_email or "").strip().lower()
    if email and email in markdown.lower():
        leaks.append("account email")
    if _EMAIL_RE.search(markdown):
        leaks.append("email")
    if _has_phone_number(markdown):
        leaks.append("phone")
    return leaks
