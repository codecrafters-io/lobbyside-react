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
//      and `origin`. Powers the host's "N visitors live" pill across the
//      dashboard. Carrying no PII means no leak through this back door.
//
//   3. `widgetActiveHosts:${widgetId}:_hosts` — shared, presence-only.
//      The visitor SUBSCRIBES (no publish); the host PUBLISHES with
//      `kind: "host"`. Used as a gate for the directory heartbeat so we
//      don't PUT to `/live-tabs/${tabId}` when no host is looking.
//
// Renaming any suffix here needs the matching rename on the host side
// (`use-live-visitors.ts`, `use-visitor-counter.ts`,
// `use-host-presence-broadcast.ts`) — otherwise host and visitor land in
// different rooms and the pill / Live table go silent.

const DIRECTORY_HEARTBEAT_MS = 30_000;
// Anti-stampede: spread the initial PUTs of N concurrent visitors over a
// small window so a customer with a busy site doesn't pummel the edge
// route the instant a host opens Live. Subsequent PUTs are spaced by the
// heartbeat cadence; the jitter naturally desynchronises them across the
// visitor population for the lifetime of the host session.
const INITIAL_JITTER_MS = 2_000;

const COUNTER_ROOM_ID_SUFFIX = ":_counter";
const ACTIVE_HOSTS_ROOM_ID_SUFFIX = ":_hosts";

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

// `subscribePresence` is not on the publicly-typed Room surface, but
// every actual room handle has it at runtime. Cast at the single point
// where we need it (`attachActiveHostsListener`) rather than widening
// `InstantRoom`.
type SubscribePresenceArg = (slice: {
  peers?: Record<string, Record<string, unknown>>;
}) => void;

interface RoomWithSubscribePresence extends InstantRoom {
  subscribePresence(opts: unknown, cb: SubscribePresenceArg): () => void;
}

function hostPresentIn(
  peers: Record<string, Record<string, unknown>> | undefined,
): boolean {
  if (!peers) return false;
  for (const p of Object.values(peers)) {
    if (p && (p as { kind?: unknown }).kind === "host") return true;
  }
  return false;
}

function attachActiveHostsListener(
  db: RoomCapableDb,
  widgetId: string,
  onChange: (hostPresent: boolean) => void,
): { room: InstantRoom | null; unsub: (() => void) | null } {
  // Pure-subscriber join: we don't `publish` here, so our peer is
  // ignored by the `kind === "host"` filter on the receiving side.
  let room: InstantRoom;
  try {
    room = db.joinRoom(
      "widgetActiveHosts",
      `${widgetId}${ACTIVE_HOSTS_ROOM_ID_SUFFIX}`,
      { initialPresence: {} },
    );
  } catch {
    // Join failure: gate stays closed. The widget keeps working (per-tab
    // room, invites) but doesn't appear in the host's Live table. Better
    // than flooding the endpoint from clients we can't observe.
    return { room: null, unsub: null };
  }

  try {
    const unsub = (
      room as unknown as RoomWithSubscribePresence
    ).subscribePresence({ keys: ["kind"] }, (slice) => {
      onChange(hostPresentIn(slice.peers));
    });
    return { room, unsub };
  } catch {
    // subscribePresence failed AFTER joinRoom succeeded — clean up the
    // room we successfully joined to avoid leaking the presence entry
    // and WebSocket resources. Without this, every subscribe failure
    // would leave a phantom peer in the active-hosts room until the
    // tab closes.
    try {
      room.leaveRoom();
    } catch {
      // best-effort
    }
    return { room: null, unsub: null };
  }
}

interface HeartbeatHandle {
  stop: () => void;
  releaseOnUnload: () => void;
}

