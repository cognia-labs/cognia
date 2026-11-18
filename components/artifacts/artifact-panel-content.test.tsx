/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent } from "@testing-library/react"

import { __resetArtifactPickersForTests } from "@/lib/artifacts/element-pick-registry"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

jest.mock("@/lib/tauri/opener", () => ({
  revealInExplorer: jest.fn(),
  openPath: jest.fn(),
}))

jest.mock("next/dynamic", () => () => {
  const MockMonaco = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="monaco" value={value} onChange={(e) => onChange(e.target.value)} />
  )
  MockMonaco.displayName = "MockMonacoEditor"
  return MockMonaco
})

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code">{code}</pre>,
}))

jest.mock("./artifact-preview", () => ({
  ArtifactPreview: () => <div data-testid="preview" />,
}))

jest.mock("./artifact-list", () => ({
  ArtifactList: () => <div data-testid="list" />,
}))

jest.mock("./panel-version-history", () => ({
  PanelVersionHistory: () => <div data-testid="history" />,
}))

jest.mock("@/components/editor/light-code-editor", () => ({
  LightCodeEditor: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="light-code-editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}))

import { ArtifactPanelContent } from "./artifact-panel-content"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDraftStore } from "@/stores/artifact/artifact-draft-store"
import { useChatStore } from "@/stores/chat"

beforeEach(() => {
  localStorage.clear()
  // The active artifact is bucketed per conversation, so the panel only
  // resolves one once a conversation is on screen.
  __resetArtifactPickersForTests()
  useArtifactDraftStore.setState({ drafts: {} })
  useChatStore.setState({ activeSessionId: "s" })
  useArtifactStore.setState({
    artifacts: {},
    activeArtifactIdBySession: {},
    artifactVersions: {},
    artifactWorkspace: {
      scope: "session",
      sessionId: null,
      searchQuery: "",
      typeFilter: "all",
      runtimeFilter: "all",
      recentArtifactIds: [],
      returnContext: null,
    },
    canvasDocuments: {},
    activeCanvasId: null,
    panelOpen: true,
    panelView: "artifact",
  })
})

function makeArtifact(type: "code" | "html" = "code") {
  return useArtifactStore.getState().createArtifact({
    sessionId: "s",
    messageId: "m",
    type,
    title: type === "html" ? "MyPage" : "MyCode",
    content: type === "html" ? "<html></html>" : "console.log(1)",
    language: type === "html" ? "html" : "javascript",
  })
}

describe("ArtifactPanelContent", () => {
  it("renders the empty list state when no artifact is active", () => {
    render(<ArtifactPanelContent panelMode="desktop" />)
    expect(screen.getByText("recentArtifacts")).toBeInTheDocument()
    expect(screen.getByTestId("list")).toBeInTheDocument()
  })

  it("renders the active artifact identity and code", () => {
    makeArtifact()
    render(<ArtifactPanelContent panelMode="desktop" />)
    expect(screen.getByText("MyCode")).toBeInTheDocument()
    expect(screen.getByTestId("code")).toBeInTheDocument()
  })

  it("contains content layers inside the artifact body", () => {
    makeArtifact("html")
    render(<ArtifactPanelContent panelMode="desktop" />)

    expect(screen.getByTestId("artifact-content")).toHaveClass(
      "relative",
      "isolate",
      "min-w-0",
      "w-full",
      "overflow-hidden"
    )
  })

  it("offers a split tab for previewable types on desktop", () => {
    makeArtifact("html")
    render(<ArtifactPanelContent panelMode="desktop" />)
    expect(screen.getByTestId("artifact-tab-split")).toBeInTheDocument()
  })

  it("does NOT offer a split tab on mobile", () => {
    makeArtifact("html")
    render(<ArtifactPanelContent panelMode="mobile" />)
    expect(screen.queryByTestId("artifact-tab-split")).not.toBeInTheDocument()
  })

  it("renders the overflow trigger on desktop", () => {
    makeArtifact("html")
    render(<ArtifactPanelContent panelMode="desktop" />)
    // (Radix dropdown/tab activation is unreliable in jsdom — the split-view
    // render branch and overflow actions are covered in the mocked-hook test
    // and the use-artifact-panel hook tests.)
    expect(screen.getByTestId("artifact-overflow-trigger")).toBeInTheDocument()
  })

  it("mobile edit mode uses the light editor", () => {
    makeArtifact()
    render(<ArtifactPanelContent panelMode="mobile" />)
    // Mobile has no header actions row; the footer carries the edit action.
    fireEvent.click(screen.getByTestId("action-edit"))
    expect(screen.getByTestId("light-code-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
  })
})

describe("ArtifactPanelContent element picking", () => {
  it("offers no pick toggle on the source-text tabs", () => {
    makeArtifact("html")
    render(<ArtifactPanelContent panelMode="desktop" />)
    // The default tab is `code`; only rendered surfaces can be pointed at.
    expect(screen.queryByTestId("artifact-element-pick-toggle")).not.toBeInTheDocument()
  })
})

describe("ArtifactPanelContent unsaved drafts (A01, C02)", () => {
  it("brings the typed text back after switching to another artifact and returning", () => {
    const first = makeArtifact()
    const second = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m2",
      type: "code",
      title: "Other",
      content: "SECOND",
      language: "javascript",
    })
    act(() => useArtifactStore.getState().setActiveArtifact(first.id, "s"))
    render(<ArtifactPanelContent panelMode="desktop" />)
    fireEvent.click(screen.getByTestId("action-edit"))
    fireEvent.change(screen.getByTestId("monaco"), { target: { value: "unsaved work" } })
    act(() => useArtifactStore.getState().setActiveArtifact(second.id, "s"))
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
    act(() => useArtifactStore.getState().setActiveArtifact(first.id, "s"))
    expect(screen.getByTestId("monaco")).toHaveValue("unsaved work")
    expect(useArtifactStore.getState().artifacts[first.id].content).toBe(first.content)
  })

  it("asks before a save would replace a revision committed meanwhile", () => {
    const artifact = makeArtifact()
    render(<ArtifactPanelContent panelMode="desktop" />)
    fireEvent.click(screen.getByTestId("action-edit"))
    fireEvent.change(screen.getByTestId("monaco"), { target: { value: "local v1 edits" } })
    expect(screen.queryByTestId("artifact-draft-conflict")).not.toBeInTheDocument()
    act(() =>
      useArtifactStore.getState().updateArtifact(artifact.id, { content: "new external v2" })
    )
    expect(screen.getByTestId("artifact-draft-conflict")).toBeVisible()
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled()
    expect(screen.getByTestId("monaco")).toHaveValue("local v1 edits")

    fireEvent.click(screen.getByTestId("artifact-draft-overwrite"))
    const state = useArtifactStore.getState()
    expect(state.artifacts[artifact.id].content).toBe("local v1 edits")
    expect(state.getArtifactVersions(artifact.id).map((v) => v.content)).toContain(
      "new external v2"
    )
  })

  it("discarding a conflicted draft keeps the newer revision", () => {
    const artifact = makeArtifact()
    render(<ArtifactPanelContent panelMode="desktop" />)
    fireEvent.click(screen.getByTestId("action-edit"))
    fireEvent.change(screen.getByTestId("monaco"), { target: { value: "stale draft" } })
    act(() => useArtifactStore.getState().updateArtifact(artifact.id, { content: "v2" }))
    fireEvent.click(screen.getByTestId("artifact-draft-discard"))
    expect(useArtifactStore.getState().artifacts[artifact.id].content).toBe("v2")
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument()
  })
})
