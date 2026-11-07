/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import { StrictMode } from "react"

import { PlaybookWorkflowOpener, workflowEditorHref } from "./playbook-workflow-opener"

const replace = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }))
jest.mock("@/lib/playbooks/derived-workflow", () => ({ syncPlaybookWorkflow: jest.fn() }))
jest.mock("@/lib/db/skills", () => ({ getSkill: jest.fn() }))
jest.mock("@/lib/db/workflows", () => ({ createWorkflow: jest.fn() }))
jest.mock("@/lib/workflow/editor/copilot-handoff", () => ({ queueCopilotRequest: jest.fn() }))
jest.mock("sonner", () => ({ toast: { info: jest.fn() } }))

import { toast } from "sonner"
import { getSkill } from "@/lib/db/skills"
import { createWorkflow } from "@/lib/db/workflows"
import { syncPlaybookWorkflow } from "@/lib/playbooks/derived-workflow"
import { queueCopilotRequest } from "@/lib/workflow/editor/copilot-handoff"

const sync = syncPlaybookWorkflow as jest.Mock

beforeEach(() => jest.clearAllMocks())

describe("PlaybookWorkflowOpener", () => {
  it("opens the derived workflow of a playbook", async () => {
    sync.mockResolvedValue({
      status: "compiled",
      workflow: { id: "wf_playbook_review" },
      dormant: [],
    })
    render(<PlaybookWorkflowOpener skillId="review" />)

    expect(screen.getByTestId("playbook-opener-opening")).toHaveTextContent("Opening as a workflow")
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/workflows/editor?id=wf_playbook_review")
    )
    expect(sync).toHaveBeenCalledWith("review")
    expect(createWorkflow).not.toHaveBeenCalled()
  })

  it("starts a Copilot draft for a skill without a flow, once", async () => {
    sync.mockResolvedValue({ status: "not-a-playbook" })
    ;(getSkill as jest.Mock).mockResolvedValue({
      id: "notes",
      name: "Release notes",
      description: "Writes release notes",
      content: "1. Read the merged PRs.",
    })
    ;(createWorkflow as jest.Mock).mockResolvedValue({ id: "wf_draft" })

    render(
      <StrictMode>
        <PlaybookWorkflowOpener skillId="notes" />
      </StrictMode>
    )

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/workflows/editor?id=wf_draft"))
    expect(createWorkflow).toHaveBeenCalledTimes(1)
    expect(createWorkflow).toHaveBeenCalledWith({
      name: "Release notes",
      description: "Writes release notes",
    })
    expect(queueCopilotRequest).toHaveBeenCalledWith(
      "wf_draft",
      expect.stringContaining("1. Read the merged PRs.")
    )
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("Release notes"))
  })

  it("lists the problems of a flow that does not compile", async () => {
    sync.mockResolvedValue({
      status: "uncompilable",
      problems: [
        {
          code: "compile_playbook_unknown",
          skillId: "review",
          pointer: "/steps/0/uses",
          message: 'step "a" calls playbook "ghost", which is not installed',
        },
      ],
    })
    render(<PlaybookWorkflowOpener skillId="review" />)

    const problems = await screen.findByTestId("playbook-opener-problems")
    expect(problems).toHaveTextContent("compile_playbook_unknown · /steps/0/uses")
    expect(problems).toHaveTextContent('calls playbook "ghost"')
    expect(screen.getByText("This playbook cannot be opened as a workflow")).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
  })

  it("says when the skill is gone", async () => {
    sync.mockResolvedValue({ status: "missing" })
    render(<PlaybookWorkflowOpener skillId="ghost" />)
    expect(await screen.findByText("Skill not found")).toBeInTheDocument()
    expect(screen.getByText("The skill ghost does not exist or was removed.")).toBeInTheDocument()
  })

  it("says when the call graph is too large", async () => {
    sync.mockResolvedValue({ status: "too-many-playbooks", limit: 32 })
    render(<PlaybookWorkflowOpener skillId="big" />)
    expect(await screen.findByText(/calls more than 32 playbooks/)).toBeInTheDocument()
  })

  it("shows an unexpected failure", async () => {
    sync.mockRejectedValue(new Error("database closed"))
    render(<PlaybookWorkflowOpener skillId="review" />)
    expect(await screen.findByText("database closed")).toBeInTheDocument()
  })
})

describe("workflowEditorHref", () => {
  it("encodes the workflow id", () => {
    expect(workflowEditorHref("wf a/b")).toBe("/workflows/editor?id=wf%20a%2Fb")
  })
})
