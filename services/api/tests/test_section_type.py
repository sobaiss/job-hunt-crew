"""SectionType (issue #94): the shared vocabulary a StyleProfile keys its
per-section style by, and CvTailoringAgent (services/analysis, #97) tags its
headings with — imported from the same module in both contexts so the two
can never drift (docs/adr/0008).
"""

from py_db.section_type import SectionType


def test_section_type_has_the_canonical_vocabulary():
    assert {member.value for member in SectionType} == {
        "SUMMARY",
        "EXPERIENCE",
        "EDUCATION",
        "SKILLS",
        "LANGUAGES",
        "CERTIFICATIONS",
        "PROJECTS",
        "OTHER",
    }
