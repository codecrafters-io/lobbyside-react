import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

vi.mock("../config", () => ({ fetchWidgetConfig: vi.fn() }));
vi.mock("../org-config", () => ({ fetchOrgConfig: vi.fn() }));
vi.mock("../instant", () => ({ getInstantClient: vi.fn() }));

import { fetchWidgetConfig } from "../config";
import { fetchOrgConfig } from "../org-config";
import { getInstantClient } from "../instant";
import { fetchPendingInvite } from "../pending-invite";
import {
  createLobbysideIncomingCallClient,
  createLobbysideOrgIncomingCallClient,
  type LobbysideIncomingCallClient,
} from "../call-client";

const WIDGET_ID = "wid-1";
const ORG_ID = "org-1";
const APP_ID = "app-xyz";
const BASE_URL = "http://localhost:3000";

function tabId(): string {
  return sessionStorage.getItem("lobbyside_tab_id") ?? "";
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const PENDING_INVITE = {
  callId: "call-1",
  hostName: "Alex",
  hostAvatar: "https://example.com/a.png",
  widgetName: "DevRel",
  slug: "alex",
  sentAt: 0,
  widgetId: WIDGET_ID,
};

interface SubscribeCall {
  callback: (resp: { data: unknown }) => void;
}

function makeFakeDb() {
  const subscribes: SubscribeCall[] = [];
  const db = {
    joinRoom() {
      return {
        subscribeTopic: () => () => {},
        publishTopic: () => {},
        publishPresence: () => {},
        leaveRoom: () => {},
      };
    },
    subscribeQuery(_q: unknown, callback: (resp: { data: unknown }) => void) {
      subscribes.push({ callback });
      return () => {};
    },
  };
  return { db, subscribes };
}

function orgTick(activeWidgetId: string) {
  return {
    data: {
      organizations: [
        {
          id: ORG_ID,
          widgets: [
            { id: activeWidgetId, widgetConfig: [{ isActive: true }], queueEntries: [] },
          ],
        },
      ],
    },
  };
}

// Routes the boot reconciliation GET to a pending invite; heartbeat PUT/DELETE
// and everything else gets a benign empty 200.
function stubRoutedFetch(invite: unknown): Mock {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET" && url.includes("/pending-invite/")) {
      return Promise.resolve(jsonResponse({ invite }));
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("fetchPendingInvite", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GETs the encoded endpoint and returns the invite", async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({ invite: PENDING_INVITE }));
    vi.stubGlobal("fetch", mock);
    const invite = await fetchPendingInvite(BASE_URL, "wid 1", "tab/x");
    expect(invite).toMatchObject({ callId: "call-1", slug: "alex" });
    expect(mock).toHaveBeenCalledWith(
      `${BASE_URL}/api/widget/wid%201/pending-invite/tab%2Fx`,
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("returns null when the server reports no pending invite", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ invite: null })));
    expect(await fetchPendingInvite(BASE_URL, WIDGET_ID, "t")).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));
    expect(await fetchPendingInvite(BASE_URL, WIDGET_ID, "t")).toBeNull();
  });

  it("returns null (never throws) when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net")));
    expect(await fetchPendingInvite(BASE_URL, WIDGET_ID, "t")).toBeNull();
  });

  it("returns null when the invite payload is missing callId/slug", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ invite: { hostName: "x" } })));
    expect(await fetchPendingInvite(BASE_URL, WIDGET_ID, "t")).toBeNull();
  });

  it("returns null when fetch is unavailable", async () => {
    vi.stubGlobal("fetch", undefined);
    expect(await fetchPendingInvite(BASE_URL, WIDGET_ID, "t")).toBeNull();
  });
});

