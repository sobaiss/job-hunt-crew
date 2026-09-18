"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { useAdminUsers } from "@/hooks/use-admin";
import { DEFAULT_ADMIN_USERS_TABLE_STATE } from "@/lib/admin-users-filters";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type CandidatePickerCandidate = {
  id: string;
  name: string | null;
  email: string | null;
};

/**
 * Extracted from the Admin users table's name/email search (issue #160) so
 * the three upcoming admin tables (#161/#162/#163) can each offer "filter by
 * candidate" without reimplementing user search.
 *
 * Without `onSelectCandidate` this is a plain, labelled, controlled search
 * input — no suggestions are fetched — which is how the Admin users table
 * itself uses it, preserving its existing free-text server-side filter with
 * no visible behavior change. Passing `onSelectCandidate` turns on the
 * type-ahead: matching candidates (backed by the same `GET /v1/admin/users`
 * search already used by that table) are listed below the input, and
 * clicking one resolves the picker to that single `userId`.
 */
export function CandidatePicker({
  id = "candidate-picker",
  label,
  placeholder,
  value,
  onChange,
  onSelectCandidate,
}: {
  id?: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onSelectCandidate?: (candidate: CandidatePickerCandidate) => void;
}) {
  const t = useTranslations("candidatePicker");
  const [isOpen, setIsOpen] = useState(false);

  const trimmed = value.trim();
  const suggestionsEnabled = Boolean(onSelectCandidate) && isOpen && trimmed !== "";

  const { data, isFetching } = useAdminUsers(
    { ...DEFAULT_ADMIN_USERS_TABLE_STATE, search: trimmed, pageSize: 20 },
    { enabled: suggestionsEnabled },
  );

  const showDropdown = suggestionsEnabled && !isFetching;

  return (
    <div className="relative flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="search"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setIsOpen(true)}
        onBlur={() => setIsOpen(false)}
      />

      {showDropdown && (
        <ul
          role="listbox"
          aria-label={t("resultsLabel")}
          className="absolute top-full z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-border bg-background py-1 text-sm shadow-md"
        >
          {data && data.users.length === 0 && (
            <li className="px-3 py-1.5 text-muted">{t("noMatches")}</li>
          )}
          {data?.users.map((candidate) => (
            <li
              key={candidate.id}
              role="option"
              aria-selected={false}
              className="cursor-pointer px-3 py-1.5 hover:bg-muted/10"
              onMouseDown={(event) => {
                // Keep the input focused so this fires before the dropdown
                // closes on blur, then resolve the selection.
                event.preventDefault();
                onSelectCandidate?.(candidate);
                onChange(candidate.name ?? candidate.email ?? "");
                setIsOpen(false);
              }}
            >
              <span className="font-medium">{candidate.name ?? t("noName")}</span>
              {candidate.email && <span className="text-muted"> · {candidate.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
