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
   * Subscribe to the shared nav source; fire `onNavigate` on each real route
   * change so the caller can re-evaluate targeting. Idempotent — only the
   * first call attaches. No-op without a DOM. `destroy()` unsubscribes.
   */
  attach(onNavigate: () => void): void;
  destroy(): void;
}

export function createTargetingContext(): TargetingContext {
  const sessionStartedAt = Date.now();
  let pathname = currentPathname();
  const visited: string[] = [pathname];

  let detach: (() => void) | null = null;
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

  function attach(onNavigate: () => void): void {
    if (typeof window === "undefined" || detach) return;
    const fire = (): void => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        const next = currentPathname();
        if (next === pathname) return;
        pushPath(next);
        onNavigate();
      }, NAV_DEBOUNCE_MS);
    };
    detach = subscribeToNavigation(fire);
  }

  function destroy(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    try {
      detach?.();
    } catch {
      // best-effort
    }
    detach = null;
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
