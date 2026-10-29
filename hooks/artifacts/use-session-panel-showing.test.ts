/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"

import { dockSessionScopeKey } from "@/lib/artifacts/dock-pages"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

import { useSessionPanelShowing } from "./use-session-panel-showing"

let mockBreakpoint = "desktop"
jest.mock("@/hooks/ui/use-breakpoint", () => ({ useBreakpoint: () => mockBreakpoint }))

const SID = "ses-panel"

function setLayout(activePanelId: string | null, splitPanelId: string | null = null) {
  act(() =>
    useContextWorkbenchStore.setState((state) => ({
      layouts: {
        ...state.layouts,
        [dockSessionScopeKey(SID)]: {
          ...(state.layouts[dockSessionScopeKey(SID)] ?? {}),
          activePanelId,
          splitPanelId,
        } as never,
      },
    }))
  )
}

beforeEach(() => {
  mockBreakpoint = "desktop"
  act(() => {
    useArtifactDockLayoutStore.setState({ dockCollapsed: false })
    useArtifactStore.setState({ activeArtifactIdBySession: {} })
  })
  setLayout("plan")
})

describe("useSessionPanelShowing", () => {
  it("is true when the desktop dock shows the panel", () => {
    expect(renderHook(() => useSessionPanelShowing(SID, "plan")).result.current).toBe(true)
  })

  it("counts the split panel too", () => {
    setLayout("memory", "plan")
    expect(renderHook(() => useSessionPanelShowing(SID, "plan")).result.current).toBe(true)
  })

  it("is false for another panel, a closed dock, an artifact in front or a narrow screen", () => {
    expect(renderHook(() => useSessionPanelShowing(SID, "memory")).result.current).toBe(false)

    act(() => useArtifactDockLayoutStore.setState({ dockCollapsed: true }))
    expect(renderHook(() => useSessionPanelShowing(SID, "plan")).result.current).toBe(false)
    act(() => useArtifactDockLayoutStore.setState({ dockCollapsed: false }))

    act(() => useArtifactStore.setState({ activeArtifactIdBySession: { [SID]: "a1" } }))
    expect(renderHook(() => useSessionPanelShowing(SID, "plan")).result.current).toBe(false)
    act(() => useArtifactStore.setState({ activeArtifactIdBySession: {} }))

    mockBreakpoint = "tablet"
    expect(renderHook(() => useSessionPanelShowing(SID, "plan")).result.current).toBe(false)
  })

  it("is false without a session", () => {
    expect(renderHook(() => useSessionPanelShowing(null, "plan")).result.current).toBe(false)
  })
})
