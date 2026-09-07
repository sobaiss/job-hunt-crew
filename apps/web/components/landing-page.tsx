"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  BarChart3,
  FileText,
  GitCompare,
  Layers,
  Quote,
  ShieldCheck,
  Target,
} from "lucide-react";

import { Button } from "@/components/ui/button";

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

const FEATURE_ICONS = {
  evidence: FileText,
  gaps: Target,
  suggestions: ArrowRight,
  compare: GitCompare,
  batch: Layers,
  trend: BarChart3,
} as const;

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
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-3">
          <Link href="/" aria-label={t("footer.copyright")}>
            <Brand />
          </Link>
          <Button asChild size="sm">
            <Link href="/sign-in">{t("signIn")}</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-24 px-6 py-16 sm:py-24">
        {/* Hero */}
        <section className="flex flex-col items-center gap-6 text-center">
          <span className="rounded-full border border-border bg-panel px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted">
            {t("hero.eyebrow")}
          </span>
          <h1 className="max-w-3xl font-serif text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            {t("tagline")}
          </h1>
          <p className="max-w-2xl text-lg text-muted text-pretty">
            {t("description")}
          </p>
          <Button asChild size="lg">
            <Link href="/sign-in">{t("signIn")}</Link>
          </Button>
        </section>

        {/* How it works */}
        <section className="flex flex-col gap-10">
          <h2 className="font-serif text-3xl font-semibold tracking-tight">
            {t("howItWorks.heading")}
          </h2>
          <ol className="grid gap-6 sm:grid-cols-3">
            {steps.map((step, i) => (
              <li
                key={step.title}
                className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-6 shadow-xs"
              >
                <span className="flex size-8 items-center justify-center rounded-full bg-accent/15 text-sm font-semibold text-accent ring-1 ring-accent/30">
                  {i + 1}
                </span>
                <h3 className="text-lg font-medium">{step.title}</h3>
                <p className="text-sm text-muted">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Features */}
        <section className="flex flex-col gap-10">
          <h2 className="font-serif text-3xl font-semibold tracking-tight">
            {t("features.heading")}
          </h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({ Icon, title, body }) => (
              <div
                key={title}
                className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-6 shadow-xs"
              >
                <Icon className="size-5 text-accent" aria-hidden="true" />
                <h3 className="text-lg font-medium">{title}</h3>
                <p className="text-sm text-muted">{body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Product preview — a stylised in-page mock of the Dashboard until the
            real screenshot lands in the final slice. */}
        <section className="flex flex-col gap-10 lg:flex-row lg:items-center">
          <div className="flex flex-col gap-4 lg:w-2/5">
            <h2 className="font-serif text-3xl font-semibold tracking-tight">
              {t("preview.heading")}
            </h2>
            <p className="text-muted">{t("preview.body")}</p>
          </div>
          <figure className="flex flex-col gap-2 lg:w-3/5">
            <div
              aria-hidden="true"
              className="rounded-xl border border-border bg-panel p-4 shadow-md"
            >
              <div className="grid grid-cols-3 gap-3">
                {["72", "91", "18"].map((n) => (
                  <div
                    key={n}
                    className="flex flex-col gap-1 rounded-lg bg-background p-3 ring-1 ring-border"
                  >
                    <span className="text-2xl font-semibold tabular-nums">
                      {n}
                    </span>
                    <span className="h-2 w-2/3 rounded bg-border" />
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-end gap-1.5 rounded-lg bg-background p-3 ring-1 ring-border">
                {[30, 44, 38, 56, 62, 58, 74].map((h, i) => (
                  <span
                    key={i}
                    style={{ height: `${h}px` }}
                    className="w-full rounded-t bg-accent/40"
                  />
                ))}
              </div>
            </div>
            <figcaption className="text-center text-xs text-muted">
              {t("preview.caption")}
            </figcaption>
          </figure>
        </section>

        {/* Privacy — the factual "data isolated per account" section that stands
            in for testimonials / logos, grounded in PRD §6. */}
        <section className="flex flex-col gap-6 rounded-xl border border-border bg-panel p-8 shadow-xs">
          <div className="flex items-center gap-3">
            <ShieldCheck className="size-6 text-accent" aria-hidden="true" />
            <h2 className="font-serif text-3xl font-semibold tracking-tight">
              {t("privacy.heading")}
            </h2>
          </div>
          <p className="max-w-3xl text-muted">{t("privacy.body")}</p>
          <ul className="flex flex-col gap-2 text-sm">
            {["point1", "point2", "point3"].map((p) => (
              <li key={p} className="flex gap-2">
                <span aria-hidden className="text-accent">
                  ✓
                </span>
                {t(`privacy.${p}`)}
              </li>
            ))}
          </ul>
        </section>

        {/* FAQ */}
        <section className="flex flex-col gap-8">
          <h2 className="font-serif text-3xl font-semibold tracking-tight">
            {t("faq.heading")}
          </h2>
          <div className="flex flex-col divide-y divide-border border-y border-border">
            {faqs.map(({ key, q, a }) => (
              <details key={key} className="group py-4">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-left font-medium">
                  {q}
                  <ArrowRight
                    aria-hidden="true"
                    className="size-4 flex-none text-muted transition-transform group-open:rotate-90"
                  />
                </summary>
                <p className="mt-2 text-sm text-muted">{a}</p>
                {key === "limits" && (
                  <p className="mt-2">
                    <Placeholder>{t("placeholders.dailyCap")}</Placeholder>
                  </p>
                )}
              </details>
            ))}
          </div>
        </section>

        {/* Repeated primary action */}
        <section className="flex flex-col items-center gap-4 rounded-xl border border-border bg-panel p-10 text-center shadow-xs">
          <Quote className="size-6 text-accent" aria-hidden="true" />
          <p className="max-w-xl font-serif text-2xl font-medium tracking-tight text-balance">
            {t("tagline")}
          </p>
          <Button asChild size="lg">
            <Link href="/sign-in">{t("signIn")}</Link>
          </Button>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-1">
            <Brand />
            <p className="text-sm text-muted">{t("footer.tagline")}</p>
          </div>
          <div className="flex flex-col gap-2 text-sm sm:items-end">
            <span className="font-medium">{t("footer.legalHeading")}</span>
            <Placeholder>{t("placeholders.legalLinks")}</Placeholder>
            <span className="text-xs text-muted">
              © {new Date().getFullYear()} {t("footer.copyright")}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
