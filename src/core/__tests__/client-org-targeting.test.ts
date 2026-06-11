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

function makeFakeDb() {
  const subscribes: { callback: (r: { data: unknown }) => void }[] = [];
  const db = {
    subscribeQuery(
      _q: unknown,
      cb: (resp: { data: unknown }) => void,
      _opts: unknown,
    ) {
      subscribes.push({ callback: cb });
      return vi.fn();
    },
  };
  return { db, subscribes };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

const US_ONLY = {
  geo: { includeCountries: ["US"], excludeCountries: [] },
  session: { minSeconds: null },
  currentPage: { includePatterns: [], excludePatterns: [] },
  visitedPages: { includePatterns: [], excludePatterns: [] },
};

function widget(over: Record<string, unknown> = {}) {
  return {
    widgetId: "w-A",
    slug: "ada",
    widgetName: "Ada",
    active: true,
    displayData: {
      hostName: "Ada",
      hostTitle: "CEO",
      avatarUrl: "https://img/a.png",
      ctaText: "Hi",
      buttonText: "Join",
      meetLink: "",
      slug: "ada",
      maxQueueSize: 5,
      ...over,
    },
  };
}

beforeEach(() => {
  (fetchOrgConfig as Mock).mockReset();
  (getInstantClient as Mock).mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLobbysideOrgClient — targeting", () => {
  it("hides when the single live widget's cohort excludes the visitor", async () => {
    const { db } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      geo: { country: "CA", city: null },
      widgets: [widget({ targetingFilters: US_ONLY })],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    expect(client.getState().status).toBe("hidden");
  });

  it("renders online when the cohort includes the visitor", async () => {
    const { db } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      geo: { country: "US", city: null },
      widgets: [widget({ targetingFilters: US_ONLY })],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    const state = client.getState();
    expect(state.status).toBe("online");
    if (state.status !== "online") throw new Error("unreachable");
    expect(state.hostName).toBe("Ada");
  });

  it("flips hidden → online when the host clears the cohort live", async () => {
    const { db, subscribes } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      geo: { country: "CA", city: null },
      widgets: [widget({ targetingFilters: US_ONLY })],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const client = createLobbysideOrgClient(ORG_ID);
    await flush();
    expect(client.getState().status).toBe("hidden");

    subscribes[0].callback({
      data: {
        organizations: [
          {
            id: ORG_ID,
            widgets: [
              {
                id: "w-A",
                slug: "ada",
                widgetConfig: [
                  { isActive: true, hostName: "Ada", targetingFilters: null },
                ],
                queueEntries: [],
              },
            ],
          },
        ],
      },
    });
    expect(client.getState().status).toBe("online");
  });
});
