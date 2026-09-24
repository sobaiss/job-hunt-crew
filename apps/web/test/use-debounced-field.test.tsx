import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";

import { useDebouncedField } from "@/hooks/use-debounced-field";

// The Analyses table's search and location boxes. Each keystroke used to
// narrow a list already in memory; since docs/adr/0033 each commit is a
// request and a URL rewrite, so the field waits for a pause.

/** A commit window short enough to keep the suite quick, long enough that
 *  user-event's own keystrokes don't outrun it. */
const DELAY_MS = 50;

function Field({ onCommit }: { onCommit: (value: string) => void }) {
  const [committed, setCommitted] = useState("");
  const [draft, setDraft] = useDebouncedField(
    committed,
    (value) => {
      setCommitted(value);
      onCommit(value);
    },
    DELAY_MS,
  );
  return (
    <>
      <input aria-label="Field" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button type="button" onClick={() => setCommitted("from outside")}>
        Set externally
      </button>
    </>
  );
}

describe("useDebouncedField", () => {
  it("commits once after typing stops, not once per keystroke", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    await user.type(screen.getByLabelText("Field"), "backend");
    // Every letter is on screen straight away — the field is never the thing
    // waiting.
    expect(screen.getByLabelText("Field")).toHaveValue("backend");

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit).toHaveBeenCalledWith("backend");
    // Seven keystrokes, one request: the prefixes nobody asked to see never
    // leave the browser.
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("takes an external change over a keystroke still waiting to commit", async () => {
    // "Effacer les filtres" while a term is half-typed: the cleared value
    // wins, rather than the pending keystroke landing on top of it a moment
    // later.
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Field onCommit={onCommit} />);

    await user.type(screen.getByLabelText("Field"), "back");
    await user.click(screen.getByRole("button", { name: "Set externally" }));

    expect(screen.getByLabelText("Field")).toHaveValue("from outside");
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS * 4));
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Field")).toHaveValue("from outside");
  });
});
