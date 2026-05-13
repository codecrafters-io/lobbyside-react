// Mirrors lobbyside/src/lib/widget/visitor-call-prefill.ts. Kept in sync by
// hand because lobbyside-react publishes independently — the call-page
// decoder (`#lb_v=<encoded-json>`) is the wire contract. Update both
// together if FIELD_CAPS or the hash key ever change.

export interface VisitorPrefillData {
  name?: string;
  email?: string;
  company?: string;
  linkedin?: string;
  github?: string;
}

export const VISITOR_PREFILL_HASH_KEY = "lb_v";

const FIELD_CAPS: Record<keyof VisitorPrefillData, number> = {
  name: 200,
  email: 320,
  company: 200,
  linkedin: 500,
  github: 200,
};

function sanitize(raw: unknown): VisitorPrefillData {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: VisitorPrefillData = {};
  for (const key of Object.keys(FIELD_CAPS) as (keyof VisitorPrefillData)[]) {
    const v = r[key];
    if (typeof v !== "string") continue;
    const trimmed = v.trim().slice(0, FIELD_CAPS[key]);
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

export function encodeVisitorPrefillHash(raw: unknown): string {
  const data = sanitize(raw);
  if (Object.keys(data).length === 0) return "";
  return `${VISITOR_PREFILL_HASH_KEY}=${encodeURIComponent(JSON.stringify(data))}`;
}