describe("widget-mode boot reconciliation of a mid-ring refresh", () => {
  const booted: LobbysideIncomingCallClient[] = [];
  beforeEach(() => {
    sessionStorage.clear();
    (fetchWidgetConfig as Mock).mockReset();
    (getInstantClient as Mock).mockReset();
    (getInstantClient as Mock).mockReturnValue(makeFakeDb().db);
    (fetchWidgetConfig as Mock).mockResolvedValue({
      active: true,
      instantAppId: APP_ID,
      displayData: { slug: "alex" },
    });
  });
  afterEach(() => {
    while (booted.length > 0) booted.pop()?.destroy();
    vi.unstubAllGlobals();
  });

  it("rings with the still-ringing call recovered from the server", async () => {
    stubRoutedFetch(PENDING_INVITE);
    const client = createLobbysideIncomingCallClient(WIDGET_ID, { baseUrl: BASE_URL });
    booted.push(client);
    await settle();
    const state = client.getState();
    expect(state.status).toBe("ringing");
    if (state.status === "ringing") {
      expect(state.call.callId).toBe("call-1");
      expect(state.call.hostName).toBe("Alex");
    }
  });

  it("stays idle when no call is ringing the tab", async () => {
    stubRoutedFetch(null);
    const client = createLobbysideIncomingCallClient(WIDGET_ID, { baseUrl: BASE_URL });
    booted.push(client);
    await settle();
    expect(client.getState().status).toBe("idle");
  });

  it("drops a recovered invite whose widgetId is not this widget", async () => {
    stubRoutedFetch({ ...PENDING_INVITE, widgetId: "other-widget" });
    const client = createLobbysideIncomingCallClient(WIDGET_ID, { baseUrl: BASE_URL });
    booted.push(client);
    await settle();
    expect(client.getState().status).toBe("idle");
  });

  it("GETs pending-invite for this widget + tab on boot", async () => {
    const mock = stubRoutedFetch(null);
    const client = createLobbysideIncomingCallClient(WIDGET_ID, { baseUrl: BASE_URL });
    booted.push(client);
    await settle();
    const getCalls = mock.mock.calls.filter(
      ([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") === "GET",
    );
    expect(getCalls.some(([url]) => (url as string).includes(
      `/api/widget/${WIDGET_ID}/pending-invite/${tabId()}`,
    ))).toBe(true);
  });
});

describe("org-mode boot reconciliation of a mid-ring refresh", () => {
  const booted: LobbysideIncomingCallClient[] = [];
  beforeEach(() => {
    sessionStorage.clear();
    (fetchOrgConfig as Mock).mockReset();
    (getInstantClient as Mock).mockReset();
  });
  afterEach(() => {
    while (booted.length > 0) booted.pop()?.destroy();
    vi.unstubAllGlobals();
  });

  function orgConfig(widgets: { widgetId: string; active: boolean }[]) {
    return {
      instantAppId: APP_ID,
      widgets: widgets.map((w) => ({
        ...w,
        slug: "ada",
        widgetName: "Ada",
        displayData: { slug: "ada" },
      })),
    };
  }

  it("rings when the recovered invite is for the currently-active widget", async () => {
    (getInstantClient as Mock).mockReturnValue(makeFakeDb().db);
    (fetchOrgConfig as Mock).mockResolvedValue(orgConfig([{ widgetId: "w-A", active: true }]));
    stubRoutedFetch({ ...PENDING_INVITE, widgetId: "w-A" });
    const client = createLobbysideOrgIncomingCallClient(ORG_ID, { baseUrl: BASE_URL });
    booted.push(client);
    await settle();
    expect(client.getState().status).toBe("ringing");
  });

  it("stays idle when the recovered invite is for a non-active widget", async () => {
    (getInstantClient as Mock).mockReturnValue(makeFakeDb().db);
    (fetchOrgConfig as Mock).mockResolvedValue(orgConfig([{ widgetId: "w-A", active: true }]));
    stubRoutedFetch({ ...PENDING_INVITE, widgetId: "w-B" });
    const client = createLobbysideOrgIncomingCallClient(ORG_ID, { baseUrl: BASE_URL });
    booted.push(client);
    await settle();
    expect(client.getState().status).toBe("idle");
  });

  // Bugbot regression: snapshot leaves the active widget unresolved (0 live),
  // so the ring must still recover once the live subscription names it.
  it("rings when the live subscription resolves the active widget after boot", async () => {
    const { db, subscribes } = makeFakeDb();
    (getInstantClient as Mock).mockReturnValue(db);
    (fetchOrgConfig as Mock).mockResolvedValue(orgConfig([{ widgetId: "w-A", active: false }]));
    stubRoutedFetch({ ...PENDING_INVITE, widgetId: "w-A" });
    const client = createLobbysideOrgIncomingCallClient(ORG_ID, { baseUrl: BASE_URL });
    booted.push(client);
    await settle();
    expect(client.getState().status).toBe("idle");

    subscribes[0].callback(orgTick("w-A"));
    await settle();
    const state = client.getState();
    expect(state.status).toBe("ringing");
    if (state.status === "ringing") expect(state.call.callId).toBe("call-1");
  });
});
