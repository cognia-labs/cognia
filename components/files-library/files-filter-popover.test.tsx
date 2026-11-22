/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_FILES_VIEW_FILTERS, useFilesLibraryStore } from "@/stores/files-library"
import { FilesFilterPopover } from "./files-filter-popover"

beforeEach(() =>
  useFilesLibraryStore.setState({
    search: "",
    filters: DEFAULT_FILES_VIEW_FILTERS,
    projectScope: "current",
  })
)

it("toggles formats and picks a modified range and a size band", async () => {
  const user = userEvent.setup()
  render(<FilesFilterPopover />)
  await user.click(screen.getByRole("button", { name: "Filter" }))
  await user.click(screen.getByRole("checkbox", { name: "Code" }))
  await user.click(screen.getByRole("checkbox", { name: "Image" }))
  expect(useFilesLibraryStore.getState().filters.formats).toEqual(["code", "image"])
  await user.click(screen.getByRole("checkbox", { name: "Code" }))
  expect(useFilesLibraryStore.getState().filters.formats).toEqual(["image"])

  await user.click(screen.getByRole("radio", { name: "Past week" }))
  await user.click(screen.getByRole("radio", { name: "1–10 MB" }))
  expect(useFilesLibraryStore.getState().filters).toMatchObject({
    modified: "week",
    size: "medium",
  })
})

it("counts active filters on the trigger and resets them", async () => {
  useFilesLibraryStore.setState({
    filters: { formats: ["code"], modified: "day", size: "any", tags: [] },
    search: "x",
  })
  const user = userEvent.setup()
  render(<FilesFilterPopover />)
  const trigger = screen.getByRole("button", { name: "Filter, 2 active" })
  await user.click(trigger)
  await user.click(screen.getByRole("button", { name: "Reset" }))
  expect(useFilesLibraryStore.getState().filters).toEqual(DEFAULT_FILES_VIEW_FILTERS)
  expect(useFilesLibraryStore.getState().search).toBe("")
})

it("toggles tag chips and opens the save-collection dialog when criteria are active", async () => {
  const user = userEvent.setup()
  render(<FilesFilterPopover availableTags={["Spec", "Urgent"]} />)
  await user.click(screen.getByRole("button", { name: "Filter" }))
  expect(screen.getByTestId("files-filter-save-collection")).toBeDisabled()

  await user.click(screen.getByTestId("files-filter-tag-Spec"))
  expect(useFilesLibraryStore.getState().filters.tags).toEqual(["Spec"])
  expect(screen.getByTestId("files-filter-save-collection")).toBeEnabled()

  await user.click(screen.getByTestId("files-filter-save-collection"))
  expect(useFilesLibraryStore.getState().collectionDialog).toEqual({ mode: "create" })
})

it("switches the workspace scope without counting it as a filter", async () => {
  const user = userEvent.setup()
  render(<FilesFilterPopover />)
  await user.click(screen.getByRole("button", { name: "Filter" }))
  await user.click(screen.getByRole("radio", { name: "All workspaces" }))
  expect(useFilesLibraryStore.getState().projectScope).toBe("all")
  expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled()
})

it("sizes its trigger beside the phone's 40px search field", () => {
  const { rerender } = render(<FilesFilterPopover compact />)
  expect(screen.getByRole("button", { name: "Filter" })).toHaveClass("h-10")
  rerender(<FilesFilterPopover />)
  expect(screen.getByRole("button", { name: "Filter" })).not.toHaveClass("h-10")
})
