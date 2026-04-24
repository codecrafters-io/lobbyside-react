import { fetchWidgetConfig, type WidgetConfigResponse } from "./config";
import {
  countQueued,
  getInstantClient,
  normalizeConfig,
  subscribeToWidget,
} from "./instant";
import { LobbysideError } from "./errors";

/**
 * Public state machine surfaced by useLobbyside. Discriminated by
 * `status` so consumers can't accidentally read `hostName` in the
 * loading state.
 */
export type LobbysideWidgetState =
  | { status: "loading" }
  | { status: "error"; error: LobbysideError }
  | { status: "offline" }
  | {
      status: "online";
      hostName: string;
      hostTitle: string;
      avatarUrl: string;
      ctaText: string;
      buttonText: string;
      isQueueFull: boolean;
      joinCall: (args?: {
        visitor?: Record<string, string>;
      }) => Promise<{ entryUrl: string }>;
      meetLink: string;
      slug: string;
      theme?: string;
      customBgColor?: string | null;
      customAccentColor?: string | null;
      boldFont?: string | null;
      maxQueueSize: number;
    };

export interface LobbysideClient {
  getState(): LobbysideWidgetState;
  subscribe(listener: () => void): () => void;
  destroy(): void;
}

export interface CreateClientOptions {
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://lobbyside.com";

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
  let liveConfig: ReturnType<typeof normalizeConfig> = undefined;
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

  function recompute() {
    if (state.status === "error") return;

    // Merge HTTP snapshot + live subscription data.
    const config = liveConfig ?? initial?.displayData;
    const active = liveConfig?.isActive ?? initial?.active;
    if (initial == null) {
      state = { status: "loading" };
      return;
    }
    if (!active || !config) {
      state = { status: "offline" };
      return;
    }

    const maxQueueSize = config.maxQueueSize ?? 5;
    const isQueueFull = queuedCount >= maxQueueSize;
    const slug = liveSlug ?? initial.displayData.slug;

    state = {
      status: "online",
      hostName: config.hostName ?? "",
      hostTitle: config.hostTitle ?? "",
      avatarUrl: config.avatarUrl ?? "",
      ctaText: config.ctaText ?? "",
      buttonText: config.buttonText ?? "",
      meetLink: config.meetLink ?? "",
      slug,
      theme: config.theme,
      customBgColor: config.customBgColor,
      customAccentColor: config.customAccentColor,
      boldFont: config.boldFont,
      maxQueueSize,
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

    const slug = state.slug;
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/queue-entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          referrerUrl: typeof window !== "undefined" ? window.location.href : "",
          visitor: args?.visitor,
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

  // Boot: fetch initial config, then open the subscription.
  fetchWidgetConfig(widgetId, baseUrl)
    .then((config) => {
      if (destroyed) return;
      initial = config;
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
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
    },
  };
}
