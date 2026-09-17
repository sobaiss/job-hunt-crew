import { useCallback, useEffect, useState } from "react";

import {
  defaultColumnVisibility,
  resetColumnVisibility,
  toggleColumn,
  type ColumnConfig,
  type ColumnVisibilityState,
} from "@/lib/column-visibility";

// localStorage-backed wrapper around lib/column-visibility.ts's pure state
// (#129), reused as-is by Analyses, CV versions, and Agents. SSR-safe via the
// same lazy-initializer pattern useMediaQuery uses: the real, possibly
// stored, value is only read in the browser, with the default (every
// hideable column visible) standing in until then. A stored blob predating a
// newly added hideable column simply leaves that column at its default
// (visible), since only keys actually present in `columns` are read back.
export function useColumnVisibility<Key extends string>(
  storageKey: string,
  columns: readonly ColumnConfig<Key>[],
) {
  const [state, setState] = useState<ColumnVisibilityState<Key>>(() => {
    if (typeof window === "undefined") return defaultColumnVisibility(columns);
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return defaultColumnVisibility(columns);
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const state = defaultColumnVisibility(columns);
      for (const column of columns) {
        if (column.hideable && typeof parsed[column.key] === "boolean") {
          state[column.key] = parsed[column.key] as boolean;
        }
      }
      return state;
    } catch {
      return defaultColumnVisibility(columns);
    }
  });

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  }, [storageKey, state]);

  const toggle = useCallback((key: Key) => {
    setState((current) => toggleColumn(current, key));
  }, []);

  const reset = useCallback(() => {
    setState(resetColumnVisibility(columns));
  }, [columns]);

  const isVisible = useCallback((key: Key) => state[key] !== false, [state]);

  return { toggle, reset, isVisible };
}
