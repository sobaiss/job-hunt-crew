import { describe, expect, it, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen } from "./test-utils";
import { SignInForm } from "@/app/(public)/sign-in/sign-in-form";

const { signIn } = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("next-auth/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-auth/react")>()),
  signIn,
}));

let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

beforeEach(() => {
  signIn.mockReset();
  searchParams = new URLSearchParams();
});

describe("SignInForm", () => {
  it("requests a Magic link via signIn with the return path", async () => {
    signIn.mockResolvedValue({ ok: true, error: null });
    searchParams = new URLSearchParams("callbackUrl=%2Fcv-versions");
    const user = userEvent.setup();
    renderWithProviders(<SignInForm />);

    await user.type(
      screen.getByLabelText("Email address"),
      "candidate@example.com",
    );
    await user.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    expect(signIn).toHaveBeenCalledWith("nodemailer", {
      email: "candidate@example.com",
      redirect: false,
      callbackUrl: "/cv-versions",
    });
  });

  it("shows the check-your-inbox state after a successful Magic link request", async () => {
    signIn.mockResolvedValue({ ok: true, error: null });
    const user = userEvent.setup();
    renderWithProviders(<SignInForm />);

    await user.type(screen.getByLabelText("Email address"), "me@example.com");
    await user.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(screen.getByText(/me@example\.com/)).toBeInTheDocument();
  });

  it("renders an error message when the callback URL carries ?error=", () => {
    searchParams = new URLSearchParams("error=OAuthSignin");
    renderWithProviders(<SignInForm />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong while signing in. Please try again.",
    );
  });
});
