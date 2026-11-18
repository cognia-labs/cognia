/** @jest-environment jsdom */
import {
  ArtifactPreviewOutdatedError,
  clearArtifactPreviewNodes,
  findArtifactPreview,
  getArtifactPreviewNode,
  registerArtifactPreviewNode,
  resolveArtifactPreview,
} from "./preview-registry"

afterEach(() => {
  clearArtifactPreviewNodes()
  document.body.innerHTML = ""
  jest.useRealTimers()
})

function mount(parent: HTMLElement = document.body): HTMLElement {
  const el = document.createElement("div")
  parent.appendChild(el)
  return el
}

/** A registration showing `content`, changeable later. */
function showing(content: string | null) {
  const state = { content }
  return { state, shows: () => state.content }
}

describe("artifact preview registry", () => {
  it("returns null for an unknown artifact", () => {
    expect(getArtifactPreviewNode("nope")).toBeNull()
    expect(findArtifactPreview("nope", "x")).toBeNull()
  })

  it("hands back the node that is painting the artifact", () => {
    const el = mount()
    registerArtifactPreviewNode("a1", el, () => "v1")
    expect(getArtifactPreviewNode("a1")).toBe(el)
    expect(findArtifactPreview("a1", "v1")).toMatchObject({ node: el })
  })

  it("drops a node that has been detached from the document", () => {
    // A stale entry would rasterise to a blank image — worse than a typed
    // failure the caller can explain.
    const el = mount()
    registerArtifactPreviewNode("a1", el, () => "v1")
    el.remove()
    expect(getArtifactPreviewNode("a1")).toBeNull()
    // …and the entry is gone, not merely filtered.
    document.body.appendChild(el)
    expect(getArtifactPreviewNode("a1")).toBeNull()
  })

  it("prefers the newest preview while several show the artifact", () => {
    const card = mount()
    registerArtifactPreviewNode("a1", card, () => "v1")
    const dock = mount()
    registerArtifactPreviewNode("a1", dock, () => "v1")
    expect(getArtifactPreviewNode("a1")).toBe(dock)
  })

  it("falls back to a preview still on screen when the newest unmounts (C08)", () => {
    // A single slot was overwritten by the dock and emptied by its unmount,
    // leaving the chat card's preview unreachable.
    const card = mount()
    registerArtifactPreviewNode("a1", card, () => "v1")
    const dock = mount()
    const disposeDock = registerArtifactPreviewNode("a1", dock, () => "v1")
    disposeDock()
    expect(getArtifactPreviewNode("a1")).toBe(card)
  })

  it("a disposer removes only its own registration", () => {
    const first = mount()
    const disposeFirst = registerArtifactPreviewNode("a1", first, () => "v1")
    const second = mount()
    registerArtifactPreviewNode("a1", second, () => "v1")
    disposeFirst()
    expect(getArtifactPreviewNode("a1")).toBe(second)
    disposeFirst()
    expect(getArtifactPreviewNode("a1")).toBe(second)
  })

  it("prefers a preview on screen over one in a hidden surface", () => {
    const hidden = document.createElement("div")
    hidden.hidden = true
    document.body.appendChild(hidden)
    const visible = mount()
    registerArtifactPreviewNode("a1", visible, () => "v1")
    registerArtifactPreviewNode("a1", mount(hidden), () => "v1")
    expect(findArtifactPreview("a1", "v1")).toMatchObject({ node: visible })
  })

  it("picks the preview showing the requested revision (C08)", () => {
    const old = mount()
    registerArtifactPreviewNode("a1", old, () => "v1")
    registerArtifactPreviewNode("a1", mount(), () => "v2")
    expect(findArtifactPreview("a1", "v1")).toMatchObject({ node: old })
  })

  it("reports previews showing another revision as outdated, not as missing", () => {
    registerArtifactPreviewNode("a1", mount(), () => "v2")
    expect(findArtifactPreview("a1", "v1")).toBe("outdated")
  })

  it("waits for a preview a commit behind to catch up", async () => {
    jest.useFakeTimers()
    const { state, shows } = showing("v1")
    const el = mount()
    registerArtifactPreviewNode("a1", el, shows)
    const pending = resolveArtifactPreview("a1", "v2")
    state.content = "v2"
    await jest.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toMatchObject({ node: el })
  })

  it("refuses a revision the preview never shows (C08)", async () => {
    jest.useFakeTimers()
    registerArtifactPreviewNode("a1", mount(), () => "v2")
    const pending = resolveArtifactPreview("a1", "v1", 500)
    const assertion = expect(pending).rejects.toBeInstanceOf(ArtifactPreviewOutdatedError)
    await jest.advanceTimersByTimeAsync(600)
    await assertion
  })

  it("resolves to null without waiting when nothing previews the artifact", async () => {
    await expect(resolveArtifactPreview("a1", "v1")).resolves.toBeNull()
  })
})
