// Shared visitor-presence room machinery. Mirrors the script-tag bundle
// (src/widget/_init/visitor-presence.ts +
// src/widget/_init/directory-heartbeat.ts) so a host's Live tab sees SDK
// consumers the same way it sees bundle-installed visitors.
//
// Three rooms per widget:
//   1. `widgetVisitors:${widgetId}:${tabId}` — per-tab presence with full
//      visitor PII. Each visitor is alone with the host that has
//      explicitly subscribed to *this* tab. Previously this used a bare
//      `widgetId` room id, which fanned every visitor's name/email/path
//      to every other visitor on the page (the bug fixed in the
//      `052aee1` series).
//
//   2. `widgetVisitorCounter:${widgetId}:_counter` — shared, only `kind`
//      and `origin`. Carrying no PII means no leak through this back door.
//
// The directory heartbeat (PUT /live-tabs/${tabId}) runs unconditionally and
// carries the rich visitor body (path, journey, identity), mirroring the
// script-tag reporter; the host reads the rows by polling, so there is no gate.

const DIRECTORY_HEARTBEAT_MS = 30_000;
// Anti-stampede: spread the initial PUTs of N concurrent visitors over a
// small window so a customer with a busy site doesn't pummel the edge
// route the instant a host opens Live. Subsequent PUTs are spaced by the
// heartbeat cadence; the jitter naturally desynchronises them across the
// visitor population for the lifetime of the host session.
const INITIAL_JITTER_MS = 2_000;

const COUNTER_ROOM_ID_SUFFIX = ":_counter";

// Loose subset of @instantdb/core's Room API. We type only what the SDK
// actually uses so a future @instantdb/core minor bump that adds methods
// stays type-stable.
export interface InstantRoom {
  subscribeTopic(name: string, cb: (event: unknown) => void): () => void;
  publishTopic(name: string, payload: unknown): void;
  publishPresence(presence: Record<string, unknown>): void;
  leaveRoom(): void;
}

export interface RoomCapableDb {
  joinRoom(
    type: string,
    id: string,
    opts: { initialPresence?: Record<string, unknown> },
  ): InstantRoom;
}

interface HeartbeatHandle {
  stop: () => void;
  releaseOnUnload: () => void;
}

