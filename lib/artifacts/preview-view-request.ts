/** Capture can ask a panel that has not mounted yet to show its inner Preview. */
export const ARTIFACT_PREVIEW_REQUEST_EVENT = "cognia:artifact-preview:request"
const requests = new Map<string, Set<symbol>>()

export function isArtifactPreviewRequested(artifactId: string): boolean {
  return requests.has(artifactId)
}

/** Retain the request until its caller finishes waiting, including a late mount. */
export function requestArtifactPreview(artifactId: string): () => void {
  const token = Symbol(artifactId)
  const pending = requests.get(artifactId) ?? new Set<symbol>()
  pending.add(token)
  requests.set(artifactId, pending)
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(ARTIFACT_PREVIEW_REQUEST_EVENT, { detail: { artifactId } })
    )
  }
  return () => {
    if (!pending.delete(token)) return
    if (pending.size === 0) requests.delete(artifactId)
  }
}

export function onArtifactPreviewRequest(handler: (artifactId: string) => void): () => void {
  if (typeof window === "undefined") return () => {}
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ artifactId?: unknown }>).detail
    if (typeof detail?.artifactId === "string") handler(detail.artifactId)
  }
  window.addEventListener(ARTIFACT_PREVIEW_REQUEST_EVENT, listener)
  return () => window.removeEventListener(ARTIFACT_PREVIEW_REQUEST_EVENT, listener)
}
