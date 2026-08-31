"""Shared "load the CV + check it's ready for comparison" step for the two
comparison runners (comparison_crew.run_analysis and crew_task.run_crew_task).

During the expand step (issue #16) a CV is usable by the comparison if *either*
path is ready:

- its Markdown rendition — `conversionStatus == CONVERTED` and `markdownContent`
  set (preferred), or
- the legacy structured-data summary — `parseStatus == PARSED` and
  `structuredData` set (fallback, retired in #21).

`load_cv_comparison_input` returns whichever is available (Markdown preferred)
and raises `CVComparisonInputError` with a caller-facing message otherwise, so
each runner can adapt that message to its own failure path.
"""

from dataclasses import dataclass

from py_db.models import CVVersion, Cvconversionstatus, Cvparsestatus
from sqlalchemy.ext.asyncio import AsyncSession


class CVComparisonInputError(Exception):
    pass


@dataclass
class CVComparisonInput:
    #: The CV's Markdown rendition, when it has been converted; None otherwise.
    markdown: str | None
    #: The legacy structured-data summary, used only when `markdown` is None.
    structured_data: dict | None


async def load_cv_comparison_input(session: AsyncSession, cv_version_id: str) -> CVComparisonInput:
    cv_version = await session.get(CVVersion, cv_version_id)
    if cv_version is None:
        raise CVComparisonInputError(f"CVVersion {cv_version_id} not found")

    if (
        cv_version.conversionStatus == Cvconversionstatus.CONVERTED
        and cv_version.markdownContent
    ):
        return CVComparisonInput(markdown=cv_version.markdownContent, structured_data=None)

    if cv_version.parseStatus == Cvparsestatus.PARSED and cv_version.structuredData:
        return CVComparisonInput(markdown=None, structured_data=cv_version.structuredData)

    raise CVComparisonInputError(
        f"CVVersion {cv_version_id} is not CONVERTED with markdownContent "
        f"(nor PARSED with structuredData)"
    )
