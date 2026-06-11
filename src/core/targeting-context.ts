// Visitor-journey signals for targeting: session start, current path, and the
// set of paths visited this session. Mirrors the path/session inputs the
// script-tag bundle feeds `evaluateTargeting`. Intentionally lighter than
// `visitor-presence-timeline` (no titles, no heartbeat body) — `useLobbyside`
// only needs the targeting inputs, not the host-facing Live-tab journey.

import { subscribeToNavigation } from "./history-nav";

const VISITED_PATHS_CAP = 50;
// SPA route changes fire several history events in a row — coalesce.
const NAV_DEBOUNCE_MS = 200;

function currentPathname(): string {
  return typeof window !== "undefined" ? window.location.pathname : "/";
}

export interface TargetingContext {
  readonly sessionStartedAt: number;
  /** Live snapshot of the path inputs `evaluateTargeting` reads. */
  snapshot(): { currentPath: string; visitedPathnames: string[] };
  /**
   * Register a callback fired on each real route change so the caller can
   * re-evaluate targeting. The journey itself is tracked from construction
   * (not from this call), so visited-page rules match the embed even for hops
   * that happen before the first cohort evaluation. `destroy()` unsubscribes.
   */
  attach(onNavigate: () => void): void;
  destroy(): void;
}

export function createTargetingContext(): TargetingContext {
  const sessionStartedAt = Date.now();
  let pathname = currentPathname();
  const visited: string[] = [pathname];

  let navUnsub: (() => void) | null = null;
  let notify: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function pushPath(next: string): void {
    pathname = next;
    if (!visited.includes(next)) {
      visited.push(next);
      while (visited.length > VISITED_PATHS_CAP) visited.shift();
    }
  }

  function syncLocation(): void {
    const next = currentPathname();
    if (next !== pathname) pushPath(next);
  }

  function snapshot(): { currentPath: string; visitedPathnames: string[] } {
    syncLocation();
    return { currentPath: pathname, visitedPathnames: [...visited] };
  }

  function handleNav(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const next = currentPathname();
      if (next === pathname) return;
      pushPath(next);
      notify?.();
    }, NAV_DEBOUNCE_MS);
  }

  // Track the journey from construction — not from the first cohort eval — so
  // route changes during the config-fetch window still land in `visited`.
  if (typeof window !== "undefined") {
    navUnsub = subscribeToNavigation(handleNav);
  }

  function attach(onNavigate: () => void): void {
    notify = onNavigate;
  }

  function destroy(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    notify = null;
    try {
      navUnsub?.();
    } catch {
      // best-effort
    }
    navUnsub = null;
  }

  return {
    get sessionStartedAt() {
      return sessionStartedAt;
    },
    snapshot,
    attach,
    destroy,
  };
}
