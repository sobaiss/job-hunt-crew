"""Location resolution (#215): a Search filter's free-text `location`
resolved to an INSEE region or department code, against a static table of
France's 18 regions and 101 departments.

In py-db so that the Ingestion Site adapters and services/api (which tells
the candidate, before a run, whether their location was recognised) read
one table. Communes are deliberately absent: 35,000 of them carry homonyms
that only a structured picker can disambiguate.

Hand-written (not sqlacodegen output), like `filter_support.py`. Kept small
enough to verify by reading against INSEE's Code officiel géographique.
"""

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

# France Travail's own parameter names for each kind, which is also the
# vocabulary this table is read in.
LocationKind = Literal["region", "departement"]


@dataclass(frozen=True)
class Location:
    kind: LocationKind
    code: str
    label: str


def _regions(*rows: tuple[str, str]) -> tuple[Location, ...]:
    return tuple(Location("region", code, label) for code, label in rows)


def _departments(*rows: tuple[str, str]) -> tuple[Location, ...]:
    return tuple(Location("departement", code, label) for code, label in rows)


REGIONS = _regions(
    ("01", "Guadeloupe"),
    ("02", "Martinique"),
    ("03", "Guyane"),
    ("04", "La Réunion"),
    ("06", "Mayotte"),
    ("11", "Île-de-France"),
    ("24", "Centre-Val de Loire"),
    ("27", "Bourgogne-Franche-Comté"),
    ("28", "Normandie"),
    ("32", "Hauts-de-France"),
    ("44", "Grand Est"),
    ("52", "Pays de la Loire"),
    ("53", "Bretagne"),
    ("75", "Nouvelle-Aquitaine"),
    ("76", "Occitanie"),
    ("84", "Auvergne-Rhône-Alpes"),
    ("93", "Provence-Alpes-Côte d'Azur"),
    ("94", "Corse"),
)

DEPARTMENTS = _departments(
    ("01", "Ain"),
    ("02", "Aisne"),
    ("03", "Allier"),
    ("04", "Alpes-de-Haute-Provence"),
    ("05", "Hautes-Alpes"),
    ("06", "Alpes-Maritimes"),
    ("07", "Ardèche"),
    ("08", "Ardennes"),
    ("09", "Ariège"),
    ("10", "Aube"),
    ("11", "Aude"),
    ("12", "Aveyron"),
    ("13", "Bouches-du-Rhône"),
    ("14", "Calvados"),
    ("15", "Cantal"),
    ("16", "Charente"),
    ("17", "Charente-Maritime"),
    ("18", "Cher"),
    ("19", "Corrèze"),
    ("2A", "Corse-du-Sud"),
    ("2B", "Haute-Corse"),
    ("21", "Côte-d'Or"),
    ("22", "Côtes-d'Armor"),
    ("23", "Creuse"),
    ("24", "Dordogne"),
    ("25", "Doubs"),
    ("26", "Drôme"),
    ("27", "Eure"),
    ("28", "Eure-et-Loir"),
    ("29", "Finistère"),
    ("30", "Gard"),
    ("31", "Haute-Garonne"),
    ("32", "Gers"),
    ("33", "Gironde"),
    ("34", "Hérault"),
    ("35", "Ille-et-Vilaine"),
    ("36", "Indre"),
    ("37", "Indre-et-Loire"),
    ("38", "Isère"),
    ("39", "Jura"),
    ("40", "Landes"),
    ("41", "Loir-et-Cher"),
    ("42", "Loire"),
    ("43", "Haute-Loire"),
    ("44", "Loire-Atlantique"),
    ("45", "Loiret"),
    ("46", "Lot"),
    ("47", "Lot-et-Garonne"),
    ("48", "Lozère"),
    ("49", "Maine-et-Loire"),
    ("50", "Manche"),
    ("51", "Marne"),
    ("52", "Haute-Marne"),
    ("53", "Mayenne"),
    ("54", "Meurthe-et-Moselle"),
    ("55", "Meuse"),
    ("56", "Morbihan"),
    ("57", "Moselle"),
    ("58", "Nièvre"),
    ("59", "Nord"),
    ("60", "Oise"),
    ("61", "Orne"),
    ("62", "Pas-de-Calais"),
    ("63", "Puy-de-Dôme"),
    ("64", "Pyrénées-Atlantiques"),
    ("65", "Hautes-Pyrénées"),
    ("66", "Pyrénées-Orientales"),
    ("67", "Bas-Rhin"),
    ("68", "Haut-Rhin"),
    ("69", "Rhône"),
    ("70", "Haute-Saône"),
    ("71", "Saône-et-Loire"),
    ("72", "Sarthe"),
    ("73", "Savoie"),
    ("74", "Haute-Savoie"),
    ("75", "Paris"),
    ("76", "Seine-Maritime"),
    ("77", "Seine-et-Marne"),
    ("78", "Yvelines"),
    ("79", "Deux-Sèvres"),
    ("80", "Somme"),
    ("81", "Tarn"),
    ("82", "Tarn-et-Garonne"),
    ("83", "Var"),
    ("84", "Vaucluse"),
    ("85", "Vendée"),
    ("86", "Vienne"),
    ("87", "Haute-Vienne"),
    ("88", "Vosges"),
    ("89", "Yonne"),
    ("90", "Territoire de Belfort"),
    ("91", "Essonne"),
    ("92", "Hauts-de-Seine"),
    ("93", "Seine-Saint-Denis"),
    ("94", "Val-de-Marne"),
    ("95", "Val-d'Oise"),
    ("971", "Guadeloupe"),
    ("972", "Martinique"),
    ("973", "Guyane"),
    ("974", "La Réunion"),
    ("976", "Mayotte"),
)


def _normalised(text: str) -> str:
    """Accents, case and separators (hyphens, apostrophes, spaces) ignored:
    "Île-de-France", "ile de france" and "ILE-DE-FRANCE" all read the same."""
    decomposed = unicodedata.normalize("NFKD", text)
    unaccented = "".join(c for c in decomposed if not unicodedata.combining(c))
    return " ".join(re.split(r"[^a-z0-9]+", unaccented.casefold())).strip()


# Regions last, so that a name both carry (the five overseas ones) resolves
# to the region: the wider of two identical searches.
_BY_NAME = {_normalised(loc.label): loc for loc in (*DEPARTMENTS, *REGIONS)}


def resolve_location(text: str | None) -> Location | None:
    """The region or department `text` names, or None when it names neither
    (a typo, a commune, an empty value)."""
    if not text:
        return None
    return _BY_NAME.get(_normalised(text))
