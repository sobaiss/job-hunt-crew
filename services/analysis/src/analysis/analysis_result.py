"""The Analysis result schema (PRD Section 8.6), combining
ComparisonAnalysisAgent's and RecommendationWriterAgent's output (M2-T6).
Validated via Pydantic before being written to Analysis.resultJSON — the
final gate PRD 8.6 requires before Postgres persistence.
"""

from pydantic import BaseModel

from .comparison_analysis_agent import MatchedSkill, MissingSkill
from .recommendation_writer_agent import ImprovementSuggestion


class AnalysisResult(BaseModel):
    match_score: int
    matched_skills: list[MatchedSkill]
    missing_skills: list[MissingSkill]
    strengths: list[str]
    weaknesses: list[str]
    improvement_suggestions: list[ImprovementSuggestion]
    summary: str
    generated_at: str
    model_used: str
    job_offer_id: str
    cv_version_id: str
