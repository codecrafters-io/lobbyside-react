// Per-tab UUID used as the host→visitor invite room key. Sharing the
// sessionStorage key with the script-tag widget (public/widget.js) means a
// page that loads both still surfaces as one visitor in the host's Live tab.

const TAB_KEY = "lobbyside_tab_id";

let memoryFallback: string | null = null;

function safeRandomUUID(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getOrCreateTabId(): string {
  try {
    if (typeof sessionStorage !== "undefined") {
      let id = sessionStorage.getItem(TAB_KEY);
      if (!id) {
        id = safeRandomUUID();
        sessionStorage.setItem(TAB_KEY, id);
      }
      return id;
    }
  } catch {
    // Safari private mode / sandboxed iframe with storage blocked — fall
    // through to a memory-only id good for the page lifetime.
  }
  if (!memoryFallback) memoryFallback = safeRandomUUID();
  return memoryFallback;
}
