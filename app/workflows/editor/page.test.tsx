import { render, screen, waitFor } from "@testing-library/react"
import { Component, type ReactNode } from "react"
import WorkflowEditorPage from "./page"

const mockGet = jest.fn()
const mockPlaybook = jest.fn((): string | null => null)
const mockNotFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND")
})
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => ({
    get: (key: string) => (key === "id" ? mockGet() : key === "playbook" ? mockPlaybook() : null),
  }),
  notFound: () => mockNotFound(),
}))
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => false }))
jest.mock("@/lib/playbooks/derived-workflow", () => ({ loadFreshWorkflow: jest.fn() }))
jest.mock("sonner", () => ({ toast: { warning: jest.fn(), error: jest.fn() } }))
jest.mock("@/components/workflow/editor/canvas", () => ({
  WorkflowEditorCanvas: ({ workflow }: { workflow: { id: string } }) => (
    <div data-testid="canvas">{workflow.id}</div>
  ),
}))
jest.mock("@/components/workflow/editor/playbook-workflow-opener", () => ({
  PlaybookWorkflowOpener: ({ skillId }: { skillId: string }) => (
    <div data-testid="playbook-opener">{skillId}</div>
  ),
}))
jest.mock("@/components/mobile/workflow/editor/mobile-workflow-editor", () => ({
  MobileWorkflowEditor: () => <div data-testid="mobile-editor" />,
}))

import { toast } from "sonner"
import { loadFreshWorkflow } from "@/lib/playbooks/derived-workflow"

const getWorkflow = loadFreshWorkflow as jest.Mock

// Catches the synchronous throw that `notFound()` performs during the
// effect-triggered re-render, so the test can assert it fired without the
// whole render tearing down the test.
class Boundary extends Component<{ children: ReactNode }, { errored: boolean }> {
  state = { errored: false }
  static getDerivedStateFromError() {
    return { errored: true }
  }
  render() {
    return this.state.errored ? <div data-testid="boundary" /> : this.props.children
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPlaybook.mockReturnValue(null)
})

test("renders the canvas for the workflow id from ?id=", async () => {
  mockGet.mockReturnValue("wf-123")
  getWorkflow.mockResolvedValue({
    status: "ready",
    workflow: { id: "wf-123", name: "X" },
    dormant: [],
  })
  render(<WorkflowEditorPage />)
  await waitFor(() => expect(screen.getByTestId("canvas")).toHaveTextContent("wf-123"))
  expect(getWorkflow).toHaveBeenCalledWith("wf-123")
  expect(toast.warning).not.toHaveBeenCalled()
})

test("opens the last compiled copy of a playbook workflow whose source is gone, with a warning", async () => {
  mockGet.mockReturnValue("wf_playbook_x")
  getWorkflow.mockResolvedValue({
    status: "source-unavailable",
    workflow: {
      id: "wf_playbook_x",
      name: "X",
      derivedFrom: { kind: "playbook", skillId: "review" },
    },
    problem: { status: "missing" },
  })
  render(<WorkflowEditorPage />)
  await waitFor(() => expect(screen.getByTestId("canvas")).toHaveTextContent("wf_playbook_x"))
  expect(toast.warning).toHaveBeenCalledTimes(1)
  // `workflows.playbook.sourceUnavailable`, naming the playbook it follows.
  expect(toast.warning).toHaveBeenCalledWith(
    expect.stringContaining("The playbook this workflow follows (review)")
  )
})

test("calls notFound when the workflow does not exist", async () => {
  mockGet.mockReturnValue("missing")
  getWorkflow.mockResolvedValue({ status: "not-found" })
  render(
    <Boundary>
      <WorkflowEditorPage />
    </Boundary>
  )
  await waitFor(() => expect(mockNotFound).toHaveBeenCalled())
})

test("calls notFound when ?id= is absent and never queries Dexie", async () => {
  mockGet.mockReturnValue(null)
  render(
    <Boundary>
      <WorkflowEditorPage />
    </Boundary>
  )
  await waitFor(() => expect(mockNotFound).toHaveBeenCalled())
  expect(getWorkflow).not.toHaveBeenCalled()
})

test("opens a skill as a workflow from ?playbook=", () => {
  mockGet.mockReturnValue(null)
  mockPlaybook.mockReturnValue("change-review")
  render(<WorkflowEditorPage />)
  expect(screen.getByTestId("playbook-opener")).toHaveTextContent("change-review")
  expect(getWorkflow).not.toHaveBeenCalled()
  expect(mockNotFound).not.toHaveBeenCalled()
})
