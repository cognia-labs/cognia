import type {
  AuthConnectionMetadata,
  AuthConnectionRef,
} from "@cognia/plugin-contract/types/plugin/plugin-auth"

export interface ConnectionGrantOperation {
  id: string
  label: string
  integrationLabel: string
  risk: "read" | "write" | "destructive"
}

type PromptInput =
  | { kind: "picker"; candidates: AuthConnectionMetadata[] }
  | { kind: "sign-in"; providerId: string; providerLabel: string; scopes: string[] }
  | { kind: "add-scopes"; connection: AuthConnectionMetadata; scopes: string[] }
  | {
      kind: "grant"
      connection: AuthConnectionMetadata
      operations: ConnectionGrantOperation[]
      scopes: string[]
    }
export type ConnectionPrompt = PromptInput & {
  id: string
  pluginId: string
  pluginName: string
}
export type ConnectionPromptResult =
  | { kind: "selected"; ref: AuthConnectionRef }
  | { kind: "sign-in" }
  | { kind: "reconnect" }
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "dismissed" }
export interface ConnectionPromptState {
  current: ConnectionPrompt | null
  queue: ConnectionPrompt[]
}

const listeners = new Set<(state: ConnectionPromptState) => void>()
const pending = new Map<
  string,
  { request: ConnectionPrompt; resolve: (result: ConnectionPromptResult) => void }
>()

function snapshot(): ConnectionPromptState {
  const [current, ...queue] = [...pending.values()].map((entry) => entry.request)
  return { current: current ?? null, queue }
}
function notify() {
  const state = snapshot()
  for (const listener of listeners) listener(state)
}

/** No mounted Host surface (including CLI/headless) always settles immediately. */
export function requestConnectionPrompt(
  input: PromptInput & { pluginId: string; pluginName: string }
): Promise<ConnectionPromptResult> {
  if (!listeners.size) return Promise.resolve({ kind: "dismissed" })
  const request = structuredClone({ ...input, id: crypto.randomUUID() })
  return new Promise((resolve) => {
    pending.set(request.id, { request, resolve })
    notify()
  })
}

export function resolveConnectionPrompt(id: string, result: ConnectionPromptResult): void {
  // Only the active prompt can be answered, and only with its own candidates.
  const current = snapshot().current
  if (!current || current.id !== id) return
  if (result.kind === "selected") {
    if (current.kind !== "picker" || !current.candidates.some((row) => row.ref === result.ref))
      return
  } else if (result.kind === "sign-in") {
    if (current.kind !== "sign-in") return
  } else if (result.kind === "reconnect") {
    if (current.kind !== "add-scopes") return
  } else if (result.kind === "approved") {
    if (current.kind !== "grant") return
  } else if (result.kind === "denied" && current.kind !== "grant" && current.kind !== "add-scopes")
    return
  const entry = pending.get(id)!
  pending.delete(id)
  entry.resolve(result)
  notify()
}

export function subscribeConnectionPrompts(
  listener: (state: ConnectionPromptState) => void
): () => void {
  listeners.add(listener)
  listener(snapshot())
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      for (const entry of pending.values()) entry.resolve({ kind: "dismissed" })
      pending.clear()
    }
  }
}
