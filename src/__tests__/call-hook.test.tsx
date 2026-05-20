import { act, cleanup, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

vi.mock("../core/config", () => ({
  fetchWidgetConfig: vi.fn(),
}));
vi.mock("../core/org-config", () => ({
  fetchOrgConfig: vi.fn(),
}));
vi.mock("../core/instant", () => ({
  getInstantClient: vi.fn(),
}));

import { fetchWidgetConfig } from "../core/config";
import { fetchOrgConfig } from "../core/org-config";
import { getInstantClient } from "../core/instant";
import { useLobbysideIncomingCall } from "../call-hook";

const WIDGET_ID = "wid-1";
const APP_ID = "app-xyz";

interface FakeRoom {
  topics: Map<string, (event: unknown) => void>;
  presenceSubscribers: ((slice: {
    peers?: Record<string, Record<string, unknown>>;
  }) => void)[];
  publishedTopics: { topic: string; payload: unknown }[];
  publishedPresence: Record<string, unknown>[];
  leftRoom: boolean;
}

function makeFakeDb() {
  const rooms: Record<string, FakeRoom> = {};
  const db = {
    // `subscribeQuery` is only used by the org-mode call-client (to watch
    // which widget is currently live). Widget-mode tests don't trigger
    // it; we accept the call and return a no-op unsubscribe so it stays
    // out of the way of existing assertions.
    subscribeQuery() {
      return () => undefined;
    },
    joinRoom(
      type: string,
      id: string,
      _opts: { initialPresence?: Record<string, unknown> },
    ) {
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
        subscribePresence(
          _opts: unknown,
          cb: (slice: {
            peers?: Record<string, Record<string, unknown>>;
          }) => void,
        ) {
          room.presenceSubscribers.push(cb);
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
  return { db, rooms };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  sessionStorage.clear();
  (fetchWidgetConfig as Mock).mockReset();
  (fetchOrgConfig as Mock).mockReset();
  (getInstantClient as Mock).mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setupOk(): { rooms: Record<string, FakeRoom> } {
  const { db, rooms } = makeFakeDb();
  (fetchWidgetConfig as Mock).mockResolvedValue({
    active: true,
    instantAppId: APP_ID,
    displayData: { slug: "test-slug" },
  });
  (getInstantClient as Mock).mockReturnValue(db);
  return { rooms };
}

function tabId(): string {
  return sessionStorage.getItem("lobbyside_tab_id") ?? "";
}

describe("useLobbysideIncomingCall", () => {
  it("returns idle on first render and after config resolves", async () => {
    setupOk();
    const { result } = renderHook(() => useLobbysideIncomingCall(WIDGET_ID));
    expect(result.current.status).toBe("idle");
    await act(async () => {
      await flushMicrotasks();
    });
    expect(result.current.status).toBe("idle");
  });

  it("flips to ringing when an invite arrives", async () => {
    const { rooms } = setupOk();
    const { result } = renderHook(() => useLobbysideIncomingCall(WIDGET_ID));
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      const room = rooms[`visitorInvites:${tabId()}`];
      room.topics.get("invite")?.({
        callId: "call-1",
        hostName: "Alex",
        widgetName: "DevRel",
        slug: "alex",
        sentAt: 0,
        widgetId: WIDGET_ID,
      });
    });

    expect(result.current.status).toBe("ringing");
    if (result.current.status !== "ringing") throw new Error("unreachable");
    expect(result.current.call.callId).toBe("call-1");
  });

  it("returns to idle after decline", async () => {
    const { rooms } = setupOk();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );
    const { result } = renderHook(() => useLobbysideIncomingCall(WIDGET_ID));
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      rooms[`visitorInvites:${tabId()}`].topics.get("invite")?.({
        callId: "call-1",
        hostName: "Alex",
        widgetName: "DevRel",
        slug: "alex",
        sentAt: 0,
        widgetId: WIDGET_ID,
      });
    });
    if (result.current.status !== "ringing") throw new Error("expected ringing");

    await act(async () => {
      if (result.current.status === "ringing") result.current.call.decline();
    });
    expect(result.current.status).toBe("idle");
  });

  it("tears down rooms on unmount", async () => {
    const { rooms } = setupOk();
    const { unmount } = renderHook(() => useLobbysideIncomingCall(WIDGET_ID));
    await act(async () => {
      await flushMicrotasks();
    });

    unmount();
    // Per-tab room id matches the script-tag bundle — see visitor-rooms.ts.
    expect(rooms[`widgetVisitors:${WIDGET_ID}:${tabId()}`].leftRoom).toBe(true);
    expect(rooms[`visitorInvites:${tabId()}`].leftRoom).toBe(true);
  });

  it("does not recreate the client when only visitor changes", async () => {
    setupOk();
    const fetchSpy = fetchWidgetConfig as Mock;
    const { rerender } = renderHook(
      ({ visitor }: { visitor: { name: string } }) =>
        useLobbysideIncomingCall(WIDGET_ID, { visitor }),
      { initialProps: { visitor: { name: "Ada" } } },
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    rerender({ visitor: { name: "Bob" } });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("publishes presence on visitor change", async () => {
    const { rooms } = setupOk();
    type V = { name: string } | undefined;
    const { rerender } = renderHook(
      ({ visitor }: { visitor: V }) =>
        useLobbysideIncomingCall(WIDGET_ID, { visitor }),
      { initialProps: { visitor: undefined as V } },
    );
    await act(async () => {
      await flushMicrotasks();
    });

    rerender({ visitor: { name: "Updated" } });
    await act(async () => {
      await flushMicrotasks();
    });

    const presence =
      rooms[`widgetVisitors:${WIDGET_ID}:${tabId()}`].publishedPresence;
    expect(presence).toContainEqual({
      visitorName: "Updated",
      visitorEmail: "",
    });
  });

  it("recreates the client when widgetId changes", async () => {
    setupOk();
    const fetchSpy = fetchWidgetConfig as Mock;
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useLobbysideIncomingCall(id),
      { initialProps: { id: "w1" } },
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    rerender({ id: "w2" });
    await act(async () => {
      await flushMicrotasks();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("ignores invites for a different widgetId (multi-widget scenario)", async () => {
    const { rooms } = setupOk();
    const { result } = renderHook(() => useLobbysideIncomingCall(WIDGET_ID));
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      rooms[`visitorInvites:${tabId()}`].topics.get("invite")?.({
        callId: "call-x",
        hostName: "Stranger",
        widgetName: "Other",
        slug: "other",
        sentAt: 0,
        widgetId: "other-widget",
      });
    });

    expect(result.current.status).toBe("idle");
  });
});

describe("useLobbysideIncomingCall — options-object form", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("stays idle and console.errors when both widgetId and orgId are passed", async () => {
    const { result } = renderHook(() =>
      useLobbysideIncomingCall({
        widgetId: WIDGET_ID,
        orgId: "org-1",
      }),
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(result.current.status).toBe("idle");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "pass either { widgetId } or { orgId }, not both",
      ),
    );
    // No client constructed → no fetch on either path.
    expect(fetchWidgetConfig as Mock).not.toHaveBeenCalled();
    expect(fetchOrgConfig as Mock).not.toHaveBeenCalled();
  });

  it("dispatches to widget mode when only widgetId is in the options object", async () => {
    setupOk();
    renderHook(() =>
      useLobbysideIncomingCall({ widgetId: WIDGET_ID }),
    );
    await act(async () => {
      await flushMicrotasks();
    });
    expect(fetchWidgetConfig as Mock).toHaveBeenCalledWith(
      WIDGET_ID,
      expect.any(String),
    );
    expect(fetchOrgConfig as Mock).not.toHaveBeenCalled();
  });

  it("dispatches to org mode when only orgId is in the options object", async () => {
    const { db } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: { slug: "ada" },
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    renderHook(() => useLobbysideIncomingCall({ orgId: "org-1" }));
    await act(async () => {
      await flushMicrotasks();
    });
    expect(fetchOrgConfig as Mock).toHaveBeenCalledWith(
      "org-1",
      expect.any(String),
    );
    expect(fetchWidgetConfig as Mock).not.toHaveBeenCalled();
  });
});
