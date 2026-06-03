import { fetchWidgetConfig, type WidgetConfigResponse } from "./config";
import { getInstantClient } from "./instant";
import { fetchOrgConfig, type OrgConfigResponse } from "./org-config";
import {
  liveWidgetIdsFromSubscription,
  subscribeToOrg,
} from "./org-instant";
import { getOrCreateTabId } from "./tab-id";
import {
  encodeVisitorPrefillHash,
  type VisitorPrefillData,
} from "./visitor-prefill";
import {
  attachVisitorRooms,
  type InstantRoom,
  type RoomCapableDb,
  type VisitorRoomBundle,
} from "./visitor-rooms";

/**
 * Identity the host's Live tab can see. Setting these mirrors what
 * `window.Lobbyside.setVisitor(...)` does for the script-tag widget:
 * fills in name/email next to the visitor row so the host knows who
 * they're about to call, and pre-fills the call form on accept.
 */
export type VisitorIdentity = VisitorPrefillData;

/**
 * Shape of an active host→visitor invite. Mirrors `IncomingInvite` in
 * the main lobbyside repo. `slug` and `widgetId` come from the host's
 * invite payload; we trust the invite, not our own snapshot, because a
 * host who has moved between widgets between the queue render and the
 * Call click would otherwise dial the wrong slug.
 */
export interface IncomingInvitePayload {
  callId: string;
  hostName: string;
  hostAvatar?: string;
  widgetName: string;
  slug: string;
  sentAt: number;
  widgetId?: string;
}

export interface LobbysideIncomingCall {
  callId: string;
  hostName: string;
  hostAvatar: string;
  widgetName: string;
  sentAt: number;
  /**
   * MUST be called synchronously from the click handler. Returns the
   * call URL — the consumer then calls `window.open(callUrl, "_blank")`
   * (or sets `window.location.href = callUrl`) in the same handler. iOS
   * Safari blocks `window.open` if any await/async boundary sits
   * between the user gesture and the call.
   */
  accept: () => { callUrl: string };
  decline: () => void;
}

export type LobbysideIncomingCallState =
  | { status: "idle" }
  | { status: "ringing"; call: LobbysideIncomingCall };

export interface CreateIncomingCallClientOptions {
  baseUrl?: string;
  visitor?: VisitorIdentity;
  ringTimeoutMs?: number;
}

export interface LobbysideIncomingCallClient {
  getState(): LobbysideIncomingCallState;
  subscribe(listener: () => void): () => void;
  setVisitor(visitor: VisitorIdentity | undefined): void;
  destroy(): void;
}

const DEFAULT_BASE_URL = "https://lobbyside.com";
const DEFAULT_RING_TIMEOUT_MS = 30000;

function buildInitialPresence(
  tabId: string,
  visitor: VisitorIdentity | undefined,
): Record<string, unknown> {
  const now = Date.now();
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const title = typeof document !== "undefined" ? document.title : "";
  const origin = typeof window !== "undefined" ? window.location.hostname : "";
  const referrer = typeof document !== "undefined" ? document.referrer : "";
  return {
    kind: "visitor",
    origin,
    tabId,
    pathname: path,
    pageTitle: title,
    pageEnteredAt: now,
    sessionStartedAt: now,
    referrer,
    visitedPaths: [{ path, title, enteredAt: now }],
    // Always present, even when empty, so `setVisitor` updates stay shape-
    // compatible with the initial join (`""` and missing both fall back to
    // anonymous on the host via `visitorLabel`).
    visitorName: visitor?.name ?? "",
    visitorEmail: visitor?.email ?? "",
  };
}

function isPlainInvitePayload(value: unknown): value is IncomingInvitePayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.callId === "string" && typeof v.slug === "string";
}

