import { useEffect, useState } from "react";

// SSR-safe: the lazy initializer reads the real value on first render in the
// browser (and falls back to `false`, matching the server's lack of a
// viewport, when `window` isn't defined yet); the effect only subscribes to
// later changes rather than also setting the initial value, so it never
// triggers an extra synchronous render on mount.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);
    mql.addEventListener("change", listener);
    return () => mql.removeEventListener("change", listener);
  }, [query]);

  return matches;
}
