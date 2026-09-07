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

const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export function MatchScoreGauge({ score }: { score: number }) {
  const t = useTranslations("analyses.detail");
  const { band, colorVar } = matchScoreBand(score);
  const clamped = Math.max(0, Math.min(100, score));
  const dashOffset = CIRCUMFERENCE * (1 - clamped / 100);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative size-36">
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
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-4xl font-bold tabular-nums">{score}</span>
        </div>
      </div>
      <span
        className={cn(
          "rounded-full px-3 py-1 text-sm font-medium",
          PILL_CLASS[band],
        )}
      >
        {t(`band.${band}`)}
      </span>
    </div>
  );
}
