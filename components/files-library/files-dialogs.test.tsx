/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const mockReceived: Record<string, Record<string, unknown>> = {}
function mockStub(name: string) {
  function Stub(props: Record<string, unknown>) {
    mockReceived[name] = props
    return <div data-testid={`dialog-${name}`} />
  }
  return Stub
}
jest.mock("./files-move-dialog", () => ({
  FilesMoveDialog: mockStub("move"),
  FilesMoveFolderDialog: mockStub("moveFolder"),
}))
jest.mock("./files-rename-dialog", () => ({ FilesRenameDialog: mockStub("rename") }))
jest.mock("./files-save-template-dialog", () => ({ FilesSaveTemplateDialog: mockStub("template") }))
jest.mock("./files-share-dialog", () => ({ FilesShareDialog: mockStub("share") }))
jest.mock("./files-trash-dialogs", () => ({ FilesTrashDialogs: mockStub("trash") }))
jest.mock("./files-folder-dialog", () => ({ FilesFolderDialog: mockStub("folder") }))
jest.mock("./files-delete-folder-dialog", () => ({
  FilesDeleteFolderDialog: mockStub("deleteFolder"),
}))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesDialogs } from "./files-dialogs"

beforeEach(() => {
  useFilesLibraryStore.setState({
    tagTarget: null,
    collectionDialog: null,
    search: "",
    lens: "suggested",
    filters: { formats: [], modified: "any", size: "any", tags: [] },
  })
})

it("mounts every Files dialog once, each with what it reads", () => {
  const entries = [{ key: "artifact:a" }] as unknown as FilesEntry[]
  const folders = [{ id: "f1" }] as unknown as LibraryFolder[]
  const actions = {} as FilesActions
  const onDeleted = jest.fn()
  render(
    <FilesDialogs entries={entries} folders={folders} actions={actions} onDeleted={onDeleted} />
  )

  for (const name of [
    "move",
    "moveFolder",
    "rename",
    "template",
    "share",
    "trash",
    "folder",
    "deleteFolder",
  ]) {
    expect(screen.getAllByTestId(`dialog-${name}`)).toHaveLength(1)
  }
  expect(mockReceived.move).toMatchObject({ entries, folders, actions })
  expect(mockReceived.moveFolder).toMatchObject({ folders, actions })
  expect(mockReceived.rename).toMatchObject({ entries, actions })
  expect(mockReceived.template).toMatchObject({ entries })
  expect(mockReceived.share).toMatchObject({ entries, folders })
  expect(mockReceived.trash).toMatchObject({ entries, actions, onDeleted })
  expect(mockReceived.deleteFolder).toMatchObject({ folders })
})

it("saves normalized tags and creates a Smart Collection from the current query", async () => {
  const user = userEvent.setup()
  const entries = [{ key: "artifact:a", tags: ["existing"] }] as unknown as FilesEntry[]
  const setTags = jest.fn().mockResolvedValue(true)
  const saveCollection = jest.fn().mockResolvedValue({
    id: "lbc_new",
    name: "Q4 Specs",
    query: { search: "roadmap", tags: ["spec"] },
    createdAt: 1,
    updatedAt: 1,
  })
  const actions = { setTags, saveCollection } as unknown as FilesActions

  useFilesLibraryStore.setState({ tagTarget: ["artifact:a"] })
  render(<FilesDialogs entries={entries} folders={[]} actions={actions} onDeleted={jest.fn()} />)

  await user.type(screen.getByTestId("files-tags-input"), "spec, q4")
  await user.click(screen.getByTestId("files-tags-save"))
  expect(setTags).toHaveBeenCalledWith(entries, ["existing", "spec", "q4"])

  act(() => {
    useFilesLibraryStore.setState({
      search: "roadmap",
      filters: { formats: [], modified: "any", size: "any", tags: ["spec"] },
      collectionDialog: { mode: "create" },
    })
  })
  const nameInput = await screen.findByTestId("files-collection-name")
  await user.type(nameInput, "Q4 Specs")
  await user.click(screen.getByTestId("files-collection-submit"))
  expect(saveCollection).toHaveBeenCalledWith({
    name: "Q4 Specs",
    query: expect.objectContaining({ search: "roadmap", tags: ["spec"] }),
  })
  expect(useFilesLibraryStore.getState().section).toEqual({
    kind: "collection",
    collectionId: "lbc_new",
  })
})
