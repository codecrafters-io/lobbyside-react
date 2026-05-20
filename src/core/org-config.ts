import { LobbysideError } from "./errors";

/**
 * Shape of a successful GET /api/widget/org/{orgId}/config response.
 *
 * Mirrors the server handler at:
 *   src/app/api/widget/org/[orgId]/config/route.ts
 *
 * Each entry under `widgets` carries the same `displayData` shape that
 * the per-widget config endpoint returns at the top level, so the org
 * client can pick whichever widget the host has switched on without an
 * extra round-trip.
 */
export interface OrgWidgetEntry {
  widgetId: string;
  slug: string;
  widgetName: string;
  active: boolean;
  displayData: {
    hostName: string;
    hostTitle: string;
    avatarUrl: string;
    ctaText: string;
    buttonText: string;
    meetLink: string;
    slug: string;
    widgetName?: string;
    theme?: string;
    customBgColor?: string | null;
    customAccentColor?: string | null;
    postCallBehavior?: string;
    postCallCooldownSeconds?: number;
    formNameMode?: string;
    formCompanyMode?: string;
    formEmailMode?: string;
    formEmailVerification?: boolean;
    formLinkedinMode?: string;
    formGithubMode?: string;
    boldFont?: string | null;
    maxQueueSize?: number;
    offlineCtaUrl?: string;
    offlineCtaText?: string;
    offlineButtonText?: string;
  };
}

export interface OrgConfigResponse {
  instantAppId: string;
  geo?: { country: string | null; city: string | null };
  widgets: OrgWidgetEntry[];
}

/**
 * Fetch the initial org config. Resolves on 2xx, throws LobbysideError
 * on every other path. Used once on mount to drive first-paint; live
 * org changes (widget toggled on/off, edits) arrive via InstantDB.
 */
export async function fetchOrgConfig(
  orgId: string,
  baseUrl: string,
): Promise<OrgConfigResponse> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/widget/org/${orgId}/config`, {
      method: "GET",
    });
  } catch (err) {
    throw new LobbysideError(
      "NETWORK",
      `Failed to reach Lobbyside: ${(err as Error).message}`,
    );
  }

  if (res.status === 404) {
    throw new LobbysideError(
      "NOT_FOUND",
      `Org ${orgId} not found at ${baseUrl}.`,
    );
  }

  if (!res.ok) {
    throw new LobbysideError(
      "NETWORK",
      `Org config request failed with HTTP ${res.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LobbysideError(
      "NETWORK",
      "Org config response was not valid JSON.",
    );
  }

  const parsed = body as OrgConfigResponse;
  if (typeof parsed.instantAppId !== "string" || parsed.instantAppId === "") {
    // Same defensive check as `fetchWidgetConfig`: if the consumer proxies
    // the endpoint and strips the field, crash crisply rather than fall
    // through to an opaque InstantDB-side error three steps later.
    throw new LobbysideError(
      "NETWORK",
      "Org config response missing instantAppId.",
    );
  }
  if (!Array.isArray(parsed.widgets)) {
    throw new LobbysideError(
      "NETWORK",
      "Org config response missing widgets array.",
    );
  }
  return parsed;
}
