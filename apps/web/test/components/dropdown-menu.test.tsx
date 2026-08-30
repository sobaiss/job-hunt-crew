import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen } from "../test-utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function Menu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Profile</DropdownMenuItem>
        <DropdownMenuItem>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("DropdownMenu", () => {
  it("is closed until the trigger is activated", () => {
    renderWithProviders(<Menu />);

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Profile" }),
    ).not.toBeInTheDocument();
  });

  it("opens on trigger click and closes on Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Menu />);

    await user.click(screen.getByRole("button", { name: "Open menu" }));

    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Sign out" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
