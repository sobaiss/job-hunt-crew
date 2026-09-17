// Pure, framework-free text truncation (#128), reused as-is by Analyses, CV
// versions, and Agents. A strict character-count cut — no word-boundary
// logic — with "…" appended only when the value was actually cut.

export const TITLE_MAX_LENGTH = 50;
export const SHORT_FIELD_MAX_LENGTH = 15;

export type TruncateResult = {
  text: string;
  truncated: boolean;
};

export function truncate(text: string, maxLength: number): TruncateResult {
  if (text.length <= maxLength) return { text, truncated: false };
  return { text: `${text.slice(0, maxLength)}…`, truncated: true };
}
