import type { Metadata } from "next";
import { Inter, Source_Serif_4, Geist_Mono } from "next/font/google";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";
import { Providers } from "@/components/providers";

// Inter for UI, Source Serif 4 for headings + long-form prose, Geist Mono for
// code. Self-hosted by next/font (no browser request to Google), exposed as CSS
// variables that globals.css maps onto the Tailwind font tokens.
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Job Hunt Crew",
    template: "%s · Job Hunt Crew",
  },
  description:
    "Match your CV against real job offers and see exactly where you stand.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Resolved from i18n/request.ts (cookie -> Accept-Language -> `en`). `<html
  // lang>` must match so assistive tech and the browser treat the page right.
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${inter.variable} ${sourceSerif.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers locale={locale} messages={messages}>
          {children}
        </Providers>
      </body>
    </html>
  );
}
