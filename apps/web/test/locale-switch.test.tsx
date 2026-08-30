import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { useTranslations } from "next-intl";

import { renderWithProviders, screen } from "./test-utils";
import { LocaleSwitch } from "@/components/locale-switch";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

function NavProbe() {
  const t = useTranslations("nav");
  return <span>{t("dashboard")}</span>;
}

describe("i18n catalogues through the provider stack", () => {
  it("renders English strings when the Locale is en", () => {
    renderWithProviders(<NavProbe />, { locale: "en" });
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("renders French strings when the Locale is fr", () => {
    renderWithProviders(<NavProbe />, { locale: "fr" });
    expect(screen.getByText("Tableau de bord")).toBeInTheDocument();
  });
});

describe("LocaleSwitch", () => {
  it("persists the choice to a cookie, updates <html lang>, and refreshes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<LocaleSwitch />, { locale: "en" });

    await user.click(screen.getByRole("button", { name: "Language" }));
    await user.click(await screen.findByRole("menuitem", { name: "French" }));

    expect(document.cookie).toContain("NEXT_LOCALE=fr");
    expect(document.documentElement.lang).toBe("fr");
    expect(refresh).toHaveBeenCalled();
  });
});
