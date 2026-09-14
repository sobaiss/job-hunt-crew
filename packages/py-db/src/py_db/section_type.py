"""The canonical SectionType vocabulary a StyleProfile's per-section style is
keyed by, and CvTailoringAgent (services/analysis) tags its generated
headings with (docs/adr/0008) — a StyleProfile records style per SectionType,
never by a section's literal heading text or position, so style still
applies when a heading is generated in a different language than the source
CV. Single source of truth for both the Analysis and API contexts, so the
two can never drift.

Hand-written (not sqlacodegen output), like `quota.py` / `pipeline_events.py`
— unlike CVConversionStatus/CVStyleStatus, SectionType is never a Postgres
column type (it only ever appears nested inside CVVersion.styleProfile's
JSON), so sqlacodegen has nothing to introspect it from.
"""

from enum import Enum


class SectionType(str, Enum):
    SUMMARY = "SUMMARY"
    EXPERIENCE = "EXPERIENCE"
    EDUCATION = "EDUCATION"
    SKILLS = "SKILLS"
    LANGUAGES = "LANGUAGES"
    CERTIFICATIONS = "CERTIFICATIONS"
    PROJECTS = "PROJECTS"
    OTHER = "OTHER"
