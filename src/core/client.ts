import { fetchWidgetConfig, type WidgetConfigResponse } from "./config";
import {
  countQueued,
  getInstantClient,
  normalizeConfig,
  subscribeToWidget,
} from "./instant";
import { fetchOrgConfig, type OrgWidgetEntry } from "./org-config";
import {
  countQueuedFor,
  liveWidgetIdsFromSubscription,
  normalizeOrgWidgetConfig,
  subscribeToOrg,
  type OrgSubscribedOrg,
  type OrgSubscribedWidget,
} from "./org-instant";
import { LobbysideError } from "./errors";
import { evaluateTargeting, normalizeTargetingFilters } from "./targeting";
import { createTargetingContext } from "./targeting-context";

/**
 * Identity + copy fields the host configured. Available on both
 * `offline` and `online` states so you can still render "Sarup is
 * currently offline" with the avatar and host name, not just a blank
 * placeholder. Theming, meetLink, slug, and maxQueueSize are
 * deliberately not surfaced — consumers rendering their own UI bring
 * their own design tokens, and the internal plumbing (slug, queue
 * limits) is only used by joinCall under the hood.
 */
export interface WidgetIdentity {
  hostName: string;
  hostTitle: string;
  avatarUrl: string;
  ctaText: string;
  buttonText: string;
}

/**
 * Offline fallback surface — only meaningful when the host is offline,
 * so it's exposed only on the `offline` state. All three fields are
 * empty strings when the host hasn't configured them; render a backup
 * link by checking `offlineCtaUrl !== ""`.
 */
export interface OfflineFallback {
  /** Booking link the visitor should open when the host is offline. */
  offlineCtaUrl: string;
  /** Optional message shown above the booking button (e.g. "Out fishing, back tomorrow."). */
  offlineCtaText: string;
  /** Optional button label. Defaults to "Book a time" in the canonical widget. */
  offlineButtonText: string;
}

/**
 * Public state machine surfaced by useLobbyside. Discriminated by
 * `status`. Narrow on `status === "online"` before calling joinCall
 * or reading isQueueFull.
 */
export type LobbysideWidgetState =
  | { status: "loading" }
  | { status: "error"; error: LobbysideError }
  // The host's active cohort excludes this visitor (geo / session / path).
  // Render nothing — same outcome as the script-tag embed's targeting gate.
  | { status: "hidden" }
  | (WidgetIdentity & OfflineFallback & { status: "offline" })
  | (WidgetIdentity & {
      status: "online";
      isQueueFull: boolean;
      joinCall: (args?: {
        visitor?: Record<string, string>;
      }) => Promise<{ entryUrl: string }>;
    });

export interface LobbysideClient {
  getState(): LobbysideWidgetState;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

export interface CreateClientOptions {
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://lobbyside.com";

// Shared singleton so useSyncExternalStore sees an `===` snapshot whenever the
// state stays hidden across recomputes — a fresh object would churn renders.
const HIDDEN: LobbysideWidgetState = { status: "hidden" };

// A live `null` means the host cleared the cohort and must win over the (now
// stale) initial snapshot; a live `undefined` means a partial payload never
// carried the attribute, so fall back to initial rather than drop the cohort.
function resolveTargetingFiltersRaw(
  liveValue: unknown,
  initialValue: unknown,
): unknown {
  return liveValue !== undefined ? liveValue : initialValue;
}

interface TargetingRuntime {
  // True when the active cohort excludes this visitor → caller sets HIDDEN.
  // Arms a re-eval timer internally when blocked only by a session minimum.
  isHidden(
    filtersRaw: unknown,
    geo: { country: string | null } | null,
  ): boolean;
  destroy(): void;
}

// Wraps the journey context + retry timer so both the widget and org clients
// gate identically — a second hand-rolled copy is exactly the kind of drift
// this whole change exists to kill.
function createTargetingRuntime(rerender: () => void): TargetingRuntime {
  const ctx = createTargetingContext();
  let attached = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearRetry(): void {
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(ms?: number): void {
    clearRetry();
    if (ms && ms > 0) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        rerender();
      }, ms);
    }
  }

