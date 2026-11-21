/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { FilesEmpty, filesEmptyCopy } from "./files-empty"

describe("filesEmptyCopy", () => {
  it("prefers the filter, then the Trash, then the lens, then the place", () => {
    expect(filesEmptyCopy({ kind: "trash" }, "ai", true)).toBe("search")
    expect(filesEmptyCopy({ kind: "trash" }, "ai", false)).toBe("trash")
    expect(filesEmptyCopy({ kind: "all" }, "favorites", false)).toBe("favorites")
    expect(filesEmptyCopy({ kind: "folder", folderId: "x" }, "suggested", false)).toBe("folder")
    expect(filesEmptyCopy({ kind: "group", group: "images" }, "suggested", false)).toBe("group")
    expect(filesEmptyCopy({ kind: "recent" }, "suggested", false)).toBe("recent")
  })
})

it("explains an empty Trash", () => {
  render(
    <FilesEmpty section={{ kind: "trash" }} lens="suggested" filtered={false} onClear={jest.fn()} />
  )
  expect(screen.getByTestId("files-empty-trash")).toHaveTextContent("The Trash is empty")
  expect(screen.queryByRole("button")).toBeNull()
})

it("offers to clear a search that hid everything, and distinguishes a failed body search (F06)", async () => {
  const onClear = jest.fn()
  const onRetrySearch = jest.fn()
  const { rerender } = render(
    <FilesEmpty section={{ kind: "all" }} lens="mine" filtered onClear={onClear} />
  )
  await userEvent.setup().click(screen.getByRole("button", { name: "Clear filters" }))
  expect(onClear).toHaveBeenCalled()

  expect(filesEmptyCopy({ kind: "all" }, "suggested", true, false, true)).toBe("searchFailed")
  rerender(
    <FilesEmpty
      section={{ kind: "all" }}
      lens="suggested"
      filtered
      onClear={onClear}
      searchError="files_remote_unreachable"
      onRetrySearch={onRetrySearch}
    />
  )
  expect(screen.getByTestId("files-empty-searchFailed")).toHaveTextContent(
    "Couldn’t search file contents"
  )
  await userEvent.setup().click(screen.getByTestId("files-empty-retry-search"))
  expect(onRetrySearch).toHaveBeenCalledTimes(1)
})

it("says how to fill an empty folder by tap on the phone, and by drag elsewhere", () => {
  const props = {
    section: { kind: "folder", folderId: "f1" } as const,
    lens: "suggested" as const,
    filtered: false,
    onClear: jest.fn(),
  }
  const { rerender } = render(<FilesEmpty {...props} touch />)
  expect(screen.getByTestId("files-empty-folder")).toHaveTextContent("select items and tap Move")
  rerender(<FilesEmpty {...props} />)
  expect(screen.getByTestId("files-empty-folder")).toHaveTextContent("Drag items here")
})

describe("the Workspace files group (ADR-0223 §8)", () => {
  const workspace = { kind: "group", group: "workspace" } as const

  it("says what lands there, or that the desktop app lists them", () => {
    expect(filesEmptyCopy(workspace, "suggested", false)).toBe("workspace")
    expect(filesEmptyCopy(workspace, "favorites", false)).toBe("favorites")
    expect(filesEmptyCopy(workspace, "favorites", false, true)).toBe("workspaceHeldBack")
    expect(filesEmptyCopy(workspace, "suggested", true, true)).toBe("search")
    expect(filesEmptyCopy({ kind: "all" }, "suggested", false, true)).toBe("all")
  })

  it("is held back off the desktop app, and says so (dormancy, rule 7)", () => {
    render(<FilesEmpty section={workspace} lens="suggested" filtered={false} onClear={jest.fn()} />)
    expect(screen.getByTestId("files-empty-workspaceHeldBack")).toHaveTextContent(
      "Workspace files are on the desktop app"
    )
  })
})
