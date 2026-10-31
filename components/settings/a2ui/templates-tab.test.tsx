import React from "react"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { deleteTemplate } from "@/lib/db/a2ui-templates"
import type { A2UITemplateRow } from "@/lib/db/a2ui-types"
import { TemplatesTab } from "./templates-tab"

const getLocalizedTemplates = jest.fn((_locale: string) => [
  {
    id: "todo-list",
    name: "Todo List",
    description: "A localized template",
    category: "productivity",
    icon: "CheckSquare",
    tags: [],
    components: [],
    dataModel: {},
  },
])
const listTemplates = jest.fn<Promise<A2UITemplateRow[]>, []>(async () => [])
const customTemplate: A2UITemplateRow = {
  id: "custom",
  name: "Custom",
  description: "Saved template",
  category: "productivity",
  components: [],
  dataModel: {},
  rootId: "root",
  isBuiltIn: false,
  source: "imported",
  createdAt: 1,
  updatedAt: 1,
}

jest.mock("@/lib/a2ui/templates", () => ({
  getLocalizedTemplates: (locale: string) => getLocalizedTemplates(locale),
}))
jest.mock("@/lib/db/a2ui-templates", () => ({
  listTemplates: () => listTemplates(),
  upsertTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

describe("TemplatesTab", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    listTemplates.mockResolvedValue([])
  })

  afterEach(() => jest.restoreAllMocks())

  async function openDelete() {
    await screen.findByText("Custom")
    await userEvent.click(screen.getByRole("button", { name: "Delete" }))
  }

  it("shared controls: deleting a template waits for its own themed decision", async () => {
    const nativeConfirm = jest.spyOn(window, "confirm").mockReturnValue(true)
    listTemplates.mockResolvedValue([customTemplate])
    render(<TemplatesTab />)
    await openDelete()
    expect(deleteTemplate).not.toHaveBeenCalled()
    expect(nativeConfirm).not.toHaveBeenCalled()
    const dialog = screen.getByRole("alertdialog", { name: 'Delete "Custom"?' })
    await userEvent.click(within(dialog).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(deleteTemplate).toHaveBeenCalledWith("custom"))
    expect(deleteTemplate).toHaveBeenCalledTimes(1)
  })

  it.each(["cancel", "escape", "unmount"])(
    "shared controls: %s leaves a template intact",
    async (action) => {
      jest.spyOn(window, "confirm").mockReturnValue(true)
      listTemplates.mockResolvedValue([customTemplate])
      const view = render(<TemplatesTab />)
      await openDelete()
      expect(deleteTemplate).not.toHaveBeenCalled()
      const dialog = screen.getByRole("alertdialog")
      if (action === "cancel")
        await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
      else if (action === "escape") await userEvent.keyboard("{Escape}")
      else view.unmount()
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
      expect(deleteTemplate).not.toHaveBeenCalled()
      if (action !== "unmount") expect(screen.getByText("Custom")).toBeVisible()
    }
  )

  it("renders the built-in catalog through the active locale projection", async () => {
    render(<TemplatesTab />)

    expect(screen.getByText("Todo List")).toBeInTheDocument()
    expect(screen.getByText("A localized template")).toBeInTheDocument()
    expect(getLocalizedTemplates).toHaveBeenCalledWith("en")
    await waitFor(() => expect(listTemplates).toHaveBeenCalled())
  })
})
