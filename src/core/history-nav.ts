// Single, refcounted SPA-navigation source for the whole page. Both the
// targeting context (useLobbyside) and the presence timeline
// (useLobbysideIncomingCall) subscribe here instead of each monkey-patching
// `history.pushState` themselves. Independent patches stack, and a naive
// save/restore breaks the other hook's tracking on non-LIFO teardown — so
// `history` is patched exactly once (on the first subscriber) and restored
// once (when the last unsubscribes), no matter how many hooks are mounted.

let listeners: Set<() => void> | null = null;
let restore: (() => void) | null = null;

function ensurePatched(): void {
  if (restore || typeof window === "undefined") return;

  const dispatch = (): void => {
    if (!listeners) return;
    // Snapshot first — a listener may unsubscribe during iteration.
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        // best-effort — one bad listener must not strand the others.
      }
    }
  };

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function patchedPush(this: History, ...args) {
    const ret = origPush.apply(this, args as Parameters<typeof origPush>);
    queueMicrotask(dispatch);
    return ret;
  };
  history.replaceState = function patchedReplace(this: History, ...args) {
    const ret = origReplace.apply(
      this,
      args as Parameters<typeof origReplace>,
    );
    queueMicrotask(dispatch);
    return ret;
  };
  window.addEventListener("popstate", dispatch);
  window.addEventListener("hashchange", dispatch);

  restore = () => {
    history.pushState = origPush;
    history.replaceState = origReplace;
    window.removeEventListener("popstate", dispatch);
    window.removeEventListener("hashchange", dispatch);
  };
}

/**
 * Subscribe to SPA route changes. Returns an unsubscribe. No-op (and a no-op
 * teardown) without a DOM. Safe to call from any number of hooks; the history
 * patch is shared and torn down only when the final subscriber leaves.
 */
export function subscribeToNavigation(onNavigate: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  if (!listeners) listeners = new Set();
  ensurePatched();
  listeners.add(onNavigate);
  return () => {
    if (!listeners) return;
    listeners.delete(onNavigate);
    if (listeners.size === 0) {
      restore?.();
      restore = null;
      listeners = null;
    }
  };
}