  return {
    isHidden(filtersRaw, geo) {
      const filters = normalizeTargetingFilters(filtersRaw);
      if (!filters) {
        clearRetry();
        return false;
      }
      if (!attached) {
        ctx.attach(rerender);
        attached = true;
      }
      const { currentPath, visitedPathnames } = ctx.snapshot();
      const decision = evaluateTargeting({
        filters,
        geo,
        sessionStartedAt: ctx.sessionStartedAt,
        currentPath,
        visitedPathnames,
        now: Date.now(),
      });
      scheduleRetry(decision.retryInMs);
      return !decision.allowed;
    },
    destroy() {
      clearRetry();
      ctx.destroy();
    },
  };
}

// Shared join-queue POST. Lives at module scope so both the widget-mode
// and org-mode clients hit identical request shape + error translation.
// Throws `LobbysideError` for every non-2xx path so the consumer's catch
// block is exhaustive on `err.code`.
async function fetchJoinCall(
  baseUrl: string,
  slug: string,
  visitor: Record<string, string> | undefined,
): Promise<{ entryUrl: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/queue-entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug,
        referrerUrl: typeof window !== "undefined" ? window.location.href : "",
        visitor,
      }),
    });
  } catch (err) {
    throw new LobbysideError(
      "NETWORK",
      `Failed to reach Lobbyside: ${(err as Error).message}`,
    );
  }

  if (res.status === 403) {
    throw new LobbysideError("INACTIVE", "Widget is not active.");
  }
  if (res.status === 404) {
    throw new LobbysideError("NOT_FOUND", "Widget not found.");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "queue_full") {
      throw new LobbysideError("QUEUE_FULL", "Queue is full.");
    }
    throw new LobbysideError(
      "NETWORK",
      `Join request failed with HTTP ${res.status}.`,
    );
  }

  const data = (await res.json()) as { entryUrl: string };
  return { entryUrl: data.entryUrl };
}


/**
 * Build a Lobbyside client for a given widget ID. Safe to call multiple
 * times for the same widgetId on the same page — but the hook memoizes
 * its client instance so we don't usually hit that path.
 */
