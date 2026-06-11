# Changelog

## 0.6.0

- **Targeting / cohorts parity.** Both hooks now honor the host's active targeting cohort (geo country, session minimum, current-page and visited-page globs), matching the script-tag embed. When the visitor is excluded, `useLobbyside` returns a new `{ status: 'hidden' }` state — render nothing. Path-scoped cohorts re-evaluate on SPA navigation, and a session-minimum cohort flips `hidden → online` automatically once enough time has elapsed. Targeting takes precedence over `offline`. No cohort configured = unchanged behavior (the hook never returns `hidden`).
- Internal: `useLobbyside` and `useLobbysideIncomingCall` now share a single, refcounted SPA-navigation source instead of each patching `history` independently — mounting both hooks on one page no longer risks one's teardown breaking the other's route tracking.

## 0.5.1

- Visitor presence/timeline fixes: report browser timezone, track SPA journey for SDK visitors, preserve the visitor session timeline across org rebinds, and refresh heartbeat identity on `setVisitor`.

## 0.5.0

- Org-wide installs: pass `{ orgId }` to either hook to track whichever widget in the org the host has switched on. Adds `NO_LIVE_WIDGET` / `MULTIPLE_LIVE_WIDGETS` error codes and `INVALID_OPTIONS` for passing both ids.
- Publish live visitor status for org installs.

## 0.4.0

- `useLobbysideIncomingCall`: make a visitor reachable from the host's Live tab, with `accept` / `decline`.

## 0.3.0

- Surface offline fallback fields (`offlineCtaUrl` / `offlineCtaText` / `offlineButtonText`) on the `offline` state.

## 0.2.0

- Initial public `useLobbyside` hook.