// REST mirror covers the case where the host's tab closed before InstantDB
// delivered the "declined" topic. `tabId` is the proof-of-targeting check.
function mirrorDeclineRest(
  baseUrl: string,
  callId: string,
  tabId: string,
): void {
  if (typeof fetch !== "function") return;
  fetch(`${baseUrl}/api/calls/${callId}/decline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tabId }),
    keepalive: true,
  }).catch(() => {});
}

export function createLobbysideIncomingCallClient(
  widgetId: string,
  options: CreateIncomingCallClientOptions = {},
): LobbysideIncomingCallClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const ringTimeoutMs = options.ringTimeoutMs ?? DEFAULT_RING_TIMEOUT_MS;
  const tabId = getOrCreateTabId();

  let state: LobbysideIncomingCallState = { status: "idle" };
  let visitor: VisitorIdentity | undefined = options.visitor;
  // Captured fresh on every accept so a late visitor-prefill update made
  // between ring and click still lands in the call form.
  function currentVisitor(): VisitorIdentity | undefined {
    return visitor;
  }

  const listeners = new Set<() => void>();
  let destroyed = false;

  let visitorRoomBundle: VisitorRoomBundle | null = null;
  let inviteRoom: InstantRoom | null = null;
  let unsubInvite: (() => void) | null = null;
  let unsubCancelled: (() => void) | null = null;
  let ringTimer: ReturnType<typeof setTimeout> | null = null;

  function emit(): void {
    for (const l of listeners) l();
  }

  function clearRingTimer(): void {
    if (ringTimer != null) {
      clearTimeout(ringTimer);
      ringTimer = null;
    }
  }

  function setIdle(): void {
    clearRingTimer();
    state = { status: "idle" };
    emit();
  }

  function buildCallUrl(invite: IncomingInvitePayload): string {
    const hash = encodeVisitorPrefillHash(currentVisitor());
    return (
      `${baseUrl}/${invite.slug}/c/${invite.callId}?role=visitor` +
      (hash ? `#${hash}` : "")
    );
  }

  function acceptCurrent(invite: IncomingInvitePayload): { callUrl: string } {
    if (state.status !== "ringing" || state.call.callId !== invite.callId) {
      // Already resolved (timed out, cancelled, double-clicked). Still
      // return a URL so the consumer's window.open call doesn't no-op
      // silently — bouncing into the lobby is still better than nothing.
      return { callUrl: buildCallUrl(invite) };
    }
    // WS-only signal — if it drops, the host still observes accept via the
    // call-page presence join, so swallow the failure.
    try {
      inviteRoom?.publishTopic("accepted", { callId: invite.callId });
    } catch {}
    setIdle();
    return { callUrl: buildCallUrl(invite) };
  }

  function declineCurrent(
    invite: IncomingInvitePayload,
    reason?: string,
  ): void {
    if (state.status !== "ringing" || state.call.callId !== invite.callId) {
      return;
    }
    try {
      inviteRoom?.publishTopic("declined", {
        callId: invite.callId,
        ...(reason ? { reason } : {}),
      });
    } catch {}
    mirrorDeclineRest(baseUrl, invite.callId, tabId);
    setIdle();
  }

  function startRinging(invite: IncomingInvitePayload): void {
    clearRingTimer();
    state = {
      status: "ringing",
      call: {
        callId: invite.callId,
        hostName: invite.hostName ?? "",
        hostAvatar: invite.hostAvatar ?? "",
        widgetName: invite.widgetName ?? "",
        sentAt: typeof invite.sentAt === "number" ? invite.sentAt : Date.now(),
        accept: () => acceptCurrent(invite),
        decline: () => declineCurrent(invite),
      },
    };
    ringTimer = setTimeout(() => {
      if (state.status === "ringing" && state.call.callId === invite.callId) {
        declineCurrent(invite, "timeout");
      }
    }, ringTimeoutMs);
    emit();
  }

  function handleInvite(payload: unknown): void {
    if (!isPlainInvitePayload(payload)) return;
    if (payload.widgetId && payload.widgetId !== widgetId) return;
    // Rare: a second host dials us while the first is still ringing. Send a
    // decline for the previous so its call row doesn't sit stuck till timeout.
    if (state.status === "ringing" && state.call.callId !== payload.callId) {
      const prevCallId = state.call.callId;
      try {
        inviteRoom?.publishTopic("declined", {
          callId: prevCallId,
          reason: "superseded",
        });
      } catch {}
      mirrorDeclineRest(baseUrl, prevCallId, tabId);
    }
    startRinging(payload);
  }

  function handleCancelled(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const data = payload as { callId?: unknown };
    if (typeof data.callId !== "string") return;
    if (state.status !== "ringing" || state.call.callId !== data.callId) return;
    setIdle();
  }

  function attachRooms(config: WidgetConfigResponse): void {
    const db = getInstantClient(config.instantAppId) as unknown as RoomCapableDb;
    // Per-tab visitor room + shared counter room + gated heartbeat —
    // matches the script-tag bundle exactly so the host's Live tab sees
    // SDK consumers identically. The previous SDK joined a bare
    // `widgetVisitors:${widgetId}` room, which silently aliased the
    // legacy pre-`052aee1` shared room and re-leaked PII to every other
    // visitor on the customer's page.
    const origin =
      typeof window !== "undefined" ? window.location.hostname : "";
    visitorRoomBundle = attachVisitorRooms({
      db,
      baseUrl,
      widgetId,
      tabId,
      initialPresence: buildInitialPresence(tabId, visitor),
      origin,
    });
    try {
      inviteRoom = db.joinRoom("visitorInvites", tabId, {
        initialPresence: { kind: "visitor" },
      });
    } catch {
      inviteRoom = null;
    }
    if (!inviteRoom) return;
    // Subscribe attempts are isolated so a throw on one topic doesn't strand
    // the room handle — teardownRooms still needs to call leaveRoom on it.
    try {
      unsubInvite = inviteRoom.subscribeTopic("invite", handleInvite);
    } catch {}
    try {
      unsubCancelled = inviteRoom.subscribeTopic("cancelled", handleCancelled);
    } catch {}
  }

  fetchWidgetConfig(widgetId, baseUrl)
    .then((config) => {
      if (destroyed) return;
      attachRooms(config);
    })
    .catch(() => {
      // Soft-fail: the consumer's idle state is unchanged. They can
      // still render their default UI; we just can't deliver invites.
    });

  function teardownRooms(): void {
    try {
      unsubInvite?.();
    } catch {}
    try {
      unsubCancelled?.();
    } catch {}
    unsubInvite = null;
    unsubCancelled = null;
    try {
      inviteRoom?.leaveRoom();
    } catch {}
    inviteRoom = null;
    try {
      visitorRoomBundle?.destroy();
    } catch {}
    visitorRoomBundle = null;
  }

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVisitor(next) {
      visitor = next;
      const update: Record<string, unknown> = {
        visitorName: next?.name ?? "",
        visitorEmail: next?.email ?? "",
      };
      try {
        visitorRoomBundle?.updateHeartbeat(update);
      } catch {}
      const visitorRoom = visitorRoomBundle?.visitorRoom;
      if (!visitorRoom) return;
      try {
        visitorRoom.publishPresence(update);
      } catch {}
    },
    destroy() {
      destroyed = true;
      // Decline before tearing down so the host's call row transitions even
      // when destroy fires from a page unload. keepalive:true on the REST
      // mirror covers that case where the WS publish can't flush in time.
      if (state.status === "ringing") {
        const callId = state.call.callId;
        try {
          inviteRoom?.publishTopic("declined", {
            callId,
            reason: "unmount",
          });
        } catch {}
        mirrorDeclineRest(baseUrl, callId, tabId);
      }
      clearRingTimer();
      teardownRooms();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Org-mode incoming-call client. Same `LobbysideIncomingCallClient`
// surface as the widget-mode factory above so the hook can swap one for
// the other. Difference from widget mode: the visitor-rooms bundle
// rebinds whenever the host toggles which widget is live, so the host of
// the *currently active* widget always sees this tab in their Live table.
//
// The invite room (`visitorInvites:${tabId}`) is tab-scoped and stays
// attached for the whole client lifetime — it doesn't depend on which
// widget is active. Invite payloads carry a `widgetId`, which we filter
// against the currently-active widget id (same rule as widget mode, just
// with a moving target).
//
// On active widget change while `state === "ringing"`, we decline the
// in-flight invite. The host that initiated the ring is no longer
// "visible" to this visitor (the host of the now-active widget is a
// different person), and leaving the call ringing would let it time out
// 30 seconds later from a stale widget. Matches the script-tag bundle's
// org-session teardown.
// ---------------------------------------------------------------------------

export function createLobbysideOrgIncomingCallClient(
  orgId: string,
  options: CreateIncomingCallClientOptions = {},
): LobbysideIncomingCallClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const ringTimeoutMs = options.ringTimeoutMs ?? DEFAULT_RING_TIMEOUT_MS;
  const tabId = getOrCreateTabId();

  let state: LobbysideIncomingCallState = { status: "idle" };
  let visitor: VisitorIdentity | undefined = options.visitor;
  function currentVisitor(): VisitorIdentity | undefined {
    return visitor;
  }

  const listeners = new Set<() => void>();
  let destroyed = false;

  // The active widget id tracks the host's "which one is live" toggle.
  // When it changes, we tear down the prior visitor-rooms bundle and
  // attach a new one keyed to the new widget. `null` = no widget is
  // currently live (0 or >1 active in the org); the visitor is
  // unreachable in that state.
  let activeWidgetId: string | null = null;
  let visitorRoomBundle: VisitorRoomBundle | null = null;
  let inviteRoom: InstantRoom | null = null;
  let unsubInvite: (() => void) | null = null;
  let unsubCancelled: (() => void) | null = null;
  let unsubOrg: (() => void) | null = null;
  let ringTimer: ReturnType<typeof setTimeout> | null = null;
  let db: RoomCapableDb | null = null;

  function emit(): void {
    for (const l of listeners) l();
  }

  function clearRingTimer(): void {
    if (ringTimer != null) {
      clearTimeout(ringTimer);
      ringTimer = null;
    }
  }

  function setIdle(): void {
    clearRingTimer();
    state = { status: "idle" };
    emit();
  }

  function buildCallUrl(invite: IncomingInvitePayload): string {
    const hash = encodeVisitorPrefillHash(currentVisitor());
    return (
      `${baseUrl}/${invite.slug}/c/${invite.callId}?role=visitor` +
      (hash ? `#${hash}` : "")
    );
  }

  function acceptCurrent(invite: IncomingInvitePayload): { callUrl: string } {
    if (state.status !== "ringing" || state.call.callId !== invite.callId) {
      return { callUrl: buildCallUrl(invite) };
    }
    try {
      inviteRoom?.publishTopic("accepted", { callId: invite.callId });
    } catch {}
    setIdle();
    return { callUrl: buildCallUrl(invite) };
  }

  function declineCurrent(
    invite: IncomingInvitePayload,
    reason?: string,
  ): void {
    if (state.status !== "ringing" || state.call.callId !== invite.callId) {
      return;
    }
    try {
      inviteRoom?.publishTopic("declined", {
        callId: invite.callId,
        ...(reason ? { reason } : {}),
      });
    } catch {}
    mirrorDeclineRest(baseUrl, invite.callId, tabId);
    setIdle();
  }

  function startRinging(invite: IncomingInvitePayload): void {
    clearRingTimer();
    state = {
      status: "ringing",
      call: {
        callId: invite.callId,
        hostName: invite.hostName ?? "",
        hostAvatar: invite.hostAvatar ?? "",
        widgetName: invite.widgetName ?? "",
        sentAt: typeof invite.sentAt === "number" ? invite.sentAt : Date.now(),
        accept: () => acceptCurrent(invite),
        decline: () => declineCurrent(invite),
      },
    };
    ringTimer = setTimeout(() => {
      if (state.status === "ringing" && state.call.callId === invite.callId) {
        declineCurrent(invite, "timeout");
      }
    }, ringTimeoutMs);
    emit();
  }

  function handleInvite(payload: unknown): void {
    if (!isPlainInvitePayload(payload)) return;
    // Org-mode rule: only accept invites for the currently-active widget.
    // If no widget is active (0 or >1 live), reject — the visitor isn't
    // reachable by any specific host right now. Anonymous invites
    // (`widgetId === undefined`) are dropped here because we can't tell
    // which widget they're from; the script-tag bundle's org-session
    // would never deliver them either.
    if (!activeWidgetId) return;
    if (!payload.widgetId || payload.widgetId !== activeWidgetId) return;
    if (state.status === "ringing" && state.call.callId !== payload.callId) {
      const prevCallId = state.call.callId;
      try {
        inviteRoom?.publishTopic("declined", {
          callId: prevCallId,
          reason: "superseded",
        });
      } catch {}
      mirrorDeclineRest(baseUrl, prevCallId, tabId);
    }
    startRinging(payload);
  }

  function handleCancelled(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const data = payload as { callId?: unknown };
    if (typeof data.callId !== "string") return;
    if (state.status !== "ringing" || state.call.callId !== data.callId) return;
    setIdle();
  }

  function detachVisitorRooms(): void {
    try {
      visitorRoomBundle?.destroy();
    } catch {}
    visitorRoomBundle = null;
  }

  function attachVisitorRoomsForWidget(widgetId: string): void {
    if (!db) return;
    detachVisitorRooms();
    const origin =
      typeof window !== "undefined" ? window.location.hostname : "";
    visitorRoomBundle = attachVisitorRooms({
      db,
      baseUrl,
      widgetId,
      tabId,
      initialPresence: buildInitialPresence(tabId, visitor),
      origin,
    });
  }

  function applyActiveWidget(next: string | null): void {
    if (next === activeWidgetId) return;
    // If the active widget changes mid-ring, decline the in-flight call.
    // See module header comment for the rationale.
    if (state.status === "ringing") {
      const callId = state.call.callId;
      try {
        inviteRoom?.publishTopic("declined", {
          callId,
          reason: "widget_swapped",
        });
      } catch {}
      mirrorDeclineRest(baseUrl, callId, tabId);
      setIdle();
    }
    activeWidgetId = next;
    if (next) {
      attachVisitorRoomsForWidget(next);
    } else {
      detachVisitorRooms();
    }
  }

  function attachInviteRoom(): void {
    if (!db) return;
    try {
      inviteRoom = db.joinRoom("visitorInvites", tabId, {
        initialPresence: { kind: "visitor" },
      });
    } catch {
      inviteRoom = null;
    }
    if (!inviteRoom) return;
    try {
      unsubInvite = inviteRoom.subscribeTopic("invite", handleInvite);
    } catch {}
    try {
      unsubCancelled = inviteRoom.subscribeTopic("cancelled", handleCancelled);
    } catch {}
  }

  function pickActiveFromInitial(
    config: OrgConfigResponse,
  ): string | null {
    const active = config.widgets.filter((w) => w.active);
    return active.length === 1 ? active[0].widgetId : null;
  }

  fetchOrgConfig(orgId, baseUrl)
    .then((config) => {
      if (destroyed) return;
      db = getInstantClient(config.instantAppId) as unknown as RoomCapableDb;
      attachInviteRoom();
      // Initial active selection from the HTTP snapshot — the live
      // subscription below will refine it as soon as the first tick
      // lands.
      applyActiveWidget(pickActiveFromInitial(config));
      const u = subscribeToOrg(
        getInstantClient(config.instantAppId),
        orgId,
        (org) => {
          if (destroyed) return;
          const ids = liveWidgetIdsFromSubscription(org);
          const next = ids.length === 1 ? ids[0] : null;
          applyActiveWidget(next);
        },
      );
      if (destroyed) {
        u();
      } else {
        unsubOrg = u;
      }
    })
    .catch(() => {
      // Soft-fail: state stays idle. We can't deliver invites without a
      // working org subscription, but the consumer's UI keeps rendering
      // whatever default it had pre-call.
    });

  function teardownInviteRoom(): void {
    try {
      unsubInvite?.();
    } catch {}
    try {
      unsubCancelled?.();
    } catch {}
    unsubInvite = null;
    unsubCancelled = null;
    try {
      inviteRoom?.leaveRoom();
    } catch {}
    inviteRoom = null;
  }

  return {
    getState() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setVisitor(next) {
      visitor = next;
      const update: Record<string, unknown> = {
        visitorName: next?.name ?? "",
        visitorEmail: next?.email ?? "",
      };
      try {
        visitorRoomBundle?.updateHeartbeat(update);
      } catch {}
      const visitorRoom = visitorRoomBundle?.visitorRoom;
      if (!visitorRoom) return;
      try {
        visitorRoom.publishPresence(update);
      } catch {}
    },
    destroy() {
      destroyed = true;
      if (state.status === "ringing") {
        const callId = state.call.callId;
        try {
          inviteRoom?.publishTopic("declined", {
            callId,
            reason: "unmount",
          });
        } catch {}
        mirrorDeclineRest(baseUrl, callId, tabId);
      }
      clearRingTimer();
      try {
        unsubOrg?.();
      } catch {}
      unsubOrg = null;
      detachVisitorRooms();
      teardownInviteRoom();
      listeners.clear();
    },
  };
}
