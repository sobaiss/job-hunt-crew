import { useSyncExternalStore } from "react";

// A minimal fake for `next/navigation`'s App Router hooks, backed by one
// module-level URL string plus a subscriber list — enough for pages that read
// `useSearchParams()`/`usePathname()` and write back via `useRouter().replace`
// to round-trip in a test, without a real Next.js router context (which
// vitest's jsdom environment doesn't provide). `useParams` stays static since
// no test so far needs a dynamic route param to change mid-test.
let currentUrl = "/";
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Sets the fake current URL and re-renders every subscribed hook. Call this
 *  from a test to start on a given URL — reset it in `beforeEach`/`afterEach`
 *  so state doesn't leak between tests in the same file. */
export function __setUrl(url: string) {
  currentUrl = url;
  notify();
}

export function __getUrl() {
  return currentUrl;
}

export function useRouter() {
  return {
    replace: (url: string) => __setUrl(url),
    push: (url: string) => __setUrl(url),
  };
}

export function usePathname() {
  const url = useSyncExternalStore(subscribe, () => currentUrl);
  return url.split("?")[0];
}

export function useSearchParams() {
  const url = useSyncExternalStore(subscribe, () => currentUrl);
  const queryIndex = url.indexOf("?");
  return new URLSearchParams(queryIndex >= 0 ? url.slice(queryIndex + 1) : "");
}

export function useParams() {
  return { id: "a1" };
}
