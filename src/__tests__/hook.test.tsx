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
// Partial mock of `../core/instant` — only `getInstantClient` is
// replaced. We hand-implement `subscribeToWidget` / `normalizeConfig` /
// `countQueued` because `importActual` would pull in `@instantdb/core`
// which reads `localStorage` at module init and crashes Node 25 + jsdom 29
// (pre-existing env issue; the call-client suite avoids it the same way).
vi.mock("../core/instant", () => ({
  getInstantClient: vi.fn(),
  subscribeToWidget: vi.fn(
    (
      db: { subscribeQuery: (...args: unknown[]) => () => void },
      widgetId: string,
      onUpdate: (w: unknown) => void,
    ) =>
      db.subscribeQuery(
        { widgets: { $: { where: { id: widgetId } } } },
        (resp: { data?: unknown }) => {
          const data = resp.data as { widgets?: unknown[] } | undefined;
          onUpdate(data?.widgets?.[0]);
        },
        { ruleParams: { companyId: widgetId } },
      ),
  ),
  normalizeConfig: (raw: unknown) =>
    Array.isArray(raw) ? raw[0] : raw,
  countQueued: (entries: { status?: string }[] | undefined) =>
    entries ? entries.filter((e) => e.status === "queued").length : 0,
}));

import { fetchWidgetConfig } from "../core/config";
import { fetchOrgConfig } from "../core/org-config";
import { getInstantClient } from "../core/instant";
import { useLobbyside } from "../hook";

const WIDGET_ID = "w-1";
const ORG_ID = "org-1";
const APP_ID = "app-xyz";

function makeFakeDb() {
  const db = {
    subscribeQuery() {
      return () => undefined;
    },
  };
  return { db };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  (fetchWidgetConfig as Mock).mockReset();
  (fetchOrgConfig as Mock).mockReset();
  (getInstantClient as Mock).mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useLobbyside — legacy string positional form", () => {
  it("returns loading on first paint with a widget id", () => {
    (fetchWidgetConfig as Mock).mockImplementation(
      () => new Promise<never>(() => {}),
    );
    const { result } = renderHook(() => useLobbyside(WIDGET_ID));
    expect(result.current.status).toBe("loading");
  });
});

describe("useLobbyside — options-object form: validation", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("returns INVALID_OPTIONS error AND console.errors when both widgetId and orgId are passed", () => {
    const { result } = renderHook(() =>
      useLobbyside({ widgetId: WIDGET_ID, orgId: ORG_ID }),
    );
    const state = result.current;
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.error.code).toBe("INVALID_OPTIONS");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("pass either { widgetId } or { orgId }, not both"),
    );
  });

  it("returns INVALID_OPTIONS error when neither id is passed", () => {
    const { result } = renderHook(() => useLobbyside({}));
    const state = result.current;
    expect(state.status).toBe("error");
    if (state.status !== "error") throw new Error("unreachable");
    expect(state.error.code).toBe("INVALID_OPTIONS");
  });

  it("never instantiates a client in error mode", async () => {
    renderHook(() => useLobbyside({ widgetId: WIDGET_ID, orgId: ORG_ID }));
    await act(async () => {
      await flush();
    });
    expect(fetchWidgetConfig as Mock).not.toHaveBeenCalled();
    expect(fetchOrgConfig as Mock).not.toHaveBeenCalled();
  });
});

describe("useLobbyside — options-object form: dispatch", () => {
  it("dispatches to the widget client when only widgetId is provided", async () => {
    (fetchWidgetConfig as Mock).mockResolvedValue({
      active: true,
      instantAppId: APP_ID,
      displayData: { hostName: "Ada", slug: "ada", buttonText: "Join" },
    });
    const { db } = makeFakeDb();
    (getInstantClient as Mock).mockReturnValue(db);

    const { result } = renderHook(() =>
      useLobbyside({ widgetId: WIDGET_ID }),
    );
    await act(async () => {
      await flush();
    });
    expect(fetchWidgetConfig as Mock).toHaveBeenCalledWith(
      WIDGET_ID,
      expect.any(String),
    );
    expect(result.current.status).toBe("online");
  });

  it("dispatches to the org client when only orgId is provided", async () => {
    const { db } = makeFakeDb();
    (fetchOrgConfig as Mock).mockResolvedValue({
      instantAppId: APP_ID,
      widgets: [
        {
          widgetId: "w-A",
          slug: "ada",
          widgetName: "Ada",
          active: true,
          displayData: {
            hostName: "Ada",
            hostTitle: "",
            avatarUrl: "",
            ctaText: "",
            buttonText: "Join Ada",
            meetLink: "",
            slug: "ada",
          },
        },
      ],
    });
    (getInstantClient as Mock).mockReturnValue(db);

    const { result } = renderHook(() => useLobbyside({ orgId: ORG_ID }));
    await act(async () => {
      await flush();
    });
    expect(fetchOrgConfig as Mock).toHaveBeenCalledWith(
      ORG_ID,
      expect.any(String),
    );
    const state = result.current;
    expect(state.status).toBe("online");
    if (state.status !== "online") throw new Error("unreachable");
    expect(state.buttonText).toBe("Join Ada");
  });

  it("destroys the prior client when switching modes (widget → org)", () => {
    (fetchWidgetConfig as Mock).mockImplementation(
      () => new Promise<never>(() => {}),
    );
    (fetchOrgConfig as Mock).mockImplementation(
      () => new Promise<never>(() => {}),
    );
    type Args = { args: { widgetId?: string; orgId?: string } };
    const { rerender } = renderHook<ReturnType<typeof useLobbyside>, Args>(
      ({ args }) => useLobbyside(args),
      { initialProps: { args: { widgetId: WIDGET_ID } } },
    );
    expect(fetchWidgetConfig as Mock).toHaveBeenCalledTimes(1);

    rerender({ args: { orgId: ORG_ID } });
    expect(fetchOrgConfig as Mock).toHaveBeenCalledTimes(1);
  });
});
