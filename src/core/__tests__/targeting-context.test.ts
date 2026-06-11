import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTargetingContext } from "../targeting-context";

const NAV_DEBOUNCE_MS = 200;

// pushState dispatch is deferred via queueMicrotask in the shared nav source;
// the context then debounces. Flush both to settle a navigation.
async function settleNav(): Promise<void> {
  await Promise.resolve();
  vi.advanceTimersByTime(NAV_DEBOUNCE_MS);
}

describe("createTargetingContext — journey tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    history.replaceState({}, "", "/");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records route changes that happen before any cohort eval (attach)", async () => {
    const ctx = createTargetingContext();

    // Loading-gap hops: no attach() yet, mirroring the pre-config-fetch window.
    history.pushState({}, "", "/pricing");
    await settleNav();
    history.pushState({}, "", "/docs");
    await settleNav();

    const snap = ctx.snapshot();
    expect(snap.currentPath).toBe("/docs");
    expect(snap.visitedPathnames).toContain("/pricing");
    expect(snap.visitedPathnames).toContain("/docs");

    ctx.destroy();
  });

  it("notifies the attached callback on later navigations", async () => {
    const ctx = createTargetingContext();
    const onNav = vi.fn();
    ctx.attach(onNav);

    history.pushState({}, "", "/about");
    await settleNav();

    expect(onNav).toHaveBeenCalledTimes(1);
    expect(ctx.snapshot().visitedPathnames).toContain("/about");

    ctx.destroy();
  });
});