export function createLobbysideClient(
  widgetId: string,
  options: CreateClientOptions = {},
): LobbysideClient {
  // Strip a trailing slash so concatenating `/api/...` below can't
  // produce `http://host.com//api/...` — most servers tolerate it
  // but some reverse proxies 404 on it.
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  let state: LobbysideWidgetState = { status: "loading" };
  let initial: WidgetConfigResponse | null = null;
  // Visitor geo only arrives on the HTTP snapshot (it's request-derived), so
  // it's captured once and reused on every targeting re-eval.
  let geo: { country: string | null } | null = null;
  let liveConfig: ReturnType<typeof normalizeConfig> = undefined;
  // slug is kept in closure — joinCall needs it to build the POST body,
  // but consumers don't need to see it (internal plumbing).
  let liveSlug: string | undefined = undefined;
  let queuedCount = 0;
  let unsubscribe: (() => void) | null = null;
  // Guards against the StrictMode double-mount race: destroy() can land
  // before the initial fetchWidgetConfig resolves. Without this flag, the
  // .then handler would still open a subscription on the singleton client,
  // and destroy() wouldn't know to close it — orphan listener, wasted
  // WebSocket traffic until the tab closes.
  let destroyed = false;
  const listeners = new Set<() => void>();

  function emit() {
    for (const l of listeners) l();
  }

  const targeting = createTargetingRuntime(() => {
    recompute();
    emit();
  });

  function recompute() {
    if (state.status === "error") return;

    // Merge HTTP snapshot + live subscription data.
    const config = liveConfig ?? initial?.displayData;
    const active = liveConfig?.isActive ?? initial?.active;
    if (initial == null || !config) {
      state = { status: "loading" };
      return;
    }

    const identity: WidgetIdentity = {
      hostName: config.hostName ?? "",
      hostTitle: config.hostTitle ?? "",
      avatarUrl: config.avatarUrl ?? "",
      ctaText: config.ctaText ?? "",
      buttonText: config.buttonText ?? "",
    };

    // Targeting gates before online/offline — an excluded visitor sees
    // nothing even when the host is paused, matching the embed's runRender.
    const targetingFiltersRaw = resolveTargetingFiltersRaw(
      liveConfig?.targetingFilters,
      initial.displayData.targetingFilters,
    );
    if (targeting.isHidden(targetingFiltersRaw, geo)) {
      state = HIDDEN;
      return;
    }

    if (!active) {
      const offline: OfflineFallback = {
        offlineCtaUrl: config.offlineCtaUrl ?? "",
        offlineCtaText: config.offlineCtaText ?? "",
        offlineButtonText: config.offlineButtonText ?? "",
      };
      state = { status: "offline", ...identity, ...offline };
      return;
    }

    const maxQueueSize = config.maxQueueSize ?? 5;
    const isQueueFull = queuedCount >= maxQueueSize;

    state = {
      status: "online",
      ...identity,
      isQueueFull,
      joinCall,
    };
  }

  async function joinCall(args?: {
    visitor?: Record<string, string>;
  }): Promise<{ entryUrl: string }> {
    // Client-side pre-checks. Avoid round-tripping when we already
    // know the request will be refused, and translate any ambiguity
    // into a typed error so the consumer's catch block is exhaustive.
    if (state.status !== "online") {
      throw new LobbysideError(
        "INACTIVE",
        "Widget is not online; cannot join queue.",
      );
    }
    if (state.isQueueFull) {
      throw new LobbysideError("QUEUE_FULL", "Queue is full.");
    }

    const slug = liveSlug ?? initial?.displayData.slug ?? "";
    return fetchJoinCall(baseUrl, slug, args?.visitor);
  }

  // Boot: fetch initial config, then open the subscription.
  fetchWidgetConfig(widgetId, baseUrl)
    .then((config) => {
      if (destroyed) return;
      initial = config;
      geo = config.geo ?? null;
      recompute();
      emit();

      const db = getInstantClient(config.instantAppId);
      const u = subscribeToWidget(db, widgetId, (widget) => {
        if (!widget) return;
        liveConfig = normalizeConfig(widget.widgetConfig);
        liveSlug = widget.slug;
        queuedCount = countQueued(widget.queueEntries);
        recompute();
        emit();
      });
      // Double-check: destroy() could have fired between the guard above
      // and subscribeToWidget resolving synchronously. If so, tear it
      // down immediately instead of leaking.
      if (destroyed) {
        u();
      } else {
        unsubscribe = u;
      }
    })
    .catch((err: LobbysideError) => {
      if (destroyed) return;
      state = { status: "error", error: err };
      emit();
    });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      targeting.destroy();
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Org-mode client. Surfaces the same `LobbysideClient` interface as the
// widget-mode factory above, so the hook can swap one for the other
// without forking the React plumbing.
//
// State machine differences from widget mode:
//   - No "offline" status. An org-mode "the host has it off" maps to the
//     `NO_LIVE_WIDGET` error code instead, because in org mode there's no
//     single widget identity to surface for an offline render — the org
//     install renders nothing if 0 widgets are live (matches the bundle).
//   - "MULTIPLE_LIVE_WIDGETS" is a new error code for the safety-net case
//     where the host left two widgets on at once (the bundle also renders
//     nothing here).
// ---------------------------------------------------------------------------

function widgetByIdIn(
  org: OrgSubscribedOrg | null,
  widgetId: string | null,
): OrgSubscribedWidget | undefined {
  if (!org?.widgets || !widgetId) return undefined;
  return org.widgets.find((w) => w.id === widgetId);
}

function entryByIdIn(
  entries: OrgWidgetEntry[] | undefined,
  widgetId: string | null,
): OrgWidgetEntry | undefined {
  if (!entries || !widgetId) return undefined;
  return entries.find((w) => w.widgetId === widgetId);
}

interface OrgLiveSnapshot {
  org: OrgSubscribedOrg | null;
  // The initial HTTP fetch's widgets list. Used as a fallback for
  // identity / queue size when the live subscription hasn't fired yet
  // (or doesn't carry those fields).
  initialWidgets: OrgWidgetEntry[] | null;
}

function identityForOrgWidget(
  widgetId: string,
  snapshot: OrgLiveSnapshot,
): WidgetIdentity {
  const live = widgetByIdIn(snapshot.org, widgetId);
  const liveCfg = normalizeOrgWidgetConfig(live?.widgetConfig);
  const initial = entryByIdIn(snapshot.initialWidgets ?? undefined, widgetId);
  const display = initial?.displayData;
  return {
    hostName: liveCfg?.hostName ?? display?.hostName ?? "",
    hostTitle: liveCfg?.hostTitle ?? display?.hostTitle ?? "",
    avatarUrl: liveCfg?.avatarUrl ?? display?.avatarUrl ?? "",
    ctaText: liveCfg?.ctaText ?? display?.ctaText ?? "",
    buttonText: liveCfg?.buttonText ?? display?.buttonText ?? "",
  };
}

function slugForOrgWidget(
  widgetId: string,
  snapshot: OrgLiveSnapshot,
): string {
  const live = widgetByIdIn(snapshot.org, widgetId);
  if (live?.slug) return live.slug;
  return entryByIdIn(snapshot.initialWidgets ?? undefined, widgetId)?.slug ?? "";
}

function maxQueueSizeForOrgWidget(
  widgetId: string,
  snapshot: OrgLiveSnapshot,
): number {
  const liveCfg = normalizeOrgWidgetConfig(
    widgetByIdIn(snapshot.org, widgetId)?.widgetConfig,
  );
  if (typeof liveCfg?.maxQueueSize === "number") return liveCfg.maxQueueSize;
  const initial = entryByIdIn(snapshot.initialWidgets ?? undefined, widgetId);
  return initial?.displayData.maxQueueSize ?? 5;
}

function queuedCountForOrgWidget(
  widgetId: string,
  snapshot: OrgLiveSnapshot,
): number {
  const live = widgetByIdIn(snapshot.org, widgetId);
  return live ? countQueuedFor(live) : 0;
}

function targetingFiltersForOrgWidget(
  widgetId: string,
  snapshot: OrgLiveSnapshot,
): unknown {
  const live = widgetByIdIn(snapshot.org, widgetId);
  const liveCfg = normalizeOrgWidgetConfig(live?.widgetConfig);
  const initialFilters = entryByIdIn(
    snapshot.initialWidgets ?? undefined,
    widgetId,
  )?.displayData.targetingFilters;
  return resolveTargetingFiltersRaw(liveCfg?.targetingFilters, initialFilters);
}

/**
 * Build a Lobbyside client for an org. Renders whichever single widget
 * under the org the host has currently switched on, mirroring the
 * script-tag bundle's org-mode behaviour. Safe to call multiple times
 * for the same orgId — but the hook memoizes its client instance so we
 * don't usually hit that path.
 */
export function createLobbysideOrgClient(
  orgId: string,
  options: CreateClientOptions = {},
): LobbysideClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  let state: LobbysideWidgetState = { status: "loading" };
  const snapshot: OrgLiveSnapshot = { org: null, initialWidgets: null };
  // Org geo is org-level on the HTTP snapshot, static for the client lifetime.
  let geo: { country: string | null } | null = null;
  let unsubscribe: (() => void) | null = null;
  let destroyed = false;
  const listeners = new Set<() => void>();

  function emit() {
    for (const l of listeners) l();
  }

  const targeting = createTargetingRuntime(() => {
    recompute();
    emit();
  });

  // Picks the active widget from the live subscription if it's loaded;
  // otherwise falls back to the initial HTTP snapshot. This lets the
  // first paint be correct even before the first InstantDB tick lands.
  function pickActive(): string[] {
    if (snapshot.org) return liveWidgetIdsFromSubscription(snapshot.org);
    return (snapshot.initialWidgets ?? [])
      .filter((w) => w.active)
      .map((w) => w.widgetId);
  }

  function recompute() {
    if (state.status === "error" && state.error.code === "NETWORK") return;
    if (snapshot.initialWidgets == null && snapshot.org == null) {
      state = { status: "loading" };
      return;
    }

    const active = pickActive();
    if (active.length === 0) {
      // Bail before constructing a fresh LobbysideError so that
      // useSyncExternalStore sees an `===` snapshot when the
      // 0-live-widgets condition just persists. Without this guard the
      // hook would emit a new error object on every InstantDB tick and
      // force a re-render in consumers.
      if (state.status === "error" && state.error.code === "NO_LIVE_WIDGET")
        return;
      state = {
        status: "error",
        error: new LobbysideError(
          "NO_LIVE_WIDGET",
          "No widget in this org is currently live.",
        ),
      };
      return;
    }
    if (active.length > 1) {
      // Same referential-equality guard as the 0-live case above.
      if (
        state.status === "error" &&
        state.error.code === "MULTIPLE_LIVE_WIDGETS"
      )
        return;
      state = {
        status: "error",
        error: new LobbysideError(
          "MULTIPLE_LIVE_WIDGETS",
          `${active.length} widgets in this org are live; the org-wide install renders nothing until exactly one is on.`,
        ),
      };
      return;
    }

    const widgetId = active[0];
    if (targeting.isHidden(targetingFiltersForOrgWidget(widgetId, snapshot), geo)) {
      state = HIDDEN;
      return;
    }
    const identity = identityForOrgWidget(widgetId, snapshot);
    const queuedCount = queuedCountForOrgWidget(widgetId, snapshot);
    const maxQueueSize = maxQueueSizeForOrgWidget(widgetId, snapshot);
    const isQueueFull = queuedCount >= maxQueueSize;

    state = {
      status: "online",
      ...identity,
      isQueueFull,
      joinCall: buildJoinCall(widgetId),
    };
  }

  function buildJoinCall(widgetId: string) {
    return async function joinCall(args?: {
      visitor?: Record<string, string>;
    }): Promise<{ entryUrl: string }> {
      if (state.status !== "online") {
        throw new LobbysideError(
          "INACTIVE",
          "No widget in this org is currently live; cannot join queue.",
        );
      }
      if (state.isQueueFull) {
        throw new LobbysideError("QUEUE_FULL", "Queue is full.");
      }
      const slug = slugForOrgWidget(widgetId, snapshot);
      return fetchJoinCall(baseUrl, slug, args?.visitor);
    };
  }

  fetchOrgConfig(orgId, baseUrl)
    .then((config) => {
      if (destroyed) return;
      snapshot.initialWidgets = config.widgets;
      geo = config.geo ?? null;
      recompute();
      emit();

      const instantClient = getInstantClient(config.instantAppId);
      const u = subscribeToOrg(instantClient, orgId, (org) => {
        if (destroyed) return;
        snapshot.org = org ?? null;
        recompute();
        emit();
      });
      if (destroyed) {
        u();
      } else {
        unsubscribe = u;
      }
    })
    .catch((err: LobbysideError) => {
      if (destroyed) return;
      state = { status: "error", error: err };
      emit();
    });

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      destroyed = true;
      targeting.destroy();
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
    },
  };
}
