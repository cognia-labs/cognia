/**
 * @jest-environment jsdom
 */
import {
  isDraftConflicted,
  isDraftDirty,
  useArtifactDraftStore,
} from "@/stores/artifact/artifact-draft-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"

beforeEach(() => {
  useArtifactDraftStore.setState({ drafts: {} })
})

describe("artifact draft store", () => {
  it("starts a draft once and resumes it afterwards", () => {
    const store = useArtifactDraftStore.getState()
    store.beginDraft("a", { content: "base", version: 1 })
    store.updateDraft("a", "typed")
    const resumed = useArtifactDraftStore
      .getState()
      .beginDraft("a", { content: "newer", version: 2 })
    expect(resumed).toEqual({ content: "typed", baseContent: "base", baseVersion: 1 })
  })

  it("is dirty only when the text differs from its base", () => {
    const store = useArtifactDraftStore.getState()
    store.beginDraft("a", { content: "base", version: 1 })
    expect(isDraftDirty(useArtifactDraftStore.getState().drafts.a)).toBe(false)
    store.updateDraft("a", "typed")
    expect(isDraftDirty(useArtifactDraftStore.getState().drafts.a)).toBe(true)
    store.updateDraft("a", "base")
    expect(isDraftDirty(useArtifactDraftStore.getState().drafts.a)).toBe(false)
    expect(isDraftDirty(undefined)).toBe(false)
  })

  it("conflicts when the committed content moved away from the draft's base", () => {
    const draft = { content: "typed", baseContent: "base", baseVersion: 1 }
    expect(isDraftConflicted(draft, "base")).toBe(false)
    expect(isDraftConflicted(draft, "v2")).toBe(true)
    expect(isDraftConflicted(undefined, "v2")).toBe(false)
    expect(isDraftConflicted(draft, undefined)).toBe(false)
  })

  it("ignores updates for an artifact without a draft", () => {
    useArtifactDraftStore.getState().updateDraft("missing", "x")
    expect(useArtifactDraftStore.getState().drafts).toEqual({})
  })

  it("clears one draft", () => {
    const store = useArtifactDraftStore.getState()
    store.beginDraft("a", { content: "1", version: 1 })
    store.beginDraft("b", { content: "2", version: 1 })
    store.clearDraft("a")
    expect(Object.keys(useArtifactDraftStore.getState().drafts)).toEqual(["b"])
  })

  it("drops the draft of an artifact that was deleted", () => {
    const artifact = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "A",
      content: "x",
    })
    useArtifactDraftStore.getState().beginDraft(artifact.id, { content: "x", version: 1 })
    useArtifactDraftStore.getState().beginDraft("never-existed", { content: "y", version: 1 })
    useArtifactStore.getState().deleteArtifact(artifact.id)
    expect(useArtifactDraftStore.getState().drafts).toEqual({})
  })
})
