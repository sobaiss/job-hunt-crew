import { describe, expect, it, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";

import { renderWithProviders, screen } from "./test-utils";
import { SignInForm } from "@/app/(public)/sign-in/sign-in-form";
import type { SignInMethods } from "@/lib/sign-in-methods";

const allMethods: SignInMethods = { google: true, linkedin: true, magicLink: true };
const noMethods: SignInMethods = { google: false, linkedin: false, magicLink: false };

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
    renderWithProviders(<SignInForm methods={allMethods} />);

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
    renderWithProviders(<SignInForm methods={allMethods} />);

    await user.type(screen.getByLabelText("Email address"), "me@example.com");
    await user.click(
      screen.getByRole("button", { name: "Email me a sign-in link" }),
    );

    expect(await screen.findByText("Check your inbox")).toBeInTheDocument();
    expect(screen.getByText(/me@example\.com/)).toBeInTheDocument();
  });

  it("renders an error message when the callback URL carries ?error=", () => {
    searchParams = new URLSearchParams("error=OAuthSignin");
    renderWithProviders(<SignInForm methods={allMethods} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong while signing in. Please try again.",
    );
  });

  it("signs in with email and password via the credentials provider", async () => {
    signIn.mockResolvedValue({ ok: true, error: null, url: "/analyses" });
    searchParams = new URLSearchParams("callbackUrl=%2Fcv-versions");
    const user = userEvent.setup();
    renderWithProviders(<SignInForm methods={allMethods} />);

    await user.type(
      screen.getByLabelText("Email address"),
      "candidate@example.com",
    );
    await user.type(screen.getByLabelText("Password"), "a real password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(signIn).toHaveBeenCalledWith("credentials", {
      email: "candidate@example.com",
      password: "a real password",
      redirect: false,
      callbackUrl: "/cv-versions",
    });
  });

  it("shows an error when the password sign-in is rejected", async () => {
    signIn.mockResolvedValue({ ok: false, error: "CredentialsSignin" });
    const user = userEvent.setup();
    renderWithProviders(<SignInForm methods={allMethods} />);

    await user.type(
      screen.getByLabelText("Email address"),
      "candidate@example.com",
    );
    await user.type(screen.getByLabelText("Password"), "wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByText("Invalid email or password."),
    ).toBeInTheDocument();
  });

  it("disables the password sign-in button until a password is entered", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SignInForm methods={allMethods} />);

    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();

    await user.type(screen.getByLabelText("Password"), "a real password");

    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  // #258: only the configured sign-in methods render.
  describe("configured methods", () => {
    const google = { name: "Continue with Google" };
    const linkedin = { name: "Continue with LinkedIn" };
    const magicLink = { name: "Email me a sign-in link" };

    it("renders only the email + password form when nothing optional is configured", () => {
      renderWithProviders(<SignInForm methods={noMethods} />);

      expect(screen.getByLabelText("Email address")).toBeInTheDocument();
      expect(screen.getByLabelText("Password")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
      expect(screen.queryByRole("button", google)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", linkedin)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", magicLink)).not.toBeInTheDocument();
      expect(screen.queryByText("or")).not.toBeInTheDocument();
    });

    it("renders the Google button, and only that one, when Google is configured", () => {
      renderWithProviders(<SignInForm methods={{ ...noMethods, google: true }} />);

      expect(screen.getByRole("button", google)).toBeInTheDocument();
      expect(screen.queryByRole("button", linkedin)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", magicLink)).not.toBeInTheDocument();
      expect(screen.getByText("or")).toBeInTheDocument();
    });

    it("renders the LinkedIn button, and only that one, when LinkedIn is configured", async () => {
      const user = userEvent.setup();
      renderWithProviders(<SignInForm methods={{ ...noMethods, linkedin: true }} />);

      expect(screen.queryByRole("button", google)).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", linkedin));

      expect(signIn).toHaveBeenCalledWith("linkedin", { callbackUrl: "/analyses" });
    });

    it("renders the magic-link option when an email server is configured", () => {
      renderWithProviders(<SignInForm methods={{ ...noMethods, magicLink: true }} />);

      expect(screen.getByRole("button", magicLink)).toBeInTheDocument();
      expect(screen.queryByRole("button", google)).not.toBeInTheDocument();
      expect(screen.queryByText("or")).not.toBeInTheDocument();
    });
  });
});
