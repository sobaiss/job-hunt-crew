"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

/**
 * Sign-in options: Google, LinkedIn, and an email Magic link. All three go
 * through next-auth `signIn`. `callbackUrl` (set by `middleware.ts` when it
 * bounces an unauthenticated request) is carried through so the user returns
 * to the page they originally asked for; it defaults to the Dashboard.
 *
 * After a Magic link request the form swaps to a "check your inbox" state
 * rather than redirecting. An `?error=` left on the URL by the auth callback,
 * or a failed Magic link request, surfaces a message.
 */
export function SignInForm() {
  const t = useTranslations("signIn");
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/analyses";
  const hasCallbackError = searchParams.get("error") != null;

  const [email, setEmail] = React.useState("");
  const [status, setStatus] = React.useState<"idle" | "sending" | "sent">(
    "idle",
  );
  const [submitFailed, setSubmitFailed] = React.useState(false);

  const showError = hasCallbackError || submitFailed;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus("sending");
    setSubmitFailed(false);
    const result = await signIn("nodemailer", {
      email,
      redirect: false,
      callbackUrl,
    });
    if (result?.error) {
      setSubmitFailed(true);
      setStatus("idle");
    } else {
      setStatus("sent");
    }
  }

  if (status === "sent") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("sentTitle")}</CardTitle>
          <CardDescription>{t("sentBody", { email })}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {showError && (
          <p role="alert" className="text-sm text-destructive">
            {t("error")}
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Button
            variant="outline"
            onClick={() => signIn("google", { callbackUrl })}
          >
            {t("google")}
          </Button>
          <Button
            variant="outline"
            onClick={() => signIn("linkedin", { callbackUrl })}
          >
            {t("linkedin")}
          </Button>
        </div>

        <div className="flex items-center gap-3 text-xs text-muted">
          <Separator className="flex-1" />
          {t("divider")}
          <Separator className="flex-1" />
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="email">{t("emailLabel")}</Label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="email"
              placeholder={t("emailPlaceholder")}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={status === "sending"}>
            {status === "sending" ? t("sending") : t("magicLink")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
