import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOrCreateTabId } from "../tab-id";

describe("getOrCreateTabId", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it("generates a new id when none stored", () => {
    const id = getOrCreateTabId();
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(sessionStorage.getItem("lobbyside_tab_id")).toBe(id);
  });

  it("reuses an existing stored id", () => {
    sessionStorage.setItem("lobbyside_tab_id", "preset-id");
    expect(getOrCreateTabId()).toBe("preset-id");
  });

  it("is stable across calls in the same tab", () => {
    const a = getOrCreateTabId();
    const b = getOrCreateTabId();
    expect(a).toBe(b);
  });
});
