import { describe, expect, it } from "vitest";
import {
  evaluateTargeting,
  globMatches,
  isEmpty,
  normalizeTargetingFilters,
  type TargetingFilters,
} from "../targeting";

function filters(over: Partial<TargetingFilters> = {}): TargetingFilters {
  return {
    geo: { includeCountries: [], excludeCountries: [] },
    session: { minSeconds: null },
    currentPage: { includePatterns: [], excludePatterns: [] },
    visitedPages: { includePatterns: [], excludePatterns: [] },
    ...over,
  };
}

const BASE = {
  geo: { country: "US" as string | null },
  sessionStartedAt: 1_000,
  currentPath: "/pricing",
  visitedPathnames: ["/", "/pricing"],
  now: 1_000,
};

describe("globMatches", () => {
  it("treats * as any-run including slashes", () => {
    expect(globMatches("/docs/*", "/docs/a/b")).toBe(true);
    expect(globMatches("/docs/*", "/docs")).toBe(false);
    expect(globMatches("*", "/anything/here")).toBe(true);
  });

  it("escapes regex metacharacters in the literal segments", () => {
    expect(globMatches("/a.b", "/aXb")).toBe(false);
    expect(globMatches("/a.b", "/a.b")).toBe(true);
  });
});

describe("normalizeTargetingFilters", () => {
  it("returns null for missing / all-empty input", () => {
    expect(normalizeTargetingFilters(undefined)).toBeNull();
    expect(normalizeTargetingFilters(null)).toBeNull();
    expect(normalizeTargetingFilters({})).toBeNull();
    expect(normalizeTargetingFilters(filters())).toBeNull();
  });

  it("uppercases + dedupes country codes and drops malformed ones", () => {
    const out = normalizeTargetingFilters({
      geo: { includeCountries: ["us", "US", "USA", "c"] },
    });
    expect(out?.geo.includeCountries).toEqual(["US"]);
  });

  it("caps session minSeconds and rejects non-positive", () => {
    expect(
      normalizeTargetingFilters({ session: { minSeconds: 0 } }),
    ).toBeNull();
    expect(
      normalizeTargetingFilters({ session: { minSeconds: 999999999 } })?.session
        .minSeconds,
    ).toBe(60 * 60 * 24);
  });
});

describe("evaluateTargeting", () => {
  it("allows when filters are null/empty", () => {
    expect(evaluateTargeting({ ...BASE, filters: null }).allowed).toBe(true);
    expect(
      evaluateTargeting({ ...BASE, filters: filters() }).allowed,
    ).toBe(true);
  });

  it("geo include: blocks countries not on the list, allows ones that are", () => {
    const f = filters({ geo: { includeCountries: ["US"], excludeCountries: [] } });
    expect(evaluateTargeting({ ...BASE, filters: f }).allowed).toBe(true);
    expect(
      evaluateTargeting({ ...BASE, filters: f, geo: { country: "CA" } }).allowed,
    ).toBe(false);
    // Unknown country is blocked by an include-only filter.
    expect(
      evaluateTargeting({ ...BASE, filters: f, geo: { country: null } }).allowed,
    ).toBe(false);
  });

  it("geo exclude: blocks listed countries, allows unknown", () => {
    const f = filters({ geo: { includeCountries: [], excludeCountries: ["US"] } });
    expect(evaluateTargeting({ ...BASE, filters: f }).allowed).toBe(false);
    expect(
      evaluateTargeting({ ...BASE, filters: f, geo: { country: null } }).allowed,
    ).toBe(true);
  });

  it("currentPage include/exclude globs", () => {
    expect(
      evaluateTargeting({
        ...BASE,
        filters: filters({
          currentPage: { includePatterns: ["/pricing*"], excludePatterns: [] },
        }),
      }).allowed,
    ).toBe(true);
    expect(
      evaluateTargeting({
        ...BASE,
        currentPath: "/blog",
        filters: filters({
          currentPage: { includePatterns: ["/pricing*"], excludePatterns: [] },
        }),
      }).allowed,
    ).toBe(false);
    expect(
      evaluateTargeting({
        ...BASE,
        filters: filters({
          currentPage: { includePatterns: [], excludePatterns: ["/pricing*"] },
        }),
      }).allowed,
    ).toBe(false);
  });

  it("visitedPages matches against the whole journey", () => {
    const f = filters({
      visitedPages: { includePatterns: ["/checkout*"], excludePatterns: [] },
    });
    expect(evaluateTargeting({ ...BASE, filters: f }).allowed).toBe(false);
    expect(
      evaluateTargeting({
        ...BASE,
        visitedPathnames: ["/", "/checkout/step-1"],
        filters: f,
      }).allowed,
    ).toBe(true);
  });

  it("session minimum blocks early and returns a retry hint, then allows once elapsed", () => {
    const f = filters({ session: { minSeconds: 30 } });
    const early = evaluateTargeting({
      ...BASE,
      filters: f,
      sessionStartedAt: 0,
      now: 10_000,
    });
    expect(early.allowed).toBe(false);
    expect(early.retryInMs).toBe(20_000);

    const later = evaluateTargeting({
      ...BASE,
      filters: f,
      sessionStartedAt: 0,
      now: 31_000,
    });
    expect(later.allowed).toBe(true);
    expect(later.retryInMs).toBeUndefined();
  });

  it("does not emit a retry hint when another filter also blocks", () => {
    const f = filters({
      geo: { includeCountries: ["US"], excludeCountries: [] },
      session: { minSeconds: 30 },
    });
    const decision = evaluateTargeting({
      ...BASE,
      filters: f,
      geo: { country: "CA" },
      sessionStartedAt: 0,
      now: 0,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.retryInMs).toBeUndefined();
  });
});

describe("isEmpty", () => {
  it("is true for null and the all-empty shape", () => {
    expect(isEmpty(null)).toBe(true);
    expect(isEmpty(filters())).toBe(true);
    expect(isEmpty(filters({ session: { minSeconds: 5 } }))).toBe(false);
  });
});
