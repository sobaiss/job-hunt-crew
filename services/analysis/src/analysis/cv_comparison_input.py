"""Shared "load the CV + check it's ready for comparison" step for the two
comparison runners (comparison_crew.run_analysis and crew_task.run_crew_task).

A CV is usable by the comparison once its Markdown rendition is ready —
`conversionStatus == CONVERTED` and `markdownContent` set. `load_cv_markdown`
returns that Markdown string, or raises `CVComparisonInputError` with a
caller-facing message so each runner can adapt it to its own failure path.
"""

from py_db.models import CVVersion, Cvconversionstatus
from sqlalchemy.ext.asyncio import AsyncSession


class CVComparisonInputError(Exception):
    pass


async def load_cv_markdown(session: AsyncSession, cv_version_id: str) -> str:
    cv_version = await session.get(CVVersion, cv_version_id)
    if cv_version is None:
        raise CVComparisonInputError(f"CVVersion {cv_version_id} not found")

    if (
        cv_version.conversionStatus == Cvconversionstatus.CONVERTED
        and cv_version.markdownContent
    ):
        return cv_version.markdownContent

    raise CVComparisonInputError(
        f"CVVersion {cv_version_id} is not CONVERTED with markdownContent"
    )
