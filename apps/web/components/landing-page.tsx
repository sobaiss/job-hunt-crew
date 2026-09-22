"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  BarChart3,
  ChevronDown,
  FileText,
  GitCompare,
  Layers,
  Link2,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { MatchScoreGauge } from "@/components/match-score-gauge";
import { LocaleSwitch } from "@/components/locale-switch";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** The brand wordmark + mark, matching the App shell's SidebarBrand. */
function Brand() {
  const tApp = useTranslations("app");
  return (
    <span className="flex items-center gap-2">
      <svg
        aria-hidden="true"
        viewBox="0 0 28 28"
        className="size-6 flex-none text-accent"
      >
        <rect
          x="1.5"
          y="1.5"
          width="25"
          height="25"
          rx="7"
          fill="currentColor"
          fillOpacity="0.16"
        />
        <circle
          cx="14"
          cy="14"
          r="7"
          stroke="currentColor"
          strokeWidth="2"
          fill="none"
        />
        <circle cx="14" cy="14" r="2.6" fill="currentColor" />
        <path
          d="M14 3.2v3.2M14 21.6v3.2M24.8 14h-3.2M6.4 14H3.2"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="font-serif text-base font-semibold tracking-tight">
        {tApp("name")}
      </span>
    </span>
  );
}

/** A visible, unmistakable marker for a fact the product owner still has to fill
 * in — never a fabricated value. */
function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-panel px-2 py-0.5 text-xs font-medium text-muted">
      <span aria-hidden>⚠</span>
      {children}
    </span>
  );
}

/** The small uppercase, coral-accent label above a section heading — the
 *  reviewed mockups' `.eyebrow` (design/Main.dc.html). */
function Eyebrow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "text-xs font-semibold tracking-[0.15em] text-accent uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}

const FEATURE_ICONS = {
  evidence: FileText,
  gaps: Target,
  suggestions: ArrowRight,
  compare: GitCompare,
  batch: Layers,
  trend: BarChart3,
} as const;

const STEP_ICONS = [Link2, FileText, Sparkles] as const;

/**
 * The compact "Dashboard" widget in the hero, right of the headline —
 * illustrative sample data (matching design/Main.dc.html), not a live
 * screenshot: at hero width there's no room for the real preview image
 * used further down the page. Reuses the real {@link MatchScoreGauge} so its
 * band colour and label stay in lockstep with the actual scoring logic.
 */
