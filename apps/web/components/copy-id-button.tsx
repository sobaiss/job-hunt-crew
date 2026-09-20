"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

// A small icon button copying `value` to the clipboard, swapping to a check
// mark for a moment as feedback (issue #172) — backs the Analyses tables'
// "id" column, shown in full (unlike every other long-value column in these
// tables, which truncates with a hover tooltip) so it can actually be copied,
// e.g. to paste into a support ticket. `stopPropagation` keeps the click from
// also triggering the row's own click handler (opening the Quick view/panel).
export function CopyIdButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  );
}
