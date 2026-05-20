import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

vi.mock("../org-config", () => ({
  fetchOrgConfig: vi.fn(),
}));
vi.mock("../instant", () => ({
  getInstantClient: vi.fn(),
}));

import { fetchOrgConfig } from "../org-config";
import { getInstantClient } from "../instant";
import { createLobbysideOrgIncomingCallClient } from "../call-client";

const ORG_ID = "org-1";
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

interface SubscribeCall {
  callback: (resp: { data: unknown }) => void;
  unsubscribe: Mock;
}

function makeFakeDb() {
  const rooms: Record<string, FakeRoom> = {};
  const subscribes: SubscribeCall[] = [];

  const db = {
    joinRoom(type: string, id: string) {
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
    subscribeQuery(
      _q: unknown,
      cb: (resp: { data: unknown }) => void,
      _opts: unknown,
    ) {
      const unsubscribe = vi.fn();
      subscribes.push({ callback: cb, unsubscribe });
      return unsubscribe;
    },
  };

  return { db, rooms, subscribes };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function tabId(): string {
  return sessionStorage.getItem("lobbyside_tab_id") ?? "";
}

function displayData(overrides: Record<string, unknown> = {}) {
  return {
    hostName: "Ada",
    hostTitle: "CEO",
    avatarUrl: "https://img/a.png",
    ctaText: "Hi",
    buttonText: "Join",
    meetLink: "",
    slug: "ada",
    widgetName: "Ada's Widget",
    maxQueueSize: 5,
    ...overrides,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  (fetchOrgConfig as Mock).mockReset();
  (getInstantClient as Mock).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLobbysideOrgIncomingCallClient", () => {
  it("joins the per-tab room for the initially-active widget", async () => {
    const { db, rooms } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgIncomingCallClient(ORG_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flush();
    // Per-tab room id matches the bundle — see visitor-rooms.ts.
    expect(rooms[`widgetVisitors:w-A:${tabId()}`]).toBeDefined();
    expect(rooms[`visitorInvites:${tabId()}`]).toBeDefined();
    expect(client.getState().status).toBe("idle");
  });

  it("does not join any visitor room when 0 widgets are live", async () => {
    const { db, rooms } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "a",
          widgetName: "A",
          active: false,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    createLobbysideOrgIncomingCallClient(ORG_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flush();
    expect(rooms[`widgetVisitors:w-A:${tabId()}`]).toBeUndefined();
    // Invite room IS joined regardless — it's tab-scoped and the visitor
    // could still become reachable later if a host toggles a widget on.
    expect(rooms[`visitorInvites:${tabId()}`]).toBeDefined();
  });

  it("rebinds visitor rooms when the active widget changes", async () => {
    const { db, rooms, subscribes } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: displayData(),
        },
        {
          widgetId: "w-B",
          slug: "bob",
          widgetName: "Bob",
          active: false,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    createLobbysideOrgIncomingCallClient(ORG_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flush();
    const roomA = rooms[`widgetVisitors:w-A:${tabId()}`];
    expect(roomA).toBeDefined();
    expect(roomA.leftRoom).toBe(false);

    subscribes[0].callback({
      data: {
        organizations: [
          {
            id: ORG_ID,
            widgets: [
              { id: "w-A", widgetConfig: [{ isActive: false }], queueEntries: [] },
              { id: "w-B", widgetConfig: [{ isActive: true }], queueEntries: [] },
            ],
          },
        ],
      },
    });

    expect(roomA.leftRoom).toBe(true);
    expect(rooms[`widgetVisitors:w-B:${tabId()}`]).toBeDefined();
    expect(rooms[`widgetVisitors:w-B:${tabId()}`].leftRoom).toBe(false);
  });

  it("rings when an invite arrives for the currently-active widget", async () => {
    const { db, rooms } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgIncomingCallClient(ORG_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flush();

    const cb = rooms[`visitorInvites:${tabId()}`].topics.get("invite");
    cb?.({
      callId: "call-1",
      hostName: "Alex",
      widgetName: "Ada",
      slug: "ada",
      sentAt: 0,
      widgetId: "w-A",
    });

    const state = client.getState();
    expect(state.status).toBe("ringing");
    if (state.status !== "ringing") throw new Error("unreachable");
    expect(state.call.callId).toBe("call-1");
  });

  it("ignores invites for a non-active widget (host raced a swap)", async () => {
    const { db, rooms } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgIncomingCallClient(ORG_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flush();

    // Host of a DIFFERENT widget tries to dial this tab.
    rooms[`visitorInvites:${tabId()}`].topics.get("invite")?.({
      callId: "call-x",
      hostName: "Stranger",
      widgetName: "Other",
      slug: "other",
      sentAt: 0,
      widgetId: "w-B",
    });
    expect(client.getState().status).toBe("idle");
  });

  it("declines an in-flight ring when the active widget swaps (matches bundle teardown)", async () => {
    const { db, rooms, subscribes } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );

    const client = createLobbysideOrgIncomingCallClient(ORG_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flush();

    rooms[`visitorInvites:${tabId()}`].topics.get("invite")?.({
      callId: "call-1",
      hostName: "Alex",
      widgetName: "Ada",
      slug: "ada",
      sentAt: 0,
      widgetId: "w-A",
    });
    expect(client.getState().status).toBe("ringing");

    // Host swaps A off, B on — w-A no longer the active widget.
    subscribes[0].callback({
      data: {
        organizations: [
          {
            id: ORG_ID,
            widgets: [
              { id: "w-A", widgetConfig: [{ isActive: false }], queueEntries: [] },
              { id: "w-B", widgetConfig: [{ isActive: true }], queueEntries: [] },
            ],
          },
        ],
      },
    });

    expect(client.getState().status).toBe("idle");
    const declined = rooms[`visitorInvites:${tabId()}`].publishedTopics.find(
      (t) => t.topic === "declined",
    );
    expect(declined).toBeDefined();
    expect((declined?.payload as { reason?: string }).reason).toBe(
      "widget_swapped",
    );
  });

  it("destroy() leaves rooms and tears down org subscription", async () => {
    const { db, rooms, subscribes } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgIncomingCallClient(ORG_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flush();
    client.destroy();

    expect(rooms[`widgetVisitors:w-A:${tabId()}`].leftRoom).toBe(true);
    expect(rooms[`visitorInvites:${tabId()}`].leftRoom).toBe(true);
    expect(rooms[`widgetVisitorCounter:w-A:_counter`].leftRoom).toBe(true);
    expect(rooms[`widgetActiveHosts:w-A:_hosts`].leftRoom).toBe(true);
    expect(subscribes[0].unsubscribe).toHaveBeenCalledTimes(1);
  });
});