function HeroPreviewCard() {
  const t = useTranslations("landing.hero.preview");
  const stats = [
    { label: t("scoreAvg"), value: 68 },
    { label: t("best"), value: 91 },
    { label: t("analyses"), value: 24 },
    { label: t("cv"), value: 3 },
  ];
  const rows = [
    { title: t("row1Title"), company: t("row1Company"), score: 91 },
    { title: t("row2Title"), company: t("row2Company"), score: 74 },
    { title: t("row3Title"), company: t("row3Company"), score: 58 },
  ];

  return (
    <Card className="gap-0 overflow-hidden py-0 shadow-lg" aria-hidden="true">
      <div className="flex items-center justify-between border-b border-border bg-panel px-4 py-3">
        <span className="font-serif text-sm font-semibold">{t("title")}</span>
        <span className="text-xs text-muted">{t("period")}</span>
      </div>
      <div className="flex flex-col gap-3.5 p-4">
        <div className="grid grid-cols-4 gap-2.5">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="rounded-lg border border-border px-2.5 py-2"
            >
              <div className="truncate text-[11px] text-muted">
                {stat.label}
              </div>
              <div className="font-serif text-xl font-semibold">
                {stat.value}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 rounded-xl border border-border p-3.5">
          <MatchScoreGauge score={76} size="sm" />
          <div className="flex min-w-0 flex-1 flex-col">
            {rows.map((row, i) => (
              <div
                key={row.title}
                className={cn(
                  "flex items-center justify-between gap-3 py-1.5 text-xs",
                  i > 0 && "border-t border-border",
                )}
              >
                <span className="truncate">
                  {row.title} · {row.company}
                </span>
                <span className="flex-none font-medium tabular-nums">
                  {row.score}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * The public front door for a signed-out Visitor: a marketing page with a
 * single repeated primary action ("Sign in"). No pricing, no testimonials, no
 * client logos — a factual privacy section stands in for social proof. The
 * daily-analysis-cap number and the legal links are shown as visible
 * placeholders, not invented values. Lives outside the App shell.
 */
export function LandingPage() {
  const t = useTranslations("landing");

  const steps = [
    { title: t("howItWorks.step1Title"), body: t("howItWorks.step1Body") },
    { title: t("howItWorks.step2Title"), body: t("howItWorks.step2Body") },
    { title: t("howItWorks.step3Title"), body: t("howItWorks.step3Body") },
  ];

  const features = (
    ["evidence", "gaps", "suggestions", "compare", "batch", "trend"] as const
  ).map((key) => ({
    Icon: FEATURE_ICONS[key],
    title: t(`features.${key}Title`),
    body: t(`features.${key}Body`),
  }));

  const faqs = (
    ["formats", "sources", "limits", "privacy", "model"] as const
  ).map((key) => ({
    key,
    q: t(`faq.${key}Q`),
    a: t(`faq.${key}A`),
  }));

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-3.5">
          <Link href="/" aria-label={t("footer.copyright")}>
            <Brand />
          </Link>
          <nav className="flex items-center gap-7">
            <a
              href="#how"
              className="hidden text-sm text-muted hover:text-foreground sm:inline"
            >
              {t("nav.how")}
            </a>
            <a
              href="#features"
              className="hidden text-sm text-muted hover:text-foreground sm:inline"
            >
              {t("nav.features")}
            </a>
            <a
              href="#faq"
              className="hidden text-sm text-muted hover:text-foreground sm:inline"
            >
              {t("nav.faq")}
            </a>
            <LocaleSwitch />
            <Button asChild size="sm">
              <Link href="/sign-in">{t("signIn")}</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-24 px-6 py-16 sm:py-24">
        {/* Hero */}
        <section className="grid gap-14 lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)] lg:items-center">
          <div className="flex flex-col gap-5">
            <Eyebrow>{t("hero.eyebrow")}</Eyebrow>
            <h1 className="font-serif text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              {t("tagline")}
            </h1>
            <p className="max-w-md text-lg text-muted text-pretty">
              {t("description")}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-5">
              <Button asChild size="lg">
                <Link href="/sign-in">{t("signIn")}</Link>
              </Button>
              <a
                href="#how"
                className="inline-flex items-center gap-1.5 text-sm font-medium"
              >
                {t("nav.how")}
                <ChevronDown className="size-4" aria-hidden="true" />
              </a>
            </div>
            <p className="text-xs text-muted">{t("signInMethods")}</p>
          </div>

          <HeroPreviewCard />
        </section>

        {/* How it works */}
        <section id="how" className="flex flex-col gap-10">
          <h2 className="font-serif text-3xl font-semibold tracking-tight">
            {t("howItWorks.heading")}
          </h2>
          <ol className="grid gap-8 sm:grid-cols-3">
            {steps.map((step, i) => {
              const Icon = STEP_ICONS[i];
              return (
                <li key={step.title} className="flex flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <span className="font-serif text-sm font-semibold text-accent">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-accent/12 text-accent">
                      <Icon className="size-5" aria-hidden="true" />
                    </span>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-lg font-medium">{step.title}</h3>
                    <p className="text-sm text-muted">{step.body}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        {/* Features */}
        <section id="features" className="flex flex-col gap-10">
          <div className="flex flex-col gap-3">
            <Eyebrow>{t("nav.features")}</Eyebrow>
            <h2 className="font-serif text-3xl font-semibold tracking-tight">
              {t("features.heading")}
            </h2>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ Icon, title, body }) => (
              <Card key={title} className="gap-3 py-6">
                <div className="flex flex-col gap-3 px-6">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-accent/12 text-accent">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="text-lg font-medium">{title}</h3>
                  <p className="text-sm text-muted">{body}</p>
                </div>
              </Card>
            ))}
          </div>
        </section>

        {/* Product preview — real screenshots of the redesigned signed-in
            Dashboard (spec #49). Regenerate with
            `pnpm exec playwright test --config design/capture/playwright.capture.config.ts`.
            The light / dark pair is swapped by the `dark` class next-themes
            puts on <html>, so it follows the visitor's system preference. */}
        <section className="flex flex-col gap-10 text-center">
          <div className="flex flex-col items-center gap-3">
            <Eyebrow>{t("preview.eyebrow")}</Eyebrow>
            <h2 className="font-serif text-3xl font-semibold tracking-tight">
              {t("preview.heading")}
            </h2>
            <p className="max-w-xl text-muted">{t("preview.body")}</p>
          </div>
          <figure className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <div className="overflow-hidden rounded-xl border border-border bg-panel p-2 shadow-lg">
              <Image
                src="/dashboard-preview-light.png"
                alt={t("preview.caption")}
                width={1024}
                height={1295}
                className="w-full rounded-lg border border-border dark:hidden"
              />
              <Image
                src="/dashboard-preview-dark.png"
                alt=""
                aria-hidden="true"
                width={1024}
                height={1295}
                className="hidden w-full rounded-lg border border-border dark:block"
              />
            </div>
            <figcaption className="text-center text-xs text-muted">
              {t("preview.caption")}
            </figcaption>
          </figure>
        </section>

        {/* Privacy — the factual "data isolated per account" section that stands
            in for testimonials / logos, grounded in PRD §6. */}
        <section className="flex flex-col items-center gap-6 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-accent/12 text-accent">
            <ShieldCheck className="size-6" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-3">
            <h2 className="font-serif text-3xl font-semibold tracking-tight">
              {t("privacy.heading")}
            </h2>
            <p className="max-w-2xl text-muted text-pretty">
              {t("privacy.body")}
            </p>
          </div>
          <ul className="flex flex-col gap-2 text-sm">
            {["point1", "point2", "point3"].map((p) => (
              <li key={p} className="flex items-center gap-2">
                <span aria-hidden className="text-accent">
                  ✓
                </span>
                {t(`privacy.${p}`)}
              </li>
            ))}
          </ul>
        </section>

        {/* FAQ */}
        <section id="faq" className="flex flex-col gap-8">
          <div className="flex flex-col items-center gap-3 text-center">
            <Eyebrow>{t("nav.faq")}</Eyebrow>
            <h2 className="font-serif text-3xl font-semibold tracking-tight">
              {t("faq.heading")}
            </h2>
          </div>
          <div className="mx-auto flex w-full max-w-3xl flex-col divide-y divide-border border-y border-border">
            {faqs.map(({ key, q, a }) => (
              <details key={key} className="group py-5">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left text-base font-medium">
                  {q}
                  <ChevronDown
                    aria-hidden="true"
                    className="size-4 flex-none text-muted transition-transform group-open:rotate-180"
                  />
                </summary>
                <p className="mt-3 max-w-2xl text-sm text-muted">{a}</p>
              </details>
            ))}
          </div>
          <p className="text-center text-xs text-muted">
            <Placeholder>{t("placeholders.dailyCap")}</Placeholder>
          </p>
        </section>
      </main>

      {/* Repeated primary action — the one full-bleed coral-tinted band on
          the page (design/Main.dc.html), so it sits outside `<main>`'s
          `max-w-6xl` the same way the header and footer do. */}
      <section className="border-t border-border bg-accent/8">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-5 px-6 py-16 text-center">
          <h2 className="font-serif text-4xl font-semibold tracking-tight text-balance">
            {t("finalCta.heading")}
          </h2>
          <Button asChild size="lg">
            <Link href="/sign-in">{t("signIn")}</Link>
          </Button>
          <p className="text-xs text-muted">{t("signInMethods")}</p>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-12 sm:flex-row sm:justify-between">
          <div className="flex flex-col gap-2 sm:max-w-56">
            <Brand />
            <p className="text-sm text-muted">{t("footer.tagline")}</p>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            <div className="flex flex-col gap-2.5 text-sm">
              <span className="font-medium">{t("footer.productHeading")}</span>
              <a href="#features" className="text-muted hover:text-foreground">
                {t("nav.features")}
              </a>
              <a href="#how" className="text-muted hover:text-foreground">
                {t("nav.how")}
              </a>
              <a href="#faq" className="text-muted hover:text-foreground">
                {t("nav.faq")}
              </a>
            </div>
            <div className="flex flex-col gap-2.5 text-sm">
              <span className="font-medium">
                {t("footer.resourcesHeading")}
              </span>
              <Placeholder>{t("placeholders.resourceLinks")}</Placeholder>
            </div>
            <div className="flex flex-col gap-2.5 text-sm">
              <span className="font-medium">{t("footer.legalHeading")}</span>
              <Placeholder>{t("placeholders.legalLinks")}</Placeholder>
            </div>
            <div className="flex flex-col gap-2.5 text-sm">
              <span className="font-medium">
                {t("footer.preferencesHeading")}
              </span>
              <div className="flex items-center gap-1">
                <LocaleSwitch />
                <ThemeToggle />
              </div>
            </div>
          </div>
        </div>
        <div className="mx-auto w-full max-w-6xl px-6 pb-10 text-xs text-muted">
          © {new Date().getFullYear()} {t("footer.copyright")}
        </div>
      </footer>
    </div>
  );
}
