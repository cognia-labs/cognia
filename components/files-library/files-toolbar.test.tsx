/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { DEFAULT_FILES_VIEW_FILTERS, useFilesLibraryStore } from "@/stores/files-library"
import { FilesToolbar } from "./files-toolbar"

beforeEach(() =>
  useFilesLibraryStore.setState({
    search: "",
    filters: DEFAULT_FILES_VIEW_FILTERS,
    projectScope: "current",
    viewMode: "grid",
  })
)

it("writes the layout to the store and leaves search to the header", async () => {
  render(<FilesToolbar />)
  expect(screen.queryByRole("searchbox")).toBeNull()
  await userEvent.setup().click(screen.getByRole("radio", { name: "List" }))
  expect(useFilesLibraryStore.getState().viewMode).toBe("list")
})

it("carries the filter button", () => {
  render(<FilesToolbar />)
  expect(screen.getByTestId("files-filter")).toBeInTheDocument()
})