function startGatedDirectoryHeartbeat(args: {
  db: RoomCapableDb;
  baseUrl: string;
  widgetId: string;
  tabId: string;
  // When `false`, the heartbeat appends `?ice=0` so the server-side row
  // gets `incomingCallsEnabled: false`. The outbound-call route reads
  // this row and refuses to dial tabs that opted out (the host UI also
  // disables the Call button via presence — this is the belt-and-braces
  // server guard for the case where a stale UI tries anyway).
  // Default is `true` (omit the query) for backward compatibility with
  // the script-tag bundle and existing SDK consumers.
  incomingCallsEnabled?: boolean;
}): HeartbeatHandle {
  const { db, baseUrl, widgetId, tabId, incomingCallsEnabled } = args;
  const baseHeartbeatUrl = `${baseUrl}/api/widget/${encodeURIComponent(
    widgetId,
  )}/live-tabs/${encodeURIComponent(tabId)}`;
  const url =
    incomingCallsEnabled === false
      ? `${baseHeartbeatUrl}?ice=0`
      : baseHeartbeatUrl;

  let timer: ReturnType<typeof setInterval> | null = null;
  let jitterTimer: ReturnType<typeof setTimeout> | null = null;
  // Tracks whether the server has a row for us. Drives release(): if we
  // never PUT, the DELETE on host-leave / pagehide / destroy is a wasted
  // request, so we skip it.
  let hasFiredAny = false;
  let activeHostsRoom: InstantRoom | null = null;
  let unsubActiveHosts: (() => void) | null = null;

  function ping(): void {
    if (typeof fetch !== "function") return;
    try {
      fetch(url, { method: "PUT", keepalive: true }).catch(() => {
        // Silent: the host re-checks freshness on the next heartbeat.
      });
    } catch {
      // Sandboxed iframe with fetch disabled / ancient envs: accept the
      // row will TTL out client-side on the host.
    }
  }

  function release(): void {
    if (!hasFiredAny) return;
    if (typeof fetch !== "function") return;
    // `keepalive: true` lets the DELETE survive `pagehide`. sendBeacon
    // would also work but is POST-only and this route uses method
    // semantics. The host's grace window is the safety net if neither
    // path lands.
    try {
      fetch(url, { method: "DELETE", keepalive: true }).catch(() => {});
    } catch {
      // best-effort
    }
  }

  function startHeartbeat(): void {
    if (timer !== null || jitterTimer !== null) return; // already armed
    if (typeof window === "undefined") return;
    const initialDelayMs = Math.floor(Math.random() * INITIAL_JITTER_MS);
    jitterTimer = setTimeout(() => {
      jitterTimer = null;
      ping();
      hasFiredAny = true;
      timer = setInterval(ping, DIRECTORY_HEARTBEAT_MS);
    }, initialDelayMs);
  }

  function stopHeartbeat(opts: { releaseRow: boolean }): void {
    if (jitterTimer !== null) {
      clearTimeout(jitterTimer);
      jitterTimer = null;
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (opts.releaseRow && hasFiredAny) {
      release();
      hasFiredAny = false;
    }
  }

  const attached = attachActiveHostsListener(db, widgetId, (present) => {
    if (present) startHeartbeat();
    else stopHeartbeat({ releaseRow: true });
  });
  activeHostsRoom = attached.room;
  unsubActiveHosts = attached.unsub;

  const onPageHide = () => release();
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
  }

  return {
    stop: () => {
      // Don't release here — `destroy()` in the bundle calls
      // releaseOnUnload right after, so this would double-DELETE.
      stopHeartbeat({ releaseRow: false });
      try {
        unsubActiveHosts?.();
      } catch {
        // best-effort
      }
      try {
        activeHostsRoom?.leaveRoom();
      } catch {
        // best-effort
      }
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
   * timers, unsubscribe `widgetActiveHosts`) + `releaseOnUnload` (DELETE
   * the directory row if we ever PUT) + leaving the visitor / counter
   * rooms.
   */
  destroy: () => void;
}

/**
 * Mount the full visitor-presence stack for a single widget. Mirrors
 * what the script-tag bundle does in `startVisitorPresence` (minus the
 * navigation tracker — that's targeting-filter machinery the headless
 * SDK doesn't need yet).
 *
 * Order matters: visitor room first (so the host's per-tab subscription
 * has someone to discover), counter room (so the pill increments), then
 * the gated heartbeat. The heartbeat is silent until a host shows up in
 * `widgetActiveHosts`, at which point it PUTs the directory row and
 * keeps it fresh.
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
  const heartbeat = startGatedDirectoryHeartbeat({
    db: args.db,
    baseUrl: args.baseUrl,
    widgetId: args.widgetId,
    tabId: args.tabId,
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
