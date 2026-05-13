import { describe, expect, it } from "vitest";
import {
  VISITOR_PREFILL_HASH_KEY,
  encodeVisitorPrefillHash,
} from "../visitor-prefill";

describe("encodeVisitorPrefillHash", () => {
  it("returns empty for null / non-object / no string fields", () => {
    expect(encodeVisitorPrefillHash(null)).toBe("");
    expect(encodeVisitorPrefillHash(undefined)).toBe("");
    expect(encodeVisitorPrefillHash(42)).toBe("");
    expect(encodeVisitorPrefillHash({})).toBe("");
    expect(encodeVisitorPrefillHash({ name: 123 })).toBe("");
  });

  it("encodes known fields with the lb_v key", () => {
    const out = encodeVisitorPrefillHash({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });
    expect(out.startsWith(`${VISITOR_PREFILL_HASH_KEY}=`)).toBe(true);
    const payload = decodeURIComponent(out.slice(VISITOR_PREFILL_HASH_KEY.length + 1));
    const decoded = JSON.parse(payload);
    expect(decoded).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("trims and drops empty strings", () => {
    const out = encodeVisitorPrefillHash({ name: "  ", email: "  a@b.co  " });
    const decoded = JSON.parse(
      decodeURIComponent(out.slice(VISITOR_PREFILL_HASH_KEY.length + 1)),
    );
    expect(decoded).toEqual({ email: "a@b.co" });
  });

  it("caps long values", () => {
    const longName = "x".repeat(500);
    const out = encodeVisitorPrefillHash({ name: longName });
    const decoded = JSON.parse(
      decodeURIComponent(out.slice(VISITOR_PREFILL_HASH_KEY.length + 1)),
    );
    expect(decoded.name.length).toBe(200);
  });

  it("ignores unknown keys", () => {
    const out = encodeVisitorPrefillHash({
      name: "Ada",
      bogus: "x",
      role: "admin",
    });
    const decoded = JSON.parse(
      decodeURIComponent(out.slice(VISITOR_PREFILL_HASH_KEY.length + 1)),
    );
    expect(decoded).toEqual({ name: "Ada" });
  });

  it("returns empty when JSON.parse would choke (best-effort sanitize)", () => {
    expect(encodeVisitorPrefillHash("not-an-object")).toBe("");
  });
});
