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
  normalizeConfig: (c: unknown) =>
    Array.isArray(c) ? (c as unknown[])[0] : c,
  countQueued: (entries: { status?: string }[] | undefined) =>
    (entries ?? []).filter((e) => e.status === "queued").length,
}));

import { fetchWidgetConfig, type WidgetConfigResponse } from "../config";
import { subscribeToWidget } from "../instant";
import { createLobbysideClient } from "../client";

const WIDGET_ID = "wid-1";
const APP_ID = "app-xyz";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function makeConfigResponse(
  over: Partial<WidgetConfigResponse["displayData"]> & {
    active?: boolean;
  } = {},
): WidgetConfigResponse {
  const { active, ...display } = over;
  return {
    active: active ?? false,
    instantAppId: APP_ID,
    displayData: {
      hostName: "Sarup",
      hostTitle: "Founder",
      avatarUrl: "https://cdn.example/sarup.png",
      ctaText: "Got a question?",
      buttonText: "Talk to me",
      meetLink: "",
      slug: "sarup",
      offlineCtaUrl: "https://cal.com/sarup",
      offlineCtaText: "Out fishing, back tomorrow.",
      offlineButtonText: "Grab a slot",
      ...display,
    },
  };
}

describe("createLobbysideClient — offline fallback fields", () => {
  beforeEach(() => {
    (fetchWidgetConfig as Mock).mockReset();
    (subscribeToWidget as Mock).mockReset().mockReturnValue(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces offlineCtaUrl/Text/ButtonText on the offline state", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfigResponse({ active: false }),
    );
    const client = createLobbysideClient(WIDGET_ID, {
      baseUrl: "http://localhost:3000",
    });

    await flushMicrotasks();
    const state = client.getState();

    expect(state.status).toBe("offline");
    if (state.status !== "offline") throw new Error("expected offline");
    expect(state.offlineCtaUrl).toBe("https://cal.com/sarup");
    expect(state.offlineCtaText).toBe("Out fishing, back tomorrow.");
    expect(state.offlineButtonText).toBe("Grab a slot");
    // Identity fields still present alongside the offline slice.
    expect(state.hostName).toBe("Sarup");
    expect(state.avatarUrl).toBe("https://cdn.example/sarup.png");

    client.destroy();
  });

  it("falls back to empty strings when the host hasn't configured offline fields", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfigResponse({
        active: false,
        offlineCtaUrl: undefined,
        offlineCtaText: undefined,
        offlineButtonText: undefined,
      }),
    );
    const client = createLobbysideClient(WIDGET_ID, {
      baseUrl: "http://localhost:3000",
    });

    await flushMicrotasks();
    const state = client.getState();

    expect(state.status).toBe("offline");
    if (state.status !== "offline") throw new Error("expected offline");
    expect(state.offlineCtaUrl).toBe("");
    expect(state.offlineCtaText).toBe("");
    expect(state.offlineButtonText).toBe("");

    client.destroy();
  });

  it("keeps the offline state in sync when InstantDB pushes a new offlineCtaUrl", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfigResponse({ active: false }),
    );
    let pushUpdate: (widget: unknown) => void = () => undefined;
    (subscribeToWidget as Mock).mockImplementation(
      (_db: unknown, _id: string, cb: (w: unknown) => void) => {
        pushUpdate = cb;
        return () => undefined;
      },
    );

    const client = createLobbysideClient(WIDGET_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flushMicrotasks();

    pushUpdate({
      slug: "sarup",
      widgetConfig: {
        isActive: false,
        hostName: "Sarup",
        offlineCtaUrl: "https://cal.com/sarup-2",
        offlineCtaText: "Different text now.",
        offlineButtonText: "Reserve",
      },
      queueEntries: [],
    });

    const state = client.getState();
    expect(state.status).toBe("offline");
    if (state.status !== "offline") throw new Error("expected offline");
    expect(state.offlineCtaUrl).toBe("https://cal.com/sarup-2");
    expect(state.offlineCtaText).toBe("Different text now.");
    expect(state.offlineButtonText).toBe("Reserve");

    client.destroy();
  });

  it("does not expose offline fields on the online state (compile-time discriminator)", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfigResponse({ active: true }),
    );
    const client = createLobbysideClient(WIDGET_ID, {
      baseUrl: "http://localhost:3000",
    });

    await flushMicrotasks();
    const state = client.getState();

    expect(state.status).toBe("online");
    if (state.status !== "online") throw new Error("expected online");
    expect((state as { offlineCtaUrl?: string }).offlineCtaUrl).toBeUndefined();

    client.destroy();
  });

  it("surfaces fields fresh when the host flips offline → online → offline", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue(
      makeConfigResponse({ active: false }),
    );
    let pushUpdate: (widget: unknown) => void = () => undefined;
    (subscribeToWidget as Mock).mockImplementation(
      (_db: unknown, _id: string, cb: (w: unknown) => void) => {
        pushUpdate = cb;
        return () => undefined;
      },
    );

    const client = createLobbysideClient(WIDGET_ID, {
      baseUrl: "http://localhost:3000",
    });
    await flushMicrotasks();
    expect(client.getState().status).toBe("offline");

    pushUpdate({
      slug: "sarup",
      widgetConfig: { isActive: true, hostName: "Sarup" },
      queueEntries: [],
    });
    expect(client.getState().status).toBe("online");

    pushUpdate({
      slug: "sarup",
      widgetConfig: {
        isActive: false,
        hostName: "Sarup",
        offlineCtaUrl: "https://cal.com/sarup",
        offlineButtonText: "Book",
      },
      queueEntries: [],
    });
    const final = client.getState();
    expect(final.status).toBe("offline");
    if (final.status !== "offline") throw new Error("expected offline");
    expect(final.offlineCtaUrl).toBe("https://cal.com/sarup");
    expect(final.offlineButtonText).toBe("Book");

    client.destroy();
  });
});
