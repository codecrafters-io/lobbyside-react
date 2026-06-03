import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

vi.mock("../config", () => ({
  fetchWidgetConfig: vi.fn(),
}));
vi.mock("../instant", () => ({
  getInstantClient: vi.fn(),
}));

import { fetchWidgetConfig } from "../config";
import { getInstantClient } from "../instant";
import {
  createLobbysideIncomingCallClient,
  type LobbysideIncomingCallClient,
  type LobbysideIncomingCallState,
} from "../call-client";

interface RoomCall {
  type: string;
  id: string;
  initialPresence: unknown;
}

interface FakeRoom {
  topics: Map<string, (event: unknown) => void>;
  presenceSubscribers: ((slice: {
    peers?: Record<string, Record<string, unknown>>;
  }) => void)[];
  publishedTopics: { topic: string; payload: unknown }[];
  publishedPresence: Record<string, unknown>[];
  leftRoom: boolean;
}

const WIDGET_ID = "wid-1";
const APP_ID = "app-xyz";

function makeFakeDb() {
  const rooms: Record<string, FakeRoom> = {};
  const calls: RoomCall[] = [];

  const db = {
    joinRoom(
      type: string,
      id: string,
      opts: { initialPresence?: Record<string, unknown> },
    ) {
      calls.push({ type, id, initialPresence: opts.initialPresence });
      const room: FakeRoom = {
        topics: new Map(),
        presenceSubscribers: [],
        publishedTopics: [],
        publishedPresence: [],
        leftRoom: false,
      };
      rooms[`${type}:${id}`] = room;
      return {
        subscribeTopic(name: string, cb: (event: unknown) => void) {
          room.topics.set(name, cb);
          return () => {
            if (room.topics.get(name) === cb) room.topics.delete(name);
          };
        },
        // Retained for room-API completeness; the directory heartbeat no
        // longer gates on host presence, so visitor-rooms doesn't call this.
        subscribePresence(
          _opts: unknown,
          cb: (slice: {
            peers?: Record<string, Record<string, unknown>>;
          }) => void,
        ) {
          room.presenceSubscribers.push(cb);
          // Fire initial callback with empty peers so the gate decides
          // synchronously rather than waiting for a phantom "first tick".
          cb({ peers: {} });
          return () => {
            const i = room.presenceSubscribers.indexOf(cb);
            if (i >= 0) room.presenceSubscribers.splice(i, 1);
          };
        },
        publishTopic(name: string, payload: unknown) {
          room.publishedTopics.push({ topic: name, payload });
        },
        publishPresence(presence: Record<string, unknown>) {
          room.publishedPresence.push(presence);
        },
        leaveRoom() {
          room.leftRoom = true;
        },
      };
    },
  };

  return { db, rooms, calls };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function bootClient(opts?: {
  ringTimeoutMs?: number;
  visitor?: { name?: string; email?: string };
}): Promise<{
  client: LobbysideIncomingCallClient;
  rooms: Record<string, FakeRoom>;
  fireInvite: (payload: unknown) => void;
  fireCancelled: (payload: unknown) => void;
}> {
  const { db, rooms } = makeFakeDb();
  (fetchWidgetConfig as Mock).mockResolvedValue({
    active: true,
    instantAppId: APP_ID,
    displayData: { slug: "test-slug" },
  });
  (getInstantClient as Mock).mockReturnValue(db);

  const client = createLobbysideIncomingCallClient(WIDGET_ID, {
    baseUrl: "http://localhost:3000",
    ringTimeoutMs: opts?.ringTimeoutMs,
    visitor: opts?.visitor,
  });
  await flushMicrotasks();
  return {
    client,
    rooms,
    fireInvite(payload) {
      const room = rooms[`visitorInvites:${tabId()}`];
      const cb = room?.topics.get("invite");
      if (cb) cb(payload);
    },
    fireCancelled(payload) {
      const room = rooms[`visitorInvites:${tabId()}`];
      const cb = room?.topics.get("cancelled");
      if (cb) cb(payload);
    },
  };
}

function tabId(): string {
  return sessionStorage.getItem("lobbyside_tab_id") ?? "";
}

beforeEach(() => {
  sessionStorage.clear();
  vi.useFakeTimers();
  (fetchWidgetConfig as Mock).mockReset();
  (getInstantClient as Mock).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

const makeInvite = (overrides: Record<string, unknown> = {}) => ({
  callId: "call-1",
  hostName: "Alex",
  hostAvatar: "https://example.com/a.png",
  widgetName: "DevRel @ CodeCrafters",
  slug: "alex",
  sentAt: 0,
  widgetId: WIDGET_ID,
  ...overrides,
});

describe("createLobbysideIncomingCallClient", () => {
  it("starts in idle and joins presence + invite rooms after config resolves", async () => {
    const { client, rooms } = await bootClient({ visitor: { name: "Ada" } });

    expect(client.getState().status).toBe("idle");
    // Per-tab room id matches the script-tag bundle so the host sees SDK
    // consumers identically. The previous bare `widgetVisitors:${WIDGET_ID}`
    // room aliased the pre-`052aee1` shared PII room.
    expect(rooms[`widgetVisitors:${WIDGET_ID}:${tabId()}`]).toBeDefined();
    expect(rooms[`visitorInvites:${tabId()}`]).toBeDefined();
    const presence =
      rooms[`widgetVisitors:${WIDGET_ID}:${tabId()}`].publishedPresence;
    expect(presence).toEqual([]); // joinRoom uses initialPresence, not publish
    expect(
      rooms[`visitorInvites:${tabId()}`].topics.get("invite"),
    ).toBeDefined();
    expect(
      rooms[`visitorInvites:${tabId()}`].topics.get("cancelled"),
    ).toBeDefined();
  });

  it("transitions to ringing on invite addressed to this widgetId", async () => {
    const ctx = await bootClient();
    const listener = vi.fn();
    ctx.client.subscribe(listener);

    ctx.fireInvite(makeInvite());

    expect(listener).toHaveBeenCalled();
    const state = ctx.client.getState();
    expect(state.status).toBe("ringing");
    if (state.status !== "ringing") throw new Error("unreachable");
    expect(state.call.callId).toBe("call-1");
    expect(state.call.hostName).toBe("Alex");
    expect(state.call.hostAvatar).toBe("https://example.com/a.png");
  });

  it("ignores invites addressed to a different widgetId", async () => {
    const ctx = await bootClient();
    ctx.fireInvite(makeInvite({ widgetId: "other-widget" }));
    expect(ctx.client.getState().status).toBe("idle");
  });

  it("accepts invites missing widgetId (legacy host bundle)", async () => {
    const ctx = await bootClient();
    ctx.fireInvite(makeInvite({ widgetId: undefined }));
    expect(ctx.client.getState().status).toBe("ringing");
  });

  it("ignores malformed payloads", async () => {
    const ctx = await bootClient();
    ctx.fireInvite(null);
    ctx.fireInvite({ callId: 123 });
    ctx.fireInvite({ slug: "x" });
    expect(ctx.client.getState().status).toBe("idle");
  });

  it("decline publishes 'declined' topic + REST mirror, returns to idle", async () => {
    const ctx = await bootClient();
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    ctx.fireInvite(makeInvite());
    const state = ctx.client.getState();
    if (state.status !== "ringing") throw new Error("expected ringing");
    state.call.decline();

    expect(ctx.client.getState().status).toBe("idle");
    const inviteRoom = ctx.rooms[`visitorInvites:${tabId()}`];
    expect(inviteRoom.publishedTopics).toEqual([
      { topic: "declined", payload: { callId: "call-1" } },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/calls/call-1/decline",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("accept publishes 'accepted' topic and returns a callUrl", async () => {
    const ctx = await bootClient({ visitor: { name: "Ada", email: "a@b.co" } });
    ctx.fireInvite(makeInvite());
    const state = ctx.client.getState();
    if (state.status !== "ringing") throw new Error("expected ringing");

    const { callUrl } = state.call.accept();

    expect(ctx.client.getState().status).toBe("idle");
    const inviteRoom = ctx.rooms[`visitorInvites:${tabId()}`];
    expect(inviteRoom.publishedTopics).toEqual([
      { topic: "accepted", payload: { callId: "call-1" } },
    ]);
    expect(callUrl).toMatch(
      /^http:\/\/localhost:3000\/alex\/c\/call-1\?role=visitor#lb_v=/,
    );
    const hash = decodeURIComponent(callUrl.split("#lb_v=")[1]);
    expect(JSON.parse(hash)).toEqual({ name: "Ada", email: "a@b.co" });
  });

  it("accept without visitor returns a URL with no hash", async () => {
    const ctx = await bootClient();
    ctx.fireInvite(makeInvite());
    const state = ctx.client.getState();
    if (state.status !== "ringing") throw new Error("expected ringing");
    const { callUrl } = state.call.accept();
    expect(callUrl).toBe(
      "http://localhost:3000/alex/c/call-1?role=visitor",
    );
  });

  it("cancelled topic with matching callId clears state", async () => {
    const ctx = await bootClient();
    ctx.fireInvite(makeInvite());
    expect(ctx.client.getState().status).toBe("ringing");
    ctx.fireCancelled({ callId: "call-1" });
    expect(ctx.client.getState().status).toBe("idle");
  });

  it("cancelled topic with mismatched callId is ignored", async () => {
    const ctx = await bootClient();
    ctx.fireInvite(makeInvite());
    ctx.fireCancelled({ callId: "other-call" });
    expect(ctx.client.getState().status).toBe("ringing");
  });

  it("auto-declines after ringTimeoutMs with reason=timeout", async () => {
    const ctx = await bootClient({ ringTimeoutMs: 1500 });
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    ctx.fireInvite(makeInvite());
    vi.advanceTimersByTime(1500);

    expect(ctx.client.getState().status).toBe("idle");
    const inviteRoom = ctx.rooms[`visitorInvites:${tabId()}`];
    expect(inviteRoom.publishedTopics).toEqual([
      { topic: "declined", payload: { callId: "call-1", reason: "timeout" } },
    ]);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("setVisitor publishes a presence update", async () => {
    const ctx = await bootClient({ visitor: { name: "Old" } });
    ctx.client.setVisitor({ name: "New", email: "n@e.co" });
    const presence =
      ctx.rooms[`widgetVisitors:${WIDGET_ID}:${tabId()}`].publishedPresence;
    expect(presence).toEqual([{ visitorName: "New", visitorEmail: "n@e.co" }]);
  });

  it("initial presence and setVisitor publishes use the same visitor field shape (Bugbot regression)", async () => {
    const { db, rooms, calls } = makeFakeDb();
    (fetchWidgetConfig as Mock).mockResolvedValue({
      active: true,
      instantAppId: APP_ID,
      displayData: { slug: "test-slug" },
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideIncomingCallClient(WIDGET_ID, {
      baseUrl: "http://localhost:3000",
      // No visitor — initial presence still needs the fields, just empty.
    });
    await flushMicrotasks();

    const initial = calls.find((c) => c.type === "widgetVisitors")
      ?.initialPresence as Record<string, unknown>;
    expect(initial).toMatchObject({
      visitorName: "",
      visitorEmail: "",
    });

    client.setVisitor(undefined);
    const update =
      rooms[`widgetVisitors:${WIDGET_ID}:${tabId()}`].publishedPresence[0];
    expect(Object.keys(update).sort()).toEqual(
      ["visitorEmail", "visitorName"].sort(),
    );
    expect(update).toEqual({ visitorName: "", visitorEmail: "" });
  });

  it("subscribeTopic failure does not strand the invite room handle (Bugbot regression)", async () => {
    const { db, rooms } = makeFakeDb();
    const origJoinRoom = db.joinRoom.bind(db);
    db.joinRoom = (type, id, opts) => {
      const room = origJoinRoom(type, id, opts);
      if (type === "visitorInvites") {
        return {
          ...room,
          subscribeTopic() {
            throw new Error("simulated transport error");
          },
        };
      }
      return room;
    };
    (fetchWidgetConfig as Mock).mockResolvedValue({
      active: true,
      instantAppId: APP_ID,
      displayData: { slug: "test-slug" },
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideIncomingCallClient(WIDGET_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flushMicrotasks();
    client.destroy();

    const inviteRoom = rooms[`visitorInvites:${tabId()}`];
    expect(inviteRoom.leftRoom).toBe(true);
  });

  it("destroy unsubscribes topics and leaves all visitor + invite rooms", async () => {
    const ctx = await bootClient();
    const inviteRoom = ctx.rooms[`visitorInvites:${tabId()}`];
    const visitorRoom = ctx.rooms[`widgetVisitors:${WIDGET_ID}:${tabId()}`];
    const counterRoom = ctx.rooms[`widgetVisitorCounter:${WIDGET_ID}:_counter`];
    expect(inviteRoom.topics.size).toBe(2);

    ctx.client.destroy();

    expect(inviteRoom.topics.size).toBe(0);
    expect(inviteRoom.leftRoom).toBe(true);
    expect(visitorRoom.leftRoom).toBe(true);
    // Counter room is joined for its side effect (pill count); it must be
    // left on destroy or the SDK consumer keeps a phantom presence.
    expect(counterRoom.leftRoom).toBe(true);
  });

  it("destroy while ringing declines the active invite (Bugbot regression)", async () => {
    const ctx = await bootClient();
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    ctx.fireInvite(makeInvite());
    expect(ctx.client.getState().status).toBe("ringing");

    ctx.client.destroy();

    const inviteRoom = ctx.rooms[`visitorInvites:${tabId()}`];
    expect(inviteRoom.publishedTopics).toEqual([
      { topic: "declined", payload: { callId: "call-1", reason: "unmount" } },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/calls/call-1/decline",
      expect.objectContaining({ method: "POST", keepalive: true }),
    );
  });

  it("destroy while idle does not publish anything", async () => {
    const ctx = await bootClient();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    ctx.client.destroy();

    const inviteRoom = ctx.rooms[`visitorInvites:${tabId()}`];
    expect(inviteRoom.publishedTopics).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("new invite while ringing declines the previous one (Bugbot regression)", async () => {
    const ctx = await bootClient();
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    ctx.fireInvite(makeInvite({ callId: "call-1" }));
    ctx.fireInvite(makeInvite({ callId: "call-2" }));

    const state = ctx.client.getState();
    if (state.status !== "ringing") throw new Error("expected ringing");
    expect(state.call.callId).toBe("call-2");

    const inviteRoom = ctx.rooms[`visitorInvites:${tabId()}`];
    expect(inviteRoom.publishedTopics).toEqual([
      { topic: "declined", payload: { callId: "call-1", reason: "superseded" } },
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/api/calls/call-1/decline",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("re-invite of the same callId restarts the ring timer without declining (Bugbot regression)", async () => {
    const ctx = await bootClient({ ringTimeoutMs: 1000 });
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    ctx.fireInvite(makeInvite());
    vi.advanceTimersByTime(800);
    ctx.fireInvite(makeInvite());

    const inviteRoom = ctx.rooms[`visitorInvites:${tabId()}`];
    expect(inviteRoom.publishedTopics).toEqual([]);
    // The directory heartbeat may PUT here — assert only that no decline fired.
    expect(fetchSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("/decline"),
      expect.anything(),
    );

    vi.advanceTimersByTime(500);
    expect(ctx.client.getState().status).toBe("ringing");
  });

  // Regression: the directory heartbeat must PUT unconditionally (no host-gate)
  // with the rich body, or SDK rows show up with no journey/path (or not at all).
  it("PUTs an ungated rich heartbeat carrying path + journey", async () => {
    const ctx = await bootClient({ visitor: { name: "Ada" } });
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    // Advance past the anti-stampede jitter window (max 2s).
    vi.advanceTimersByTime(2000);

    const put = fetchSpy.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.includes(`/live-tabs/${tabId()}`) &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(put).toBeDefined();
    const body = JSON.parse((put![1] as RequestInit).body as string);
    expect(body.pathname).toBe("/");
    expect(Array.isArray(body.visitedPaths)).toBe(true);
    expect(body.visitedPaths.length).toBeGreaterThan(0);
    expect(body.visitorName).toBe("Ada");
  });

  // Regression: SDK rows showed "Time zone not shared yet" on the host because
  // the heartbeat body omitted `timezone` (the script-tag bundle always sends
  // it). Without it the host can't render the visitor's local time.
  it("heartbeat body carries a non-empty browser timezone", async () => {
    await bootClient();
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.advanceTimersByTime(2000);

    const put = fetchSpy.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.includes(`/live-tabs/${tabId()}`) &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(put).toBeDefined();
    const body = JSON.parse((put![1] as RequestInit).body as string);
    expect(typeof body.timezone).toBe("string");
    expect(body.timezone.length).toBeGreaterThan(0);
  });

  // Regression: SDK rows had a frozen single-entry journey (no nav tracker), so
  // an SPA visitor browsing several routes still showed "/" with 0s on page.
  it("SPA navigation appends to the journey and re-PUTs the new path", async () => {
    const ctx = await bootClient();
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    // Let the initial jittered PUT fire so the row exists and updates re-PUT.
    vi.advanceTimersByTime(2000);
    fetchSpy.mockClear();

    window.history.pushState({}, "", "/pricing");
    await Promise.resolve();
    vi.advanceTimersByTime(400);

    const put = [...fetchSpy.mock.calls]
      .reverse()
      .find(
        ([url, init]) =>
          typeof url === "string" &&
          url.includes(`/live-tabs/${tabId()}`) &&
          (init as RequestInit | undefined)?.method === "PUT",
      );
    expect(put).toBeDefined();
    const body = JSON.parse((put![1] as RequestInit).body as string);
    expect(body.pathname).toBe("/pricing");
    expect(body.visitedPaths.length).toBe(2);
    expect(body.visitedPaths[1].path).toBe("/pricing");

    // Restores history.pushState (patched by the nav tracker) for other tests.
    ctx.client.destroy();
    window.history.pushState({}, "", "/");
  });

  // Regression (Bugbot): nav hooks arm only after the async config fetch. A
  // route change in that gap must still surface in the first attach body.
  it("captures a navigation that landed before config resolved", async () => {
    window.history.replaceState({}, "", "/");
    const { db, calls } = makeFakeDb();
    (fetchWidgetConfig as Mock).mockResolvedValue({
      active: true,
      instantAppId: APP_ID,
      displayData: { slug: "test-slug" },
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideIncomingCallClient(WIDGET_ID, {
      baseUrl: "http://localhost:3000",
    });
    // Visitor navigates while config is still in flight (hooks not armed yet).
    window.history.pushState({}, "", "/pricing");
    await flushMicrotasks();

    const presence = calls.find((c) => c.type === "widgetVisitors")
      ?.initialPresence as Record<string, unknown>;
    expect(presence.pathname).toBe("/pricing");
    const paths = presence.visitedPaths as { path: string }[];
    expect(paths.some((p) => p.path === "/pricing")).toBe(true);

    client.destroy();
    window.history.pushState({}, "", "/");
  });

  // Regression (Bugbot): setVisitor must refresh the polled directory row, not
  // just the per-tab room, or the host's Live list shows a stale name/email.
  it("setVisitor re-PUTs the heartbeat with updated identity", async () => {
    const ctx = await bootClient();
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    // Let the initial jittered PUT fire so the row exists.
    vi.advanceTimersByTime(2000);
    fetchSpy.mockClear();

    ctx.client.setVisitor({ name: "Bob", email: "bob@acme.com" });

    const put = fetchSpy.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.includes(`/live-tabs/${tabId()}`) &&
        (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(put).toBeDefined();
    const body = JSON.parse((put![1] as RequestInit).body as string);
    expect(body.visitorName).toBe("Bob");
    expect(body.visitorEmail).toBe("bob@acme.com");
  });

  it("invite missing sentAt falls back to Date.now() (Bugbot regression)", async () => {
    const ctx = await bootClient();
    const before = Date.now();
    ctx.fireInvite(makeInvite({ sentAt: undefined }));
    const after = Date.now();

    const state = ctx.client.getState();
    if (state.status !== "ringing") throw new Error("expected ringing");
    expect(typeof state.call.sentAt).toBe("number");
    expect(state.call.sentAt).toBeGreaterThanOrEqual(before);
    expect(state.call.sentAt).toBeLessThanOrEqual(after);
  });

  it("invite with non-numeric sentAt falls back to Date.now()", async () => {
    const ctx = await bootClient();
    ctx.fireInvite(makeInvite({ sentAt: "not-a-number" as unknown as number }));
    const state = ctx.client.getState();
    if (state.status !== "ringing") throw new Error("expected ringing");
    expect(typeof state.call.sentAt).toBe("number");
    expect(Number.isFinite(state.call.sentAt)).toBe(true);
  });

  it("destroy before config resolves prevents any room from being joined", async () => {
    const { db, rooms } = makeFakeDb();
    const joinRoomSpy = vi.spyOn(db, "joinRoom");
    let resolve: ((value: unknown) => void) | undefined;
    (fetchWidgetConfig as Mock).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideIncomingCallClient(WIDGET_ID, {
      baseUrl: "http://localhost:3000",
    });
    client.destroy();

    resolve?.({
      active: true,
      instantAppId: APP_ID,
      displayData: { slug: "test-slug" },
    });
    await flushMicrotasks();

    expect(joinRoomSpy).not.toHaveBeenCalled();
    expect(Object.keys(rooms)).toEqual([]);
  });

  it("decline after timeout is a no-op (already idle)", async () => {
    const ctx = await bootClient({ ringTimeoutMs: 500 });
    const fetchSpy = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);

    ctx.fireInvite(makeInvite());
    const state = ctx.client.getState();
    if (state.status !== "ringing") throw new Error("expected ringing");
    vi.advanceTimersByTime(500);
    // timeout already published decline + mirrored REST
    fetchSpy.mockClear();
    const inviteRoom = ctx.rooms[`visitorInvites:${tabId()}`];
    inviteRoom.publishedTopics.length = 0;

    state.call.decline();
    expect(inviteRoom.publishedTopics).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
