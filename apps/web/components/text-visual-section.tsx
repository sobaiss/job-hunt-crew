import type { ReactNode } from "react";
import Image from "next/image";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/** The small uppercase, coral-accent label above a section heading — the
 *  reviewed mockups' `.eyebrow` (design/Main.dc.html). */
export function Eyebrow({
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

/** A real product capture, as a light / dark pair of the same size. */
export type SectionCapture = {
  lightSrc: string;
  darkSrc: string;
  alt: string;
  width: number;
  height: number;
};

/**
 * A Landing page section pairing copy (eyebrow, heading, body, points) with a
 * real product capture (spec landing-v2 §4–6). The light / dark pair is
 * swapped by the `dark` class next-themes puts on <html>, so it follows the
 * visitor's theme; the hidden one is `display: none`, out of the
 * accessibility tree, so both carry the alt text and whichever is shown has
 * it. Stacked on mobile, text first; from `lg` the visual sits on the
 * `visual` side, so consecutive sections can alternate.
 */
export function TextVisualSection({
  id,
  visual,
  eyebrow,
  heading,
  body,
  points,
  image,
}: {
  id?: string;
  visual: "left" | "right";
  eyebrow: string;
  heading: string;
  body: string;
  points: string[];
  image: SectionCapture;
}) {
  return (
    <section
      id={id}
      data-visual={visual}
      className={cn(
        "grid gap-10 lg:items-center lg:gap-14",
        visual === "right"
          ? "lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]"
          : "lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]",
      )}
    >
      <div className="flex flex-col gap-5">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="font-serif text-3xl font-semibold tracking-tight text-balance">
          {heading}
        </h2>
        <p className="text-muted text-pretty">{body}</p>
        <ul className="flex flex-col gap-2.5 text-sm">
          {points.map((point) => (
            <li key={point} className="flex items-start gap-2">
              <Check
                className="mt-0.5 size-4 flex-none text-accent"
                aria-hidden="true"
              />
              {point}
            </li>
          ))}
        </ul>
      </div>
      <figure className={cn(visual === "left" && "lg:order-first")}>
        <div className="overflow-hidden rounded-xl border border-border bg-panel p-2 shadow-lg">
          <Image
            src={image.lightSrc}
            alt={image.alt}
            width={image.width}
            height={image.height}
            className="w-full rounded-lg border border-border dark:hidden"
          />
          <Image
            src={image.darkSrc}
            alt={image.alt}
            width={image.width}
            height={image.height}
            className="hidden w-full rounded-lg border border-border dark:block"
          />
        </div>
      </figure>
    </section>
  );
}
