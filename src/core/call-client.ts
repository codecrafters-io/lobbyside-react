import { fetchWidgetConfig, type WidgetConfigResponse } from "./config";
import { getInstantClient } from "./instant";
import { getOrCreateTabId } from "./tab-id";
import {
  encodeVisitorPrefillHash,
  type VisitorPrefillData,
} from "./visitor-prefill";

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

// Loose subset of @instantdb/core's Room API. We type only the methods
// we use so a future SDK bump that adds methods stays type-stable.
interface InstantRoom {
  subscribeTopic(name: string, cb: (event: unknown) => void): () => void;
  publishTopic(name: string, payload: unknown): void;
  publishPresence(presence: Record<string, unknown>): void;
  leaveRoom(): void;
}

interface RoomCapableDb {
  joinRoom(
    type: string,
    id: string,
    opts: { initialPresence?: Record<string, unknown> },
  ): InstantRoom;
}

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
    ...(visitor?.name ? { visitorName: visitor.name } : {}),
    ...(visitor?.email ? { visitorEmail: visitor.email } : {}),
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

  let visitorRoom: InstantRoom | null = null;
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
        sentAt: invite.sentAt,
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
    try {
      visitorRoom = db.joinRoom("widgetVisitors", widgetId, {
        initialPresence: buildInitialPresence(tabId, visitor),
      });
    } catch {
      visitorRoom = null;
    }
    try {
      inviteRoom = db.joinRoom("visitorInvites", tabId, {
        initialPresence: { kind: "visitor" },
      });
      unsubInvite = inviteRoom.subscribeTopic("invite", handleInvite);
      unsubCancelled = inviteRoom.subscribeTopic("cancelled", handleCancelled);
    } catch {
      inviteRoom = null;
    }
  }

  fetchWidgetConfig(widgetId, baseUrl)
    .then((config) => {
      if (destroyed) return;
      attachRooms(config);
      if (destroyed) {
        teardownRooms();
      }
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
    try {
      visitorRoom?.leaveRoom();
    } catch {}
    inviteRoom = null;
    visitorRoom = null;
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
      if (!visitorRoom) return;
      try {
        const update: Record<string, unknown> = {
          visitorName: next?.name ?? "",
          visitorEmail: next?.email ?? "",
        };
        visitorRoom.publishPresence(update);
      } catch {}
    },
    destroy() {
      destroyed = true;
      clearRingTimer();
      teardownRooms();
      listeners.clear();
    },
  };
}
