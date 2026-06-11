import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeToNavigation } from "../history-nav";

// popstate dispatches synchronously; pushState defers via queueMicrotask.
const flush = () => Promise.resolve();

describe("subscribeToNavigation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("notifies a subscriber on popstate and on pushState", async () => {
    const onNav = vi.fn();
    const off = subscribeToNavigation(onNav);

    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onNav).toHaveBeenCalledTimes(1);

    history.pushState({}, "", "/next");
    await flush();
    expect(onNav).toHaveBeenCalledTimes(2);

    off();
  });

  it("patches history exactly once across overlapping subscribers", () => {
    const native = history.pushState;
    const offA = subscribeToNavigation(vi.fn());
    const patched = history.pushState;
    expect(patched).not.toBe(native);

    const offB = subscribeToNavigation(vi.fn());
    // Second subscriber must NOT stack another patch.
    expect(history.pushState).toBe(patched);

    offA();
    // Still one subscriber left — patch stays.
    expect(history.pushState).toBe(patched);

    offB();
    // Last one out restores the native.
    expect(history.pushState).toBe(native);
  });

  it("keeps notifying a surviving subscriber after a non-LIFO unsubscribe", () => {
    // The regression: A subscribes, then B; A leaves first. A naive
    // save/restore would reinstall the native here and silently kill B.
    const onA = vi.fn();
    const onB = vi.fn();
    const offA = subscribeToNavigation(onA);
    const offB = subscribeToNavigation(onB);

    offA();
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(onA).not.toHaveBeenCalled();
    expect(onB).toHaveBeenCalledTimes(1);

    offB();
  });

  it("stops notifying after unsubscribe and fully restores on the last leave", () => {
    const native = history.pushState;
    const onNav = vi.fn();
    const off = subscribeToNavigation(onNav);
    off();

    expect(history.pushState).toBe(native);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(onNav).not.toHaveBeenCalled();
  });
});
