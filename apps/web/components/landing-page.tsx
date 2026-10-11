"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  ChevronDown,
  GitCompare,
  Link2,
  ListChecks,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Target,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { PlanQuotaKind, PlanSummary } from "@/lib/internal-api";
import { matchScoreBand, type MatchScoreBand } from "@/lib/match-score-band";
import { LocaleSwitch } from "@/components/locale-switch";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
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

/** The three "And also" cards (spec landing-v2 §7). */
const FEATURES = [
  { key: "analysis", Icon: Target },
  { key: "compare", Icon: GitCompare },
  { key: "oneOff", Icon: Link2 },
] as const;

/** The FAQ, in display order (spec landing-v2 §10). */
const FAQ_KEYS = [
  "formats",
  "sources",
  "frequency",
  "apply",
  "invent",
  "filters",
  "privacy",
  "upgrade",
] as const;

const STEPS = [
  { key: "find", Icon: Search },
  { key: "analyse", Icon: Target },
  { key: "tailor", Icon: Sparkles },
  { key: "apply", Icon: Send },
  { key: "track", Icon: ListChecks },
] as const;

/** The anchor links shared by the header and the footer's Product column. */
const NAV_LINKS = [
  { key: "how", href: "#how" },
  { key: "agents", href: "#agents" },
  { key: "plans", href: "#plans" },
  { key: "faq", href: "#faq" },
] as const;

// Same band colours as MatchScoreGauge's pill — never the coral accent.
const SCORE_PILL_CLASS: Record<MatchScoreBand, string> = {
  strong: "bg-success/15 text-success",
  partial: "bg-warning/15 text-warning",
  weak: "bg-danger/15 text-danger",
};

/**
 * The illustrative agent card in the hero, right of the headline (spec
 * landing-v2 §2): sample data, not a live screenshot, so it is hidden from
 * assistive technology. Each score pill takes its band from the real
 * {@link matchScoreBand}, so it stays in lockstep with the scoring logic.
 */
