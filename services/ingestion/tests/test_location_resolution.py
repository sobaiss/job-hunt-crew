"""Location resolution: a Search filter's free-text `location` resolved to
an INSEE region or department code against py-db's static table (#215)."""

import pytest
from py_db.locations import DEPARTMENTS, REGIONS, Location, resolve_location


def test_the_table_carries_18_regions_and_101_departments():
    assert len(REGIONS) == 18
    assert len(DEPARTMENTS) == 101
    assert len({r.code for r in REGIONS}) == 18
    assert len({d.code for d in DEPARTMENTS}) == 101


@pytest.mark.parametrize(
    "typed", ["ile de france", "Île-de-France", "ILE-DE-FRANCE", "  Ile-de-France "]
)
def test_accents_case_and_separators_do_not_matter(typed):
    assert resolve_location(typed) == Location("region", "11", "Île-de-France")


def test_a_department_resolves_to_its_code():
    assert resolve_location("rhone") == Location("departement", "69", "Rhône")
    assert resolve_location("Corse-du-Sud") == Location("departement", "2A", "Corse-du-Sud")


def test_paris_is_its_department():
    # Paris is a department, not a region; the region is Île-de-France.
    assert resolve_location("Paris") == Location("departement", "75", "Paris")


def test_a_name_shared_by_a_region_and_a_department_is_the_region():
    # La Réunion, Guadeloupe, … are both; the region is the wider search.
    assert resolve_location("Guadeloupe") == Location("region", "01", "Guadeloupe")


@pytest.mark.parametrize("typed", ["", "   ", "Lyonn", "Lyon", "Atlantis", None])
def test_anything_else_resolves_to_nothing(typed):
    # Communes (Lyon) are deliberately out of scope.
    assert resolve_location(typed) is None
