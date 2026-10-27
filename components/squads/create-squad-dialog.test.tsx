/** @jest-environment jsdom */

// "New Squad": three named starts, and whichever is picked, the host learns the
// new Squad's id. Composing and the template platform have suites of their own.

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { AgentTeamTemplate } from "@/types/agent/agent-team"

const createSquad = jest.fn()
jest.mock("@/hooks/squads/use-create-squad", () => ({ useCreateSquad: () => createSquad }))

let mockTemplates: AgentTeamTemplate[] = []
let mockPluginIndex = new Map<string, { pluginId?: string; warnings: [] }>()
const applyTemplate = jest.fn()
jest.mock("@/hooks/squads/use-squad-templates", () => ({
  useSquadTemplates: () => ({ merged: mockTemplates, pluginIndex: mockPluginIndex }),
  useApplySquadTemplate: () => applyTemplate,
}))

jest.mock("@/components/agent/workspace/auto-compose-dialog", () => ({
  AutoComposeDialog: ({
    open,
    onComposed,
  }: {
    open: boolean
    onComposed: (teamId: string) => void
  }) =>
    open ? (
      <button type="button" data-testid="compose-stub" onClick={() => onComposed("composed")}>
        compose
      </button>
    ) : null,
}))

const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}))

import { CreateSquadDialog } from "./create-squad-dialog"

function template(over: Partial<AgentTeamTemplate> & { id: string }): AgentTeamTemplate {
  return {
    name: over.id,
    description: "",
    category: "general",
    teammates: [],
    ...over,
  } as AgentTeamTemplate
}

const onOpenChange = jest.fn()
const onCreated = jest.fn()

function mount(open = true) {
  return render(<CreateSquadDialog open={open} onOpenChange={onOpenChange} onCreated={onCreated} />)
}

beforeEach(() => {
  jest.clearAllMocks()
  mockTemplates = []
  mockPluginIndex = new Map()
})

describe("the three starts", () => {
  it("names each way to start, the recommended one first", () => {
    mount()
    const options = screen.getAllByTestId(/^squad-create-(compose|template|blank)$/)
    expect(options.map((option) => option.getAttribute("data-testid"))).toEqual([
      "squad-create-compose",
      "squad-create-template",
      "squad-create-blank",
    ])
    expect(options[0]).toHaveTextContent("Recommended")
  })

  it("creates a blank Squad with its default names and hands it over", async () => {
    createSquad.mockResolvedValue({ id: "blank_1" })
    mount()
    await userEvent.click(screen.getByTestId("squad-create-blank"))
    expect(createSquad).toHaveBeenCalledWith({ name: "New Squad", leadName: "Team Lead" })
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("blank_1"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  /** One modal at a time: this one closes before the composer opens. */
  it("closes and hands over to the composer, then reports what it composed", async () => {
    const { rerender } = mount()
    await userEvent.click(screen.getByTestId("squad-create-compose"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    rerender(<CreateSquadDialog open={false} onOpenChange={onOpenChange} onCreated={onCreated} />)
    await userEvent.click(screen.getByTestId("compose-stub"))
    expect(onCreated).toHaveBeenCalledWith("composed")
    expect(screen.queryByTestId("compose-stub")).not.toBeInTheDocument()
  })

  it("says so when a Squad could not be made, and stays open", async () => {
    createSquad.mockRejectedValue(new Error("disk full"))
    mount()
    await userEvent.click(screen.getByTestId("squad-create-blank"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't create the Squad", {
        description: "disk full",
      })
    )
    expect(onCreated).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

describe("templates", () => {
  it("lists the templates with their roster size and source", async () => {
    mockTemplates = [
      template({
        id: "review",
        name: "Parallel Review",
        isBuiltIn: true,
        teammates: [
          { name: "A", description: "" },
          { name: "B", description: "" },
        ],
      }),
      template({ id: "acme:audit", name: "Acme Audit" }),
    ]
    mockPluginIndex = new Map([["acme:audit", { pluginId: "acme", warnings: [] }]])
    mount()
    await userEvent.click(screen.getByTestId("squad-create-template"))
    expect(screen.getByText("Choose a template")).toBeInTheDocument()
    expect(screen.getByTestId("squad-create-template-review")).toHaveTextContent("2 members")
    expect(screen.getByTestId("squad-create-template-review")).toHaveTextContent("Built-in")
    expect(screen.getByTestId("squad-create-template-acme:audit")).toHaveTextContent("Plugin")
  })

  it("creates from a template through the platform, naming a plugin's source", async () => {
    mockTemplates = [template({ id: "acme:audit", name: "Acme Audit" })]
    mockPluginIndex = new Map([["acme:audit", { pluginId: "acme", warnings: [] }]])
    applyTemplate.mockResolvedValue({ teamId: "from_tpl", via: "platform" })
    mount()
    await userEvent.click(screen.getByTestId("squad-create-template"))
    await userEvent.click(screen.getByRole("button", { name: "Use the Acme Audit template" }))
    expect(applyTemplate).toHaveBeenCalledWith(mockTemplates[0], "acme")
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("from_tpl"))
  })

  it("goes back to the three starts", async () => {
    mount()
    await userEvent.click(screen.getByTestId("squad-create-template"))
    expect(screen.getByText("No templates available yet.")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("squad-create-back"))
    expect(screen.getByTestId("squad-create-blank")).toBeInTheDocument()
  })
})
