// Pure, framework-free mapping from a Match score (0-100) to a qualitative
// band. The thresholds were fixed in the reviewed mockup (spec #45):
//
//   score >= 75        -> "strong"  (var(--color-success), label "Fort")
//   45 <= score <= 74  -> "partial" (var(--color-warning), label "Partiel")
//   score < 45         -> "weak"    (var(--color-danger),  label "Faible")
//
// The same result drives the gauge fill colour and the band pill. Coral
// (`--accent`) is never used for a score — see DESIGN.md. The human label is
// resolved through next-intl at `analyses.detail.band.<band>`, not here.

export type MatchScoreBand = "strong" | "partial" | "weak";

export type MatchScoreBandInfo = {
  band: MatchScoreBand;
  /** A CSS custom-property reference, ready to drop into `stroke`/`color`. */
  colorVar: string;
};

export function matchScoreBand(score: number): MatchScoreBandInfo {
  if (score >= 75) return { band: "strong", colorVar: "var(--color-success)" };
  if (score >= 45) return { band: "partial", colorVar: "var(--color-warning)" };
  return { band: "weak", colorVar: "var(--color-danger)" };
}