// Reports this tab's presence as a server row on an interval, carrying the rich
// visitor body so the host's Live table shows path + journey + identity.
function startDirectoryHeartbeat(args: {
  baseUrl: string;
  widgetId: string;
  tabId: string;
  // Rich heartbeat payload (origin, pathname, visitedPaths, identity); the
  // server backfills geo from edge headers. Sanitized server-side.
  body: Record<string, unknown>;
  // When `false`, append `?ice=0` so the row records incoming calls disabled.
  incomingCallsEnabled?: boolean;
}): HeartbeatHandle {
  const { baseUrl, widgetId, tabId, body, incomingCallsEnabled } = args;
  const baseHeartbeatUrl = `${baseUrl}/api/widget/${encodeURIComponent(
    widgetId,
  )}/live-tabs/${encodeURIComponent(tabId)}`;
  const url =
    incomingCallsEnabled === false
      ? `${baseHeartbeatUrl}?ice=0`
      : baseHeartbeatUrl;

  let timer: ReturnType<typeof setInterval> | null = null;
  let jitterTimer: ReturnType<typeof setTimeout> | null = null;
  // Drives release(): if we never PUT, the DELETE is a wasted request.
  let hasFiredAny = false;

  function ping(): void {
    if (typeof fetch !== "function") return;
    try {
      fetch(url, {
        method: "PUT",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {
        // Silent: the host re-checks freshness on the next heartbeat.
      });
    } catch {
      // Sandboxed iframe with fetch disabled — host's stale-row filter copes.
    }
  }

  function release(): void {
    if (!hasFiredAny) return;
    if (typeof fetch !== "function") return;
    // `keepalive: true` lets the DELETE survive `pagehide`.
    try {
      fetch(url, { method: "DELETE", keepalive: true }).catch(() => {});
    } catch {
      // best-effort
    }
  }

  function stopTimers(): void {
    if (jitterTimer !== null) {
      clearTimeout(jitterTimer);
      jitterTimer = null;
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  if (typeof window !== "undefined") {
    // Anti-stampede jitter on the first PUT; steady cadence thereafter.
    const initialDelayMs = Math.floor(Math.random() * INITIAL_JITTER_MS);
    jitterTimer = setTimeout(() => {
      jitterTimer = null;
      ping();
      hasFiredAny = true;
      timer = setInterval(ping, DIRECTORY_HEARTBEAT_MS);
    }, initialDelayMs);
  }

  const onPageHide = () => release();
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
  }

  return {
    stop: () => {
      // Don't release here — `destroy()` calls releaseOnUnload right after.
      stopTimers();
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
      }
    },
    releaseOnUnload: release,
  };
}

function joinCounterRoom(
  db: RoomCapableDb,
  widgetId: string,
  origin: string,
): InstantRoom | null {
  try {
    // Only `{ kind, origin }` is published — no tabId, no name/email.
    // Broadcasting tabIds in this shared room would re-leak the per-tab
    // address (anyone listening could dial any visitor); see the schema
    // comment in the lobbyside repo for the full reasoning.
    return db.joinRoom(
      "widgetVisitorCounter",
      `${widgetId}${COUNTER_ROOM_ID_SUFFIX}`,
      {
        initialPresence: {
          kind: "visitor",
          ...(origin ? { origin } : {}),
        },
      },
    );
  } catch {
    return null;
  }
}

function joinVisitorRoom(
  db: RoomCapableDb,
  widgetId: string,
  tabId: string,
  initialPresence: Record<string, unknown>,
): InstantRoom | null {
  try {
    return db.joinRoom("widgetVisitors", `${widgetId}:${tabId}`, {
      initialPresence,
    });
  } catch {
    return null;
  }
}

export interface AttachVisitorRoomsArgs {
  db: RoomCapableDb;
  baseUrl: string;
  widgetId: string;
  tabId: string;
  initialPresence: Record<string, unknown>;
  origin: string;
  // Forwarded into the per-tab presence record AND the directory
  // heartbeat URL (`?ice=0`) when `false`. Default `true`. See
  // `startGatedDirectoryHeartbeat` for the server-guard rationale.
  incomingCallsEnabled?: boolean;
}

export interface VisitorRoomBundle {
  /**
   * Per-tab presence room. Consumers publish visitor identity updates
   * here (the call-client does this on `setVisitor`).
   */
  visitorRoom: InstantRoom | null;
  /**
   * Shared "any visitor present?" room. Consumers don't typically need
   * to touch this — it's joined for its side effect (incrementing the
   * host's pill count).
   */
  counterRoom: InstantRoom | null;
  /**
   * Tear everything down. Idempotent. Combines `stop` (clear heartbeat
   * timers) + `releaseOnUnload` (DELETE the directory row if we ever PUT)
   * + leaving the visitor / counter rooms.
   */
  destroy: () => void;
}

/**
 * Mount the full visitor-presence stack for a single widget. Mirrors
 * what the script-tag bundle does in `startVisitorPresence` (minus the
 * navigation tracker — that's targeting-filter machinery the headless
 * SDK doesn't need yet).
 *
 * Order: visitor room first (so the host's per-tab subscription has
 * someone to discover), counter room, then the directory heartbeat —
 * which PUTs the rich row immediately and keeps it fresh, ungated.
 */
export function attachVisitorRooms(
  args: AttachVisitorRoomsArgs,
): VisitorRoomBundle {
  // Bake `incomingCallsEnabled` into the per-tab presence so the host's
  // Live table can render "Incoming calls disabled" on the Call button
  // without needing a separate DB query. Default `true` matches every
  // legacy SDK consumer + script-tag bundle visitor.
  const incomingCallsEnabled = args.incomingCallsEnabled !== false;
  const initialPresence: Record<string, unknown> = {
    ...args.initialPresence,
    incomingCallsEnabled,
  };
  const visitorRoom = joinVisitorRoom(
    args.db,
    args.widgetId,
    args.tabId,
    initialPresence,
  );
  const counterRoom = joinCounterRoom(args.db, args.widgetId, args.origin);
  const heartbeat = startDirectoryHeartbeat({
    baseUrl: args.baseUrl,
    widgetId: args.widgetId,
    tabId: args.tabId,
    body: args.initialPresence,
    incomingCallsEnabled,
  });

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    // Stop heartbeat timers first so an in-flight tick can't race with
    // `releaseOnUnload`'s DELETE.
    try {
      heartbeat.stop();
    } catch {}
    try {
      heartbeat.releaseOnUnload();
    } catch {}
    try {
      visitorRoom?.leaveRoom();
    } catch {}
    try {
      counterRoom?.leaveRoom();
    } catch {}
  }

  return { visitorRoom, counterRoom, destroy };
}
