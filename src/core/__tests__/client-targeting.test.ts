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
  getInstantClient: vi.fn(() => ({})),
  subscribeToWidget: vi.fn(() => () => undefined),
  normalizeConfig: (c: unknown) => (Array.isArray(c) ? (c as unknown[])[0] : c),
  countQueued: (entries: { status?: string }[] | undefined) =>
    (entries ?? []).filter((e) => e.status === "queued").length,
}));

import { fetchWidgetConfig, type WidgetConfigResponse } from "../config";
import { subscribeToWidget } from "../instant";
import { createLobbysideClient } from "../client";

const WIDGET_ID = "wid-1";
const APP_ID = "app-xyz";

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeConfig(
  over: {
    active?: boolean;
    country?: string | null;
    targetingFilters?: unknown;
  } = {},
): WidgetConfigResponse {
  return {
    active: over.active ?? true,
    instantAppId: APP_ID,
    geo: { country: over.country ?? "US", city: null },
    displayData: {
      hostName: "Sarup",
      hostTitle: "Founder",
      avatarUrl: "https://cdn.example/sarup.png",
      ctaText: "Got a question?",
      buttonText: "Talk to me",
      meetLink: "",
      slug: "sarup",
      targetingFilters: over.targetingFilters,
    },
  };
}

const US_ONLY = {
  geo: { includeCountries: ["US"], excludeCountries: [] },
  session: { minSeconds: null },
  currentPage: { includePatterns: [], excludePatterns: [] },
  visitedPages: { includePatterns: [], excludePatterns: [] },
};

describe("createLobbysideClient — targeting", () => {
  beforeEach(() => {
    (fetchWidgetConfig as Mock).mockReset();
    (subscribeToWidget as Mock).mockReset().mockReturnValue(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hides the widget when the active cohort excludes the visitor's country", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfig({ active: true, country: "CA", targetingFilters: US_ONLY }),
    );
    const client = createLobbysideClient(WIDGET_ID);
    await flush();
    expect(client.getState().status).toBe("hidden");
    client.destroy();
  });

  it("renders online when the cohort includes the visitor's country", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfig({ active: true, country: "US", targetingFilters: US_ONLY }),
    );
    const client = createLobbysideClient(WIDGET_ID);
    await flush();
    expect(client.getState().status).toBe("online");
    client.destroy();
  });

  it("targeting wins over offline — an excluded visitor sees nothing even when paused", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfig({ active: false, country: "CA", targetingFilters: US_ONLY }),
    );
    const client = createLobbysideClient(WIDGET_ID);
    await flush();
    expect(client.getState().status).toBe("hidden");
    client.destroy();
  });

  it("flips hidden → online when the host clears the cohort live", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfig({ active: true, country: "CA", targetingFilters: US_ONLY }),
    );
    let push: (w: unknown) => void = () => undefined;
    (subscribeToWidget as Mock).mockImplementation(
      (_db: unknown, _id: string, cb: (w: unknown) => void) => {
        push = cb;
        return () => undefined;
      },
    );
    const client = createLobbysideClient(WIDGET_ID);
    await flush();
    expect(client.getState().status).toBe("hidden");

    push({
      slug: "sarup",
      widgetConfig: { isActive: true, hostName: "Sarup", targetingFilters: null },
      queueEntries: [],
    });
    expect(client.getState().status).toBe("online");
    client.destroy();
  });

  it("arms a retry that flips hidden → online once the session minimum elapses", async () => {
    vi.useFakeTimers();
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfig({
        active: true,
        country: "US",
        targetingFilters: {
          geo: { includeCountries: [], excludeCountries: [] },
          session: { minSeconds: 2 },
          currentPage: { includePatterns: [], excludePatterns: [] },
          visitedPages: { includePatterns: [], excludePatterns: [] },
        },
      }),
    );
    const client = createLobbysideClient(WIDGET_ID);
    await flush();
    expect(client.getState().status).toBe("hidden");

    await vi.advanceTimersByTimeAsync(2000);
    expect(client.getState().status).toBe("online");
    client.destroy();
  });
});
