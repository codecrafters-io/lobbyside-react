import {
  type InstantCoreDatabase,
  type InstantUnknownSchema,
} from "@instantdb/core";

// Loose subset of the schema for the live org subscription. The server
// permission rule `ruleParams.orgId in data.ref('widget.org.id')` (see
// `instant.perms.ts`) keys this query path; without `ruleParams.orgId`
// in the subscribe call, every row is filtered out for an anonymous
// visitor and the SDK can't observe host toggles.

interface QueueEntryRow {
  status?: string;
}

interface OrgSubscribedWidgetConfig {
  isActive?: boolean;
  meetLink?: string;
  hostName?: string;
  hostTitle?: string;
  avatarUrl?: string;
  ctaText?: string;
  buttonText?: string;
  theme?: string;
  customBgColor?: string | null;
  customAccentColor?: string | null;
  boldFont?: string | null;
  maxQueueSize?: number;
}

export interface OrgSubscribedWidget {
  id?: string;
  slug?: string;
  widgetConfig?: OrgSubscribedWidgetConfig | OrgSubscribedWidgetConfig[];
  queueEntries?: QueueEntryRow[];
}

export interface OrgSubscribedOrg {
  id?: string;
  widgets?: OrgSubscribedWidget[];
}

/**
 * Subscribe to every widget under an org. Single round-trip traversal of
 * `organizations -> widgets -> widgetConfig / queueEntries`. Returns an
 * unsubscribe function. `ruleParams.orgId` mirrors the bundle's org-mode
 * subscription and is required for an anonymous visitor to read the rows.
 */
export function subscribeToOrg(
  db: InstantCoreDatabase<InstantUnknownSchema>,
  orgId: string,
  onUpdate: (org: OrgSubscribedOrg | undefined) => void,
): () => void {
  return db.subscribeQuery(
    {
      organizations: {
        $: { where: { id: orgId } },
        widgets: {
          widgetConfig: {},
          queueEntries: {},
        },
      },
    },
    (resp) => {
      if (!resp.data) return;
      const orgs = (resp.data as { organizations?: OrgSubscribedOrg[] })
        .organizations;
      onUpdate(orgs?.[0]);
    },
    { ruleParams: { orgId } },
  );
}

export function normalizeOrgWidgetConfig(
  raw: OrgSubscribedWidgetConfig | OrgSubscribedWidgetConfig[] | undefined,
): OrgSubscribedWidgetConfig | undefined {
  if (!raw) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

export function countQueuedFor(widget: OrgSubscribedWidget): number {
  const entries = widget.queueEntries;
  if (!entries) return 0;
  return entries.filter((e) => e.status === "queued").length;
}

/**
 * Reduce the live subscription payload (or the initial HTTP snapshot's
 * widgets list) to the set of widget ids that are currently switched on.
 * Single source of truth for the "which widgets are live" decision, used
 * by both the org client (renders / errors based on count) and the org
 * incoming-call client (rebinds presence rooms to the active widget).
 */
export function liveWidgetIdsFromSubscription(
  org: OrgSubscribedOrg | undefined,
): string[] {
  if (!org?.widgets) return [];
  const out: string[] = [];
  for (const w of org.widgets) {
    if (!w.id) continue;
    const cfg = normalizeOrgWidgetConfig(w.widgetConfig);
    if (cfg?.isActive) out.push(w.id);
  }
  return out;
}
