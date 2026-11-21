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
    sort: null,
  })
)

it("writes the layout to the store and leaves search to the header", async () => {
  render(<FilesToolbar />)
  expect(screen.queryByRole("searchbox")).toBeNull()
  await userEvent.setup().click(screen.getByRole("radio", { name: "List" }))
  expect(useFilesLibraryStore.getState().viewMode).toBe("list")
})

it("carries the filter button and cross-layout sort menu (G05)", async () => {
  const user = userEvent.setup()
  render(<FilesToolbar />)
  expect(screen.getByTestId("files-filter")).toBeInTheDocument()
  await user.click(screen.getByTestId("files-sort-menu"))
  await user.click(await screen.findByTestId("files-sort-option-size"))
  expect(useFilesLibraryStore.getState().sort).toEqual({ key: "size", dir: "desc" })
  await user.click(screen.getByTestId("files-sort-menu"))
  await user.click(await screen.findByTestId("files-sort-dir-asc"))
  expect(useFilesLibraryStore.getState().sort).toEqual({ key: "size", dir: "asc" })
  await user.click(screen.getByTestId("files-sort-menu"))
  await user.click(await screen.findByTestId("files-sort-option-default"))
  expect(useFilesLibraryStore.getState().sort).toBeNull()
})
