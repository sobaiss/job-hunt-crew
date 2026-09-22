"use client";

import { useTranslations } from "next-intl";

import { matchScoreBand, type MatchScoreBand } from "@/lib/match-score-band";
import { cn } from "@/lib/utils";

// A radial Match-score gauge plus the plain-language band pill (spec #45). The
// band, the ring colour and the pill colour all come from `matchScoreBand` —
// `--success` / `--warning` / `--danger` only, never the coral accent
// (DESIGN.md). The numeric score sits in the middle of the ring.

const PILL_CLASS: Record<MatchScoreBand, string> = {
  strong: "bg-success/15 text-success",
  partial: "bg-warning/15 text-warning",
  weak: "bg-danger/15 text-danger",
};

// `md` is the Analysis-detail hero gauge; `sm` is the compact variant used per
// row in the ranked Batch result list (spec #48). Only the outer box, the
// centred number and the pill scale — the SVG is drawn in a fixed viewBox and
// tracks its container.
const SIZE_CLASS = {
  md: {
    box: "size-44",
    score: "text-5xl font-serif",
    pill: "px-3 py-1 text-sm",
    gap: "gap-3.5",
  },
  sm: {
    box: "size-16",
    score: "text-lg font-sans",
    pill: "px-2 py-0.5 text-xs",
    gap: "gap-1.5",
  },
} as const;

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function MatchScoreGauge({
  score,
  size = "md",
  legend = false,
}: {
  score: number;
  size?: "sm" | "md";
  /** Shows the score-band threshold caption below the pill — the hero gauge
   *  on the Analysis detail page and its Quick view (spec's "Refonte" style
   *  pass); the compact table/header uses of this gauge leave it off. */
  legend?: boolean;
}) {
  const t = useTranslations("analyses.detail");
  const { band, colorVar } = matchScoreBand(score);
  const clamped = Math.max(0, Math.min(100, score));
  const dashOffset = CIRCUMFERENCE * (1 - clamped / 100);
  const s = SIZE_CLASS[size];

  return (
    <div className={cn("flex flex-col items-center", s.gap)}>
      <div className={cn("relative", s.box)}>
        <svg
          viewBox="0 0 120 120"
          className="size-full -rotate-90"
          role="img"
          aria-label={t("gaugeLabel", { score })}
        >
          <circle
            cx="60"
            cy="60"
            r={RADIUS}
            fill="none"
            stroke="var(--color-border)"
            strokeWidth="10"
          />
          <circle
            cx="60"
            cy="60"
            r={RADIUS}
            fill="none"
            stroke={colorVar}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={cn("font-bold tabular-nums", s.score)}>{score}</span>
          {size === "md" && (
            <span className="text-xs font-medium text-muted">
              {t("outOf100")}
            </span>
          )}
        </div>
      </div>
      <span
        className={cn(
          "rounded-full font-medium",
          s.pill,
          PILL_CLASS[band],
        )}
      >
        {t(`band.${band}`)}
      </span>
      {legend && (
        <p className="text-center text-xs text-muted">{t("bandLegend")}</p>
      )}
    </div>
  );
}
