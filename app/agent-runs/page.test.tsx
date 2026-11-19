import { render, screen } from "@testing-library/react"
import AgentRunsPage from "./page"

const replace = jest.fn()
let searchParams = new URLSearchParams()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => searchParams,
}))

let lastProps: Record<string, unknown> = {}
jest.mock("@/components/agent-runs/agent-runs-panel", () => ({
  AgentRunsPanel: (props: Record<string, unknown>) => {
    lastProps = props
    return <div data-testid="panel">panel</div>
  },
}))

jest.mock("@/components/attention/attention-panel", () => ({
  AttentionSection: () => <div data-testid="attention-section">waiting</div>,
}))

beforeEach(() => {
  replace.mockReset()
  searchParams = new URLSearchParams()
  lastProps = {}
})

describe("AgentRunsPage", () => {
  it("renders the panel inside a Suspense boundary", () => {
    render(<AgentRunsPage />)
    expect(screen.getByTestId("panel")).toBeInTheDocument()
  })

  /**
   * The navigation's badge on this page counts chat approvals, team gates and
   * waiting fleet agents, none of which is a row of the run list (sidebar
   * audit item 13): they are drawn above it, ahead of the runs.
   */
  it("draws what the badge counts above the run list", () => {
    render(<AgentRunsPage />)
    const waiting = screen.getByTestId("attention-section")
    expect(
      waiting.compareDocumentPosition(screen.getByTestId("panel")) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("passes ?run= / ?kind= / ?status= through to the panel", () => {
    searchParams = new URLSearchParams("run=execution:goal:g1&kind=team&status=failed")
    render(<AgentRunsPage />)
    expect(lastProps.selectedId).toBe("execution:goal:g1")
    expect(lastProps.filterKind).toBe("team")
    expect(lastProps.statusGroup).toBe("failed")
  })

  /**
   * A hand-edited or stale URL must not filter the list down to nothing:
   * an unknown value falls back to "all" rather than being cast through.
   */
  it("falls back to all for a filter value outside the closed set", () => {
    searchParams = new URLSearchParams("kind=scheduled-task&status=succeeded")
    render(<AgentRunsPage />)
    expect(lastProps.filterKind).toBe("all")
    expect(lastProps.statusGroup).toBe("all")
  })

  it("writes ?run= when a run is selected", () => {
    render(<AgentRunsPage />)
    ;(lastProps.onSelect as (id: string | null) => void)("execution:plan:p1")
    expect(replace).toHaveBeenCalledWith(expect.stringContaining("run=execution%3Aplan%3Ap1"))
  })

  it("drops ?kind= when the filter resets to all", () => {
    searchParams = new URLSearchParams("kind=goal")
    render(<AgentRunsPage />)
    ;(lastProps.onFilterKind as (k: string) => void)("all")
    expect(replace).toHaveBeenCalledWith(expect.not.stringContaining("kind="))
  })

  it("drops ?status= when the status filter resets to all", () => {
    searchParams = new URLSearchParams("status=running")
    render(<AgentRunsPage />)
    ;(lastProps.onStatusGroup as (g: string) => void)("all")
    expect(replace).toHaveBeenCalledWith(expect.not.stringContaining("status="))
  })
})
