import type { VisitorPrefillData } from "./visitor-prefill";

// Mirrors the script-tag bundle's visitor-presence so SDK rows are first-class
// on the host's Live list: a stable session anchor, the browser timezone, and a
// growing journey. Without the timezone the host shows "Time zone not shared
// yet"; without the stable anchor an org-mode rebind (host going live) would
// reset every visitor to "0s on site".

const VISITED_PATHS_CAP = 50;
// SPA route changes fire several history events in a row — coalesce into one PUT.
const NAV_DEBOUNCE_MS = 400;
// SPAs set document.title after pushState; re-publish once it settles.
const TITLE_SETTLE_MS = 250;

interface VisitedPathEntry {
  path: string;
  title: string;
  enteredAt: number;
}

function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

function currentPathname(): string {
  return typeof window !== "undefined" ? window.location.pathname : "/";
}

function currentTitle(): string {
  return typeof document !== "undefined" ? document.title : "";
}

export interface PresenceTimeline {
  // Full heartbeat body for an (re)attach. Reuses the preserved session/page
  // anchors + journey so org rebinds don't reset the visitor's reported tenure.
  buildBody(visitor: VisitorPrefillData | undefined): Record<string, unknown>;
  // Patches history + nav listeners; emits a heartbeat diff on each real
  // navigation. Idempotent; `destroy()` restores the originals.
  trackNavigation(onChange: (diff: Record<string, unknown>) => void): void;
  destroy(): void;
}

export function createPresenceTimeline(tabId: string): PresenceTimeline {
  const sessionStartedAt = Date.now();
  const origin = typeof window !== "undefined" ? window.location.hostname : "";
  const referrer = typeof document !== "undefined" ? document.referrer : "";
  const timezone = getBrowserTimezone();

  let pathname = currentPathname();
  let pageTitle = currentTitle();
  let pageEnteredAt = sessionStartedAt;
  const visitedPaths: VisitedPathEntry[] = [
    { path: pathname, title: pageTitle, enteredAt: sessionStartedAt },
  ];

  let detach: (() => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let titleTimer: ReturnType<typeof setTimeout> | null = null;

  function snapshotPaths(): VisitedPathEntry[] {
    return visitedPaths.map((e) => ({ ...e }));
  }

  function pushPath(next: string): void {
    pathname = next;
    pageTitle = currentTitle();
    pageEnteredAt = Date.now();
    visitedPaths.push({ path: next, title: pageTitle, enteredAt: pageEnteredAt });
    while (visitedPaths.length > VISITED_PATHS_CAP) visitedPaths.shift();
  }

  // Nav hooks only arm after the async config fetch — catch any route change
  // that landed in that gap so the first attach body isn't stuck on boot path.
  function syncLocation(): void {
    const next = currentPathname();
    if (next !== pathname) pushPath(next);
  }

  function buildBody(
    visitor: VisitorPrefillData | undefined,
  ): Record<string, unknown> {
    syncLocation();
    return {
      kind: "visitor",
      origin,
      tabId,
      pathname,
      pageTitle,
      pageEnteredAt,
      sessionStartedAt,
      referrer,
      timezone,
      visitedPaths: snapshotPaths(),
      // Always present, even when empty, so `setVisitor` updates stay shape-
      // compatible with the initial join (host falls back to anonymous).
      visitorName: visitor?.name ?? "",
      visitorEmail: visitor?.email ?? "",
    };
  }

  function journeyDiff(): Record<string, unknown> {
    return { pathname, pageTitle, pageEnteredAt, visitedPaths: snapshotPaths() };
  }

  function clearTitleTimer(): void {
    if (titleTimer !== null) {
      clearTimeout(titleTimer);
      titleTimer = null;
    }
  }

  function recordNavigation(onChange: (diff: Record<string, unknown>) => void): void {
    const next = currentPathname();
    if (next === pathname) {
      clearTitleTimer();
      titleTimer = setTimeout(() => {
        pageTitle = currentTitle();
        onChange({ pageTitle });
      }, TITLE_SETTLE_MS);
      return;
    }
    pushPath(next);
    onChange(journeyDiff());
    clearTitleTimer();
    titleTimer = setTimeout(() => {
      const last = visitedPaths[visitedPaths.length - 1];
      pageTitle = currentTitle();
      if (last) last.title = pageTitle;
      onChange(journeyDiff());
    }, TITLE_SETTLE_MS);
  }

  function trackNavigation(
    onChange: (diff: Record<string, unknown>) => void,
  ): void {
    if (typeof window === "undefined" || detach) return;
    const fire = (): void => {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        recordNavigation(onChange);
      }, NAV_DEBOUNCE_MS);
    };
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function patchedPush(this: History, ...args) {
      const ret = origPush.apply(this, args as Parameters<typeof origPush>);
      queueMicrotask(fire);
      return ret;
    };
    history.replaceState = function patchedReplace(this: History, ...args) {
      const ret = origReplace.apply(this, args as Parameters<typeof origReplace>);
      queueMicrotask(fire);
      return ret;
    };
    window.addEventListener("popstate", fire);
    window.addEventListener("hashchange", fire);
    detach = () => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener("popstate", fire);
      window.removeEventListener("hashchange", fire);
    };
  }

  function destroy(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    clearTitleTimer();
    try {
      detach?.();
    } catch {
      // best-effort
    }
    detach = null;
  }

  return { buildBody, trackNavigation, destroy };
}
