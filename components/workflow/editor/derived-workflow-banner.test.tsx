/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { DerivedWorkflowBanner } from "./derived-workflow-banner"

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("@/lib/db/workflows", () => ({ duplicateWorkflow: jest.fn() }))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"
import { duplicateWorkflow } from "@/lib/db/workflows"

const derivedFrom = {
  kind: "playbook" as const,
  skillId: "change-review",
  contentHash: "h",
  compilerVersion: 1,
  compiledAt: 1,
}

beforeEach(() => jest.clearAllMocks())

describe("DerivedWorkflowBanner", () => {
  it("says the workflow follows its playbook and is read-only", () => {
    render(<DerivedWorkflowBanner workflow={{ id: "wf_pb", derivedFrom }} />)
    expect(screen.getByTestId("derived-workflow-banner")).toHaveTextContent(
      "Compiled from a playbook"
    )
    expect(screen.getByTestId("derived-workflow-banner")).toHaveTextContent("change-review")
  })

  it("renders nothing for an ordinary workflow", () => {
    const { container } = render(<DerivedWorkflowBanner workflow={{ id: "wf_plain" }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("detaches into an editable copy and opens it", async () => {
    ;(duplicateWorkflow as jest.Mock).mockResolvedValue({ id: "wf_copy", name: "Review (copy)" })
    render(<DerivedWorkflowBanner workflow={{ id: "wf_pb", derivedFrom }} />)

    fireEvent.click(screen.getByTestId("derived-workflow-detach"))

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workflows/editor?id=wf_copy"))
    expect(duplicateWorkflow).toHaveBeenCalledWith("wf_pb")
    expect(toast.success).toHaveBeenCalledWith("Detached into “Review (copy)”.")
  })

  it("says why a detach failed and lets the person try again", async () => {
    ;(duplicateWorkflow as jest.Mock).mockRejectedValue(new Error("disk full"))
    render(<DerivedWorkflowBanner workflow={{ id: "wf_pb", derivedFrom }} />)

    fireEvent.click(screen.getByTestId("derived-workflow-detach"))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not detach: disk full"))
    expect(screen.getByTestId("derived-workflow-detach")).not.toBeDisabled()
    expect(push).not.toHaveBeenCalled()
  })
})