function HeroAgentCard() {
  const t = useTranslations("landing.hero.agentCard");
  const rows = [
    { label: t("row1"), score: 91 },
    { label: t("row2"), score: 84 },
    { label: t("row3"), score: 76 },
  ];

  return (
    <Card className="gap-0 overflow-hidden py-0 shadow-lg" aria-hidden="true">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-panel px-4 py-3">
        <span className="truncate font-serif text-sm font-semibold">
          {t("title")}
        </span>
        <Badge variant="success">{t("status")}</Badge>
      </div>
      <div className="flex flex-col gap-3.5 p-4">
        <div className="flex flex-col gap-1 text-xs text-muted">
          <span>{t("lastRun", { analysed: 31, relevant: 4 })}</span>
          <span>{t("threshold", { threshold: 70 })}</span>
        </div>
        <ul className="flex flex-col rounded-xl border border-border px-3.5 py-1.5">
          {rows.map((row, i) => (
            <li
              key={row.label}
              className={cn(
                "flex items-center justify-between gap-3 py-2 text-sm",
                i > 0 && "border-t border-border",
              )}
            >
              <span className="truncate">{row.label}</span>
              <span
                className={cn(
                  "flex-none rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums",
                  SCORE_PILL_CLASS[matchScoreBand(row.score).band],
                )}
              >
                {row.score}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

const PLAN_KEYS = ["free", "standard", "premium"] as const;

const PLAN_QUOTA_ROWS: ReadonlyArray<{
  kind: PlanQuotaKind;
  labelKey: "activeScouts" | "analysesDaily" | "analysesMonthly" | "documentsDaily";
}> = [
  { kind: "ACTIVE_SCOUTS", labelKey: "activeScouts" },
  { kind: "ANALYSES_DAILY", labelKey: "analysesDaily" },
  { kind: "ANALYSES_MONTHLY", labelKey: "analysesMonthly" },
  { kind: "DOCUMENTS_DAILY", labelKey: "documentsDaily" },
];

/**
 * The Formules section (issue #247): the three Plans side by side by their
 * live PlanQuotaDefault caps, never a price. With `plans` null (the API
 * errored or timed out) each card keeps only its name and subtitle — no
 * figure is ever hard-coded here.
 */
function PlansSection({ plans }: { plans: PlanSummary[] | null }) {
  const t = useTranslations("landing.plans");
  const tLanding = useTranslations("landing");

  return (
    <section id="plans" className="flex flex-col gap-10">
      <div className="flex flex-col items-center gap-3 text-center">
        <Eyebrow>{t("eyebrow")}</Eyebrow>
        <h2 className="font-serif text-3xl font-semibold tracking-tight">
          {t("heading")}
        </h2>
        <p className="max-w-xl text-muted">{t("body")}</p>
      </div>
      <ul className="grid gap-5 md:grid-cols-3">
        {PLAN_KEYS.map((key) => {
          const quotas = plans?.find((p) => p.plan === key)?.quotas;
          return (
            <li key={key} className="flex">
              <Card className="flex-1 gap-5 py-6">
                <div className="flex flex-1 flex-col gap-5 px-6">
                  <div className="flex flex-col gap-1">
                    <h3 className="font-serif text-xl font-semibold">
                      {t(`${key}.name`)}
                    </h3>
                    <p className="text-sm text-muted">{t(`${key}.subtitle`)}</p>
                  </div>
                  {quotas && (
                    <dl className="flex flex-col divide-y divide-border text-sm">
                      {PLAN_QUOTA_ROWS.map(({ kind, labelKey }) => {
                        const limit = quotas[kind];
                        return (
                          <div
                            key={kind}
                            className="flex items-baseline justify-between gap-4 py-2"
                          >
                            <dt className="text-muted">{t(`quotas.${labelKey}`)}</dt>
                            <dd className="font-medium tabular-nums">
                              {limit == null ? t("unlimited") : limit}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                  <Button
                    asChild
                    variant={key === "free" ? "default" : "secondary"}
                    className="mt-auto"
                  >
                    <Link href="/sign-in">{tLanding("startFree")}</Link>
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      <p className="text-center text-sm text-muted">{t("note")}</p>
    </section>
  );
}

/**
 * The public front door for a signed-out Visitor: a marketing page telling
 * the find → analyse → tailor → apply → track journey, with "Start for free"
 * as the repeated primary action and "Sign in" kept only in the header. No
 * prices, no testimonials, no client logos — a factual privacy section stands
 * in for social proof. Publicly a Scout is always an "agent", and LinkedIn is
 * only ever a sign-in method, never a job source. Facts not yet settled (the
 * footer's resource and legal links) are shown as visible placeholders, not
 * invented values. Lives outside the App shell.
 */
export function LandingPage({ plans }: { plans: PlanSummary[] | null }) {
  const t = useTranslations("landing");

  const steps = STEPS.map(({ key, Icon }) => ({
    Icon,
    title: t(`howItWorks.${key}Title`),
    body: t(`howItWorks.${key}Body`),
  }));

  const features = FEATURES.map(({ key, Icon }) => ({
    Icon,
    title: t(`features.${key}Title`),
    body: t(`features.${key}Body`),
  }));

  const faqs = FAQ_KEYS.map((key) => ({
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
            {NAV_LINKS.map(({ key, href }) => (
              <a
                key={key}
                href={href}
                className="hidden text-sm text-muted hover:text-foreground sm:inline"
              >
                {t(`nav.${key}`)}
              </a>
            ))}
            <LocaleSwitch />
            <Button asChild size="sm">
              <Link href="/sign-in">
                {t("signIn")}
                <ArrowRight aria-hidden="true" />
              </Link>
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
                <Link href="/sign-in">
                  {t("startFree")}
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
              <a
                href="#how"
                className="inline-flex items-center gap-1.5 text-sm font-medium"
              >
                {t("hero.howLink")}
                <ChevronDown className="size-4" aria-hidden="true" />
              </a>
            </div>
            <p className="text-xs text-muted">{t("hero.note")}</p>
          </div>

          <HeroAgentCard />
        </section>

        {/* How it works */}
        <section id="how" className="flex flex-col gap-10">
          <h2 className="font-serif text-3xl font-semibold tracking-tight">
            {t("howItWorks.heading")}
          </h2>
          <ol className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
            {steps.map(({ Icon, title, body }, i) => (
              <li key={title} className="flex flex-col gap-4">
                <div className="flex items-center gap-3">
                  <span className="font-serif text-sm font-semibold text-accent">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="flex size-10 flex-none items-center justify-center rounded-xl bg-accent/12 text-accent">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-lg font-medium">{title}</h3>
                  <p className="text-sm text-muted">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Features */}
        <section id="features" className="flex flex-col gap-10">
          <h2 className="font-serif text-3xl font-semibold tracking-tight">
            {t("features.heading")}
          </h2>
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

        {/* Privacy — the factual "data isolated per account" section that stands
            in for testimonials / logos, grounded in PRD §6. CV redaction
            (docs/adr/0022) leads. */}
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
          <ul className="flex max-w-2xl flex-col gap-2 text-left text-sm">
            {["point1", "point2", "point3", "point4"].map((p) => (
              <li key={p} className="flex items-start gap-2">
                <span aria-hidden className="text-accent">
                  ✓
                </span>
                {t(`privacy.${p}`)}
              </li>
            ))}
          </ul>
        </section>

        <PlansSection plans={plans} />

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
            <Link href="/sign-in">
              {t("startFree")}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
          <p className="text-xs text-muted">{t("finalCta.note")}</p>
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
              {NAV_LINKS.map(({ key, href }) => (
                <a
                  key={key}
                  href={href}
                  className="text-muted hover:text-foreground"
                >
                  {t(`nav.${key}`)}
                </a>
              ))}
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
