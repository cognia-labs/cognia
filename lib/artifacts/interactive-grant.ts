/** Runtime-only HTML permission shared by the preview and its new-tab action. */
import type { Artifact } from "@/types"
import { hasInteractiveContent } from "./interactive-html"

type InteractiveArtifact = Pick<Artifact, "id" | "type" | "content">
const grants = new Map<string, Set<symbol>>()
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

export function subscribeInteractiveGrants(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function offersInteractiveHtml(artifact: InteractiveArtifact, enabled: boolean): boolean {
  return artifact.type === "html" && enabled && hasInteractiveContent(artifact.content)
}

export function isInteractiveHtmlGranted(artifact: InteractiveArtifact, enabled: boolean): boolean {
  return offersInteractiveHtml(artifact, enabled) && grants.has(artifact.id)
}

/** The granting preview owns the release; another mount cannot revoke its grant. */
export function grantInteractiveHtml(artifact: InteractiveArtifact): () => void {
  const token = Symbol(artifact.id)
  const entries = grants.get(artifact.id) ?? new Set<symbol>()
  entries.add(token)
  grants.set(artifact.id, entries)
  notify()
  return () => {
    if (!entries.delete(token)) return
    if (entries.size === 0) grants.delete(artifact.id)
    notify()
  }
}
