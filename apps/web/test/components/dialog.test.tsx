import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen, within } from "../test-utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

function Example() {
  return (
    <Dialog>
      <DialogTrigger>Open dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Delete CV version</DialogTitle>
        <DialogDescription>This cannot be undone.</DialogDescription>
        <button type="button">Confirm</button>
      </DialogContent>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("opens on trigger and moves focus into the dialog", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Example />);

    await user.click(screen.getByRole("button", { name: "Open dialog" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Delete CV version"),
    ).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Example />);

    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes via the built-in close button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Example />);

    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    await screen.findByRole("dialog");

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
