"use client"

/**
 * Which DOM node is currently showing a given artifact's preview.
 *
 * Rasterising an artifact needs the pixels, and where those pixels live depends
 * on the artifact's transport (`components/artifacts/runtime-adapters.ts`):
 *
 * - `renderer` types (chart / mermaid / math / code / document) draw as live
 *   React inside the host tree, so the only way to capture them is to hand
 *   html2canvas the mounted node. That is the same trick
 *   `lib/workflow/editor/export-image.ts` uses on `.react-flow__viewport`.
 * - `iframe` types (html / svg / react) are sandboxed, so html2canvas cannot
 *   read into them at all. Those go through `frame-capture-registry.ts`.
 *
 * Two facts make a registration more than "the node for this id":
 *
 * - **Several previews can show one artifact at once**: the chat card and the
 *   dock, or a split view. Registrations stack per id. Each disposer removes
 *   only its own entry, so unmounting the newest one falls back to the one
 *   still on screen instead of leaving the artifact "not previewed" (a single
 *   slot used to be overwritten by the last mount and emptied by its unmount).
 * - **A node shows one revision of the artifact**. Each registration reports
 *   the content its node is showing, and a capture asks for the content it
 *   wants. An export of version N whose preview has moved on to N+1 is refused
 *   (`ArtifactPreviewOutdatedError`) instead of exporting N+1's pixels as N.
 *   A preview that is merely a commit behind gets a moment to catch up.
 *
 * A plain module-level Map rather than a store: nothing renders off it, it is
 * read once per export, and a React context would force every preview to
 * re-render when an unrelated one mounted.
 */

/** Previews exist for the artifact, but none is showing the requested content. */
export class ArtifactPreviewOutdatedError extends Error {
  constructor(artifactId: string) {
    super(`artifact ${artifactId} preview is showing a different revision than the one requested`)
    this.name = "ArtifactPreviewOutdatedError"
  }
}

/**
 * How long a capture waits for a preview that is showing an older revision to
 * render the requested one: a commit or two, not a slow network render.
 */
export const PREVIEW_CATCH_UP_MS = 1_500
const CATCH_UP_POLL_MS = 50

/** One mounted preview of an artifact. */
export interface ArtifactPreviewTarget {
  node: HTMLElement
  /** The content the node is showing now, or null while it has none settled. */
  shows: () => string | null
}

type PreviewRegistration = ArtifactPreviewTarget

const registrations = new Map<string, PreviewRegistration[]>()

/**
 * Record a node painting `artifactId`, returning a disposer that removes this
 * registration only. `shows` reports the content the node currently displays.
 */
export function registerArtifactPreviewNode(
  artifactId: string,
  node: HTMLElement,
  shows: () => string | null
): () => void {
  const entry: PreviewRegistration = { node, shows }
  registrations.set(artifactId, [...(registrations.get(artifactId) ?? []), entry])
  return () => {
    const remaining = (registrations.get(artifactId) ?? []).filter((item) => item !== entry)
    if (remaining.length > 0) registrations.set(artifactId, remaining)
    else registrations.delete(artifactId)
  }
}

/**
 * The registrations whose node is still in the document, newest first. A
 * detached entry would rasterise to a blank image, so it is pruned.
 */
function attachedRegistrations(artifactId: string): PreviewRegistration[] {
  const list = registrations.get(artifactId)
  if (!list) return []
  if (typeof document === "undefined") return [...list].reverse()
  const attached = list.filter((entry) => document.contains(entry.node))
  if (attached.length !== list.length) {
    if (attached.length > 0) registrations.set(artifactId, attached)
    else registrations.delete(artifactId)
  }
  return attached.reverse()
}

/** A node on screen beats one inside a hidden surface (the dock keeps one mounted). */
function preferVisible<T extends { node: HTMLElement }>(entries: T[]): T | undefined {
  return entries.find((entry) => entry.node.closest("[hidden]") === null) ?? entries[0]
}

/** A live node for `artifactId`, whatever revision it shows, or `null`. */
export function getArtifactPreviewNode(artifactId: string): HTMLElement | null {
  return preferVisible(attachedRegistrations(artifactId))?.node ?? null
}

/**
 * The live preview showing exactly `content`; `"outdated"` when previews are
 * mounted but none shows it; `null` when there is no preview at all.
 */
export function findArtifactPreview(
  artifactId: string,
  content: string
): ArtifactPreviewTarget | "outdated" | null {
  const attached = attachedRegistrations(artifactId)
  if (attached.length === 0) return null
  return preferVisible(attached.filter((entry) => entry.shows() === content)) ?? "outdated"
}

/**
 * Poll `find` until it stops answering `"outdated"`, for at most `timeoutMs`.
 * Rejects with `ArtifactPreviewOutdatedError` if the preview never shows the
 * requested revision. Shared with `frame-capture-registry.ts`.
 */
export async function awaitPreviewRevision<T>(
  artifactId: string,
  find: () => T | "outdated" | null,
  timeoutMs: number = PREVIEW_CATCH_UP_MS
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = find()
    if (found !== "outdated") return found
    if (Date.now() >= deadline) throw new ArtifactPreviewOutdatedError(artifactId)
    await new Promise<void>((resolve) => setTimeout(resolve, CATCH_UP_POLL_MS))
  }
}

/**
 * The live preview showing `content`, waiting briefly for one a commit behind;
 * `null` when nothing is previewing the artifact.
 */
export function resolveArtifactPreview(
  artifactId: string,
  content: string,
  timeoutMs: number = PREVIEW_CATCH_UP_MS
): Promise<ArtifactPreviewTarget | null> {
  return awaitPreviewRevision(artifactId, () => findArtifactPreview(artifactId, content), timeoutMs)
}

/** Test seam — drops every registration. */
export function clearArtifactPreviewNodes(): void {
  registrations.clear()
}
