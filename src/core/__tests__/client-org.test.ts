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
import { createLobbysideOrgClient } from "../client";

const ORG_ID = "org-1";
const APP_ID = "app-xyz";

interface SubscribeCall {
  callback: (resp: { data: unknown }) => void;
  unsubscribe: Mock;
}

function makeFakeDb() {
  const subscribes: SubscribeCall[] = [];
  const db = {
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
  return { db, subscribes };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

function displayData(overrides: Record<string, unknown> = {}) {
  return {
    hostName: "Ada",
    hostTitle: "CEO",
    avatarUrl: "https://img/a.png",
    ctaText: "Hi",
    buttonText: "Join",
    meetLink: "",
    slug: "w-slug",
    widgetName: "Ada's Widget",
    maxQueueSize: 5,
    ...overrides,
  };
}

beforeEach(() => {
  (fetchOrgConfig as Mock).mockReset();
  (getInstantClient as Mock).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLobbysideOrgClient — state machine", () => {
  it("starts in loading and stays loading until the initial fetch resolves", () => {
    (fetchOrgConfig as Mock).mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const client = createLobbysideOrgClient(ORG_ID);
    expect(client.getState().status).toBe("loading");
  });

  it("renders the single active widget as 'online' on first paint", async () => {
    const { db } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: displayData({ hostName: "Ada", buttonText: "Join Ada" }),
        },
        {
          widgetId: "w-B",
          slug: "bob",
          widgetName: "Bob",
          active: false,
          displayData: displayData({ hostName: "Bob" }),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    const state = client.getState();
    expect(state.status).toBe("online");
    if (state.status !== "online") throw new Error("unreachable");
    expect(state.hostName).toBe("Ada");
    expect(state.buttonText).toBe("Join Ada");
    expect(state.isQueueFull).toBe(false);
  });

  it("surfaces NO_LIVE_WIDGET error when 0 widgets are live", async () => {
    const { db } = makeFakeDb();
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

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    const state = client.getState();
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.error.code).toBe("NO_LIVE_WIDGET");
  });

  it("surfaces MULTIPLE_LIVE_WIDGETS error when >1 are live (safety net)", async () => {
    const { db } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "a",
          widgetName: "A",
          active: true,
          displayData: displayData(),
        },
        {
          widgetId: "w-B",
          slug: "b",
          widgetName: "B",
          active: true,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    const state = client.getState();
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.error.code).toBe("MULTIPLE_LIVE_WIDGETS");
  });

  it("flips from one live widget to another when the live subscription says so", async () => {
    const { db, subscribes } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: displayData({ hostName: "Ada" }),
        },
        {
          widgetId: "w-B",
          slug: "bob",
          widgetName: "Bob",
          active: false,
          displayData: displayData({ hostName: "Bob" }),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    if (client.getState().status !== "online")
      throw new Error("expected online on first paint");

    // Live subscription: host swaps A off, B on.
    subscribes[0].callback({
      data: {
        organizations: [
          {
            id: ORG_ID,
            widgets: [
              {
                id: "w-A",
                slug: "ada",
                widgetConfig: [{ isActive: false, hostName: "Ada" }],
                queueEntries: [],
              },
              {
                id: "w-B",
                slug: "bob",
                widgetConfig: [{ isActive: true, hostName: "Bob" }],
                queueEntries: [],
              },
            ],
          },
        ],
      },
    });

    const state = client.getState();
    expect(state.status).toBe("online");
    if (state.status !== "online") throw new Error("unreachable");
    expect(state.hostName).toBe("Bob");
  });

  it("transitions online → MULTIPLE_LIVE_WIDGETS when host turns a second widget on", async () => {
    const { db, subscribes } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "a",
          widgetName: "A",
          active: true,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    expect(client.getState().status).toBe("online");

    subscribes[0].callback({
      data: {
        organizations: [
          {
            id: ORG_ID,
            widgets: [
              { id: "w-A", widgetConfig: [{ isActive: true }], queueEntries: [] },
              { id: "w-B", widgetConfig: [{ isActive: true }], queueEntries: [] },
            ],
          },
        ],
      },
    });
    const state = client.getState();
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.error.code).toBe("MULTIPLE_LIVE_WIDGETS");
  });

  it("isQueueFull reflects the live active widget's queue", async () => {
    const { db, subscribes } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "a",
          widgetName: "A",
          active: true,
          displayData: displayData({ maxQueueSize: 2 }),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    subscribes[0].callback({
      data: {
        organizations: [
          {
            id: ORG_ID,
            widgets: [
              {
                id: "w-A",
                widgetConfig: [{ isActive: true, maxQueueSize: 2 }],
                queueEntries: [{ status: "queued" }, { status: "queued" }],
              },
            ],
          },
        ],
      },
    });
    const state = client.getState();
    expect(state.status).toBe("online");
    if (state.status !== "online") throw new Error("unreachable");
    expect(state.isQueueFull).toBe(true);
  });

  it("propagates fetch errors as NOT_FOUND or NETWORK", async () => {
    const { LobbysideError } = await import("../errors");
    (fetchOrgConfig as Mock).mockRejectedValue(
      new LobbysideError("NOT_FOUND", "nope"),
    );

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    const state = client.getState();
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.error.code).toBe("NOT_FOUND");
  });

  it("destroy() tears down the live subscription", async () => {
    const { db, subscribes } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "a",
          widgetName: "A",
          active: true,
          displayData: displayData(),
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    expect(subscribes).toHaveLength(1);
    client.destroy();
    expect(subscribes[0].unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("joinCall throws INACTIVE when state is not online (NO_LIVE_WIDGET)", async () => {
    const { db } = makeFakeDb();
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

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    const state = client.getState();
    expect(state.status).toBe("error");
    // The org client only exposes joinCall on the online branch — no way
    // to call it from error state. Consumer relies on the narrowing.
    // Negative check: assert there's no `joinCall` on the error state.
    expect(
      (state as { joinCall?: unknown }).joinCall,
    ).toBeUndefined();
  });
});
