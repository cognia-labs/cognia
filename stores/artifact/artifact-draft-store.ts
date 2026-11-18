"use client"

/**
 * Unsaved text the user is editing in an artifact panel, per artifact.
 *
 * The edit buffer used to be component state inside `useArtifactPanelState`.
 * The dock mounts one panel per artifact tab (keyed by id), and "Edit" always
 * seeded the buffer from the committed content, so switching to another tab
 * and back, a background Preview request, or a collapse that remounted the
 * panel each threw the unsaved text away without a word. Keeping the buffer
 * here, keyed by artifact, lets any of those leave edit mode and come back to
 * exactly what was typed.
 *
 * Each draft remembers the committed content it was started from
 * (`baseContent`). Saving compares that with what is committed *now*: a
 * revision written meanwhile (an applied AI proposal, an agent update, a
 * restored version) is a conflict the user resolves, not something the save
 * silently replaces.
 *
 * Runtime-only on purpose. A draft lives as long as the app session, which is
 * what moving between tabs, conversations and layouts needs; persisting edit
 * buffers across reloads would be a second store of artifact content with its
 * own staleness to manage.
 */

import { create } from "zustand"

import { useArtifactStore } from "@/stores/artifact/artifact-store"

export interface ArtifactDraft {
  /** What the editor holds. */
  content: string
  /** The committed content the draft was started from. */
  baseContent: string
  /** The committed version number the draft was started from. */
  baseVersion: number
}

interface ArtifactDraftState {
  drafts: Record<string, ArtifactDraft>
  /** Start a draft from the committed content, unless one already exists. */
  beginDraft: (artifactId: string, base: { content: string; version: number }) => ArtifactDraft
  /** Replace the draft's text, keeping the base it was started from. */
  updateDraft: (artifactId: string, content: string) => void
  /** Drop the draft (saved, cancelled, or discarded). */
  clearDraft: (artifactId: string) => void
  /** Drop every draft whose artifact no longer exists. */
  pruneDrafts: (existingIds: ReadonlySet<string>) => void
}

export const useArtifactDraftStore = create<ArtifactDraftState>()((set, get) => ({
  drafts: {},
  beginDraft: (artifactId, base) => {
    const existing = get().drafts[artifactId]
    if (existing) return existing
    const draft: ArtifactDraft = {
      content: base.content,
      baseContent: base.content,
      baseVersion: base.version,
    }
    set((state) => ({ drafts: { ...state.drafts, [artifactId]: draft } }))
    return draft
  },
  updateDraft: (artifactId, content) =>
    set((state) => {
      const draft = state.drafts[artifactId]
      if (!draft || draft.content === content) return state
      return { drafts: { ...state.drafts, [artifactId]: { ...draft, content } } }
    }),
  clearDraft: (artifactId) =>
    set((state) => {
      if (!(artifactId in state.drafts)) return state
      const { [artifactId]: _cleared, ...drafts } = state.drafts
      return { drafts }
    }),
  pruneDrafts: (existingIds) =>
    set((state) => {
      const stale = Object.keys(state.drafts).filter((id) => !existingIds.has(id))
      if (stale.length === 0) return state
      const drafts = { ...state.drafts }
      for (const id of stale) delete drafts[id]
      return { drafts }
    }),
}))

/** Whether the draft holds text that differs from the content it started from. */
export function isDraftDirty(draft: ArtifactDraft | undefined): boolean {
  return draft !== undefined && draft.content !== draft.baseContent
}

/**
 * Whether the committed content moved on since the draft was started, so
 * saving it would replace a revision the user never saw.
 */
export function isDraftConflicted(
  draft: ArtifactDraft | undefined,
  committedContent: string | undefined
): boolean {
  return (
    draft !== undefined && committedContent !== undefined && committedContent !== draft.baseContent
  )
}

// A deleted artifact's draft has nothing to be saved into. Watching the
// collection keeps the store from accumulating them across a long session.
useArtifactStore.subscribe((state, previous) => {
  if (state.artifacts === previous.artifacts) return
  if (Object.keys(useArtifactDraftStore.getState().drafts).length === 0) return
  useArtifactDraftStore.getState().pruneDrafts(new Set(Object.keys(state.artifacts)))
})
