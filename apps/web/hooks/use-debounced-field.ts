import { useEffect, useRef, useState } from "react";

/**
 * A text field the candidate types into freely, whose value is only committed
 * once they pause.
 *
 * The Analyses table's search and location boxes used to narrow a list already
 * in memory, so every keystroke was free. Now each one is a request and a URL
 * rewrite (docs/adr/0033), and typing "développeur" unthrottled is eleven of
 * each, ten of them for a prefix nobody wanted to see.
 *
 * `committed` is the source of truth: it flows back into the field whenever it
 * changes for a reason other than this typing — the URL restored from a shared
 * link, a "Effacer les filtres" — so the box never disagrees with what the
 * table is showing. A pending keystroke is dropped on that sync rather than
 * fighting it, which is what a candidate who just cleared the filters expects.
 */
export function useDebouncedField(
  committed: string,
  onCommit: (value: string) => void,
  delayMs = 300,
): [string, (value: string) => void] {
  const [draft, setDraft] = useState(committed);
  const [lastCommitted, setLastCommitted] = useState(committed);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adjusting state during render rather than in an effect (the pattern
  // react.dev calls "adjusting state when a prop changes"): React re-runs this
  // component before touching the DOM, so the box never paints the old value
  // for a frame the way an effect would let it. Only the *external* value is
  // compared, so this cannot undo what is being typed in the gap before the
  // commit lands.
  if (committed !== lastCommitted) {
    setLastCommitted(committed);
    setDraft(committed);
  }

  // An external change also cancels a keystroke still waiting to commit: a
  // candidate who just cleared the filters should not have the term they were
  // typing land a moment later. Kept in an effect because it touches a ref,
  // which render is not allowed to.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
  }, [committed]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const change = (value: string) => {
    setDraft(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onCommit(value), delayMs);
  };

  return [draft, change];
}
