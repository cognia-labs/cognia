/**
 * The local half of whether this app uses the server-authoritative shared
 * chat plane: a per-installation preference (ADR-0252 §6, ADR-0177 batch 5).
 *
 * # Detected, not flagged
 *
 * There used to be a build-time master switch, `NEXT_PUBLIC_SHARED_CHAT_ENABLED`,
 * under this preference. It kept the plane built, tested and reachable by
 * nobody in every build that forgot it, and it decided nothing the server does
 * not already decide: a deployment that does not serve shared chat refuses its
 * routes, and says so in `/health`. Whether shared rooms are offered is now
 * detected (`./shared-chat-availability.ts`): a collaboration server is
 * configured, this account is signed in to it, and its `/health` lists
 * `shared-chat` at a protocol this client speaks.
 *
 * # What stays local
 *
 * A machine can still say no. The preference only ever subtracts: with it
 * off, nothing here touches shared chat whatever the server offers. A machine
 * that never chose behaves as if it had said yes.
 */

const PREFERENCE_STORAGE_KEY = "cognia.collab.shared-chat-enabled"
const PREFERENCE_CHANGED_EVENT = "cognia:shared-chat-preference-changed"

/** Storage seam so tests need no `localStorage`, matching `lib/collab/connection.ts`. */
export interface SharedChatPreferenceDeps {
  local?: Pick<Storage, "getItem" | "setItem" | "removeItem">
}

function store(deps: SharedChatPreferenceDeps): SharedChatPreferenceDeps["local"] | null {
  if (deps.local) return deps.local
  if (typeof localStorage === "undefined") return null
  return localStorage
}

/** The local choice, or `undefined` when this machine has never made one. */
export function readSharedChatPreference(deps: SharedChatPreferenceDeps = {}): boolean | undefined {
  const local = store(deps)
  if (!local) return undefined
  let raw: string | null = null
  try {
    raw = local.getItem(PREFERENCE_STORAGE_KEY)
  } catch {
    // Private-mode Safari and a storage-blocked webview both throw on read.
    // No stored opinion is the honest answer there.
    return undefined
  }
  if (raw === "true") return true
  if (raw === "false") return false
  return undefined
}

/** Record the local choice. `undefined` forgets it and restores the default. */
export function writeSharedChatPreference(
  enabled: boolean | undefined,
  deps: SharedChatPreferenceDeps = {}
): void {
  const local = store(deps)
  try {
    if (enabled === undefined) local?.removeItem(PREFERENCE_STORAGE_KEY)
    else local?.setItem(PREFERENCE_STORAGE_KEY, enabled ? "true" : "false")
  } catch {
    // A write that cannot land leaves the previous answer in place. Throwing
    // here would take down the settings card over a preference.
  }
  if (!deps.local && typeof window !== "undefined") {
    window.dispatchEvent(new Event(PREFERENCE_CHANGED_EVENT))
  }
}

export function subscribeSharedChatPreference(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(PREFERENCE_CHANGED_EVENT, listener)
  return () => window.removeEventListener(PREFERENCE_CHANGED_EVENT, listener)
}

/**
 * Whether this machine allows shared chat at all: the one question every
 * write path asks before it talks to the plane. Whether the server serves it
 * is the server's to answer (it refuses the routes), and what the UI offers
 * is `useSharedChatAvailability`'s.
 */
export function isSharedChatClientEnabled(deps: SharedChatPreferenceDeps = {}): boolean {
  return readSharedChatPreference(deps) !== false
}

export function assertSharedChatClientEnabled(): void {
  if (!isSharedChatClientEnabled()) throw new Error("SHARED_CHAT_DISABLED")
}
