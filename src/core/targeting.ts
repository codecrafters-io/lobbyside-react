// Faithful port of the script-tag bundle's targeting evaluator
// (`src/lib/widget/targeting.ts` in the main lobbyside repo). The SDK only
// needs the *evaluation* half: the server already resolves the host's active
// cohort down to a single `targetingFilters` object before it ships in the
// config response, so cohort normalization stays server-side. Keep the filter
// semantics in lockstep with the source or the SDK and the embed will disagree
// about who sees the widget.

const COUNTRY_CODE_MAX_LENGTH = 2;
const PATTERN_MAX_LENGTH = 200;
const COUNTRY_LIST_CAP = 250;
const PATTERN_LIST_CAP = 50;

export interface GeoFilter {
  includeCountries: string[];
  excludeCountries: string[];
}

export interface SessionFilter {
  minSeconds: number | null;
}

export interface PathFilter {
  includePatterns: string[];
  excludePatterns: string[];
}

export interface VisitedPagesFilter {
  includePatterns: string[];
  excludePatterns: string[];
}

export interface TargetingFilters {
  geo: GeoFilter;
  session: SessionFilter;
  currentPage: PathFilter;
  visitedPages: VisitedPagesFilter;
}

export interface TargetingInputs {
  filters: TargetingFilters | null | undefined;
  geo: { country: string | null } | null;
  sessionStartedAt: number;
  currentPath: string;
  visitedPathnames: string[];
  now: number;
}

export interface TargetingDecision {
  allowed: boolean;
  /** Set when blocked only by the session minimum — caller schedules re-eval. */
  retryInMs?: number;
}

export function globMatches(pattern: string, path: string): boolean {
  if (!pattern) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexSource = "^" + escaped.replace(/\*/g, ".*") + "$";
  let regex: RegExp;
  try {
    regex = new RegExp(regexSource);
  } catch {
    return false;
  }
  return regex.test(path);
}

function normalizeCountry(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  // Strict length — typo "TOO_LONG" must not silently become valid "TO".
  if (trimmed.length !== COUNTRY_CODE_MAX_LENGTH) return null;
  if (!/^[A-Z]{2}$/.test(trimmed)) return null;
  return trimmed;
}

function normalizeCountryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= COUNTRY_LIST_CAP) break;
    const cc = normalizeCountry(raw);
    if (!cc) continue;
    if (seen.has(cc)) continue;
    seen.add(cc);
    out.push(cc);
  }
  return out;
}

function normalizePattern(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, PATTERN_MAX_LENGTH);
}

function normalizePatternList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= PATTERN_LIST_CAP) break;
    const pat = normalizePattern(raw);
    if (!pat) continue;
    if (seen.has(pat)) continue;
    seen.add(pat);
    out.push(pat);
  }
  return out;
}

function normalizeMinSeconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Hard cap at 24h so a typo can't disable the widget for a year.
  return Math.min(60 * 60 * 24, Math.max(1, Math.round(n)));
}

function buildTargetingFilters(raw: unknown): TargetingFilters {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      geo: { includeCountries: [], excludeCountries: [] },
      session: { minSeconds: null },
      currentPage: { includePatterns: [], excludePatterns: [] },
      visitedPages: { includePatterns: [], excludePatterns: [] },
    };
  }
  const r = raw as Record<string, unknown>;
  const geoRaw = (r.geo as Record<string, unknown> | undefined) ?? {};
  const sessionRaw = (r.session as Record<string, unknown> | undefined) ?? {};
  const currentRaw =
    (r.currentPage as Record<string, unknown> | undefined) ?? {};
  const visitedRaw =
    (r.visitedPages as Record<string, unknown> | undefined) ?? {};

  return {
    geo: {
      includeCountries: normalizeCountryList(geoRaw.includeCountries),
      excludeCountries: normalizeCountryList(geoRaw.excludeCountries),
    },
    session: { minSeconds: normalizeMinSeconds(sessionRaw.minSeconds) },
    currentPage: {
      includePatterns: normalizePatternList(currentRaw.includePatterns),
      excludePatterns: normalizePatternList(currentRaw.excludePatterns),
    },
    visitedPages: {
      includePatterns: normalizePatternList(visitedRaw.includePatterns),
      excludePatterns: normalizePatternList(visitedRaw.excludePatterns),
    },
  };
}

export function isEmpty(filters: TargetingFilters | null | undefined): boolean {
  if (!filters) return true;
  return (
    filters.geo.includeCountries.length === 0 &&
    filters.geo.excludeCountries.length === 0 &&
    filters.session.minSeconds == null &&
    filters.currentPage.includePatterns.length === 0 &&
    filters.currentPage.excludePatterns.length === 0 &&
    filters.visitedPages.includePatterns.length === 0 &&
    filters.visitedPages.excludePatterns.length === 0
  );
}

/** Returns null when input is missing/malformed/all-empty — null means no filter. */
export function normalizeTargetingFilters(
  raw: unknown,
): TargetingFilters | null {
  const filters = buildTargetingFilters(raw);
  if (isEmpty(filters)) return null;
  return filters;
}

function evaluateGeo(geo: GeoFilter, visitorCountry: string | null): boolean {
  const cc = visitorCountry ? visitorCountry.trim().toUpperCase() : "";
  if (geo.includeCountries.length > 0) {
    if (!cc) return false;
    if (!geo.includeCountries.includes(cc)) return false;
  }
  if (geo.excludeCountries.length > 0 && cc) {
    if (geo.excludeCountries.includes(cc)) return false;
  }
  return true;
}

function evaluateCurrentPage(filter: PathFilter, currentPath: string): boolean {
  if (filter.includePatterns.length > 0) {
    if (!filter.includePatterns.some((p) => globMatches(p, currentPath))) {
      return false;
    }
  }
  if (filter.excludePatterns.length > 0) {
    if (filter.excludePatterns.some((p) => globMatches(p, currentPath))) {
      return false;
    }
  }
  return true;
}

function evaluateVisitedPages(
  filter: VisitedPagesFilter,
  visited: string[],
): boolean {
  if (filter.includePatterns.length > 0) {
    const ok = filter.includePatterns.some((pat) =>
      visited.some((path) => globMatches(pat, path)),
    );
    if (!ok) return false;
  }
  if (filter.excludePatterns.length > 0) {
    const blocked = filter.excludePatterns.some((pat) =>
      visited.some((path) => globMatches(pat, path)),
    );
    if (blocked) return false;
  }
  return true;
}

export function evaluateTargeting(input: TargetingInputs): TargetingDecision {
  const f = input.filters;
  if (!f || isEmpty(f)) return { allowed: true };

  if (!evaluateGeo(f.geo, input.geo?.country ?? null)) {
    return { allowed: false };
  }
  if (!evaluateCurrentPage(f.currentPage, input.currentPath)) {
    return { allowed: false };
  }
  if (!evaluateVisitedPages(f.visitedPages, input.visitedPathnames)) {
    return { allowed: false };
  }

  // Session check last — the retry hint must not fire while another filter
  // also blocks (we'd re-eval pointlessly and still be excluded).
  if (f.session.minSeconds && f.session.minSeconds > 0) {
    const elapsedSeconds = Math.floor(
      (input.now - input.sessionStartedAt) / 1000,
    );
    if (elapsedSeconds < f.session.minSeconds) {
      const remainingMs = (f.session.minSeconds - elapsedSeconds) * 1000;
      // Floor at 250ms so a tight loop can't spin re-renders.
      return { allowed: false, retryInMs: Math.max(remainingMs, 250) };
    }
  }

  return { allowed: true };
}
