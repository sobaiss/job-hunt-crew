"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { bff } from "@/lib/bff-client";

/**
 * A French region or department, as Location resolution (#215) read it from
 * a free-text `location`. The table lives in services' py-db.
 */
export type ResolvedLocation = {
  kind: "region" | "departement";
  code: string;
  label: string;
};

// Wait for the candidate to stop typing before asking.
const DEBOUNCE_MS = 300;

/**
 * Whether `text` names a French region or department: the location, `null`
 * when it names neither, `undefined` until known or when not `enabled`.
 */
export function useLocationResolution(text: string, enabled: boolean) {
  const trimmed = text.trim();
  const [settled, setSettled] = useState(trimmed);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed]);

  const query = useQuery({
    queryKey: ["location-resolution", settled],
    queryFn: () =>
      bff.get<{ location: ResolvedLocation | null }>(
        `/locations/resolve?q=${encodeURIComponent(settled)}`,
      ),
    select: (data) => data.location,
    enabled: enabled && settled !== "" && settled === trimmed,
  });
  return enabled && settled === trimmed ? query.data : undefined;
}
