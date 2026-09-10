import { describe, expect, it } from "vitest";

import { matchScoreBand } from "@/lib/match-score-band";

describe("matchScoreBand", () => {
  it("maps score >= 75 to the strong band with the success colour", () => {
    expect(matchScoreBand(100)).toEqual({
      band: "strong",
      colorVar: "var(--color-success)",
    });
    expect(matchScoreBand(75).band).toBe("strong");
  });

  it("maps 45 <= score <= 74 to the partial band with the warning colour", () => {
    expect(matchScoreBand(74)).toEqual({
      band: "partial",
      colorVar: "var(--color-warning)",
    });
    expect(matchScoreBand(45).band).toBe("partial");
    expect(matchScoreBand(60).band).toBe("partial");
  });

  it("maps score < 45 to the weak band with the danger colour", () => {
    expect(matchScoreBand(44)).toEqual({
      band: "weak",
      colorVar: "var(--color-danger)",
    });
    expect(matchScoreBand(0).band).toBe("weak");
  });

  it("never returns the coral accent for any score", () => {
    for (const score of [0, 20, 44, 45, 60, 74, 75, 90, 100]) {
      expect(matchScoreBand(score).colorVar).not.toMatch(/accent/);
    }
  });
});
