"""SectionType (issue #94) is importable from the Analysis context too —
CvTailoringAgent (#97) will tag its generated headings with it, reading from
the same module services/api's StyleProfile consults (docs/adr/0008).
"""

from py_db.section_type import SectionType


def test_section_type_is_importable_from_the_analysis_context():
    assert SectionType.EXPERIENCE.value == "EXPERIENCE"
