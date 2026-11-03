/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  // Values are folded into the key so two rows built from the same message
  // (every folder shares `openFolder`) stay distinguishable in queries.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

// jsdom has no layout, so the real virtualizer would window every row away.
// Render them all; the windowing itself is TanStack's.
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number
    getItemKey: (i: number) => string
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 34,
        size: 34,
        end: (index + 1) * 34,
        lane: 0,
      })),
    getTotalSize: () => count * 34,
    scrollToIndex: jest.fn(),
  }),
}))

jest.mock("@/lib/claude/ipc", () => ({ defaultExportDir: jest.fn() }))
jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceDir: jest.fn(),
  listWorkspaceRoots: jest.fn(),
}))

import { WorkspaceFolderPicker } from "./workspace-folder-picker"

const defaultExportDirMock = (
  jest.requireMock("@/lib/claude/ipc") as { defaultExportDir: jest.Mock }
).defaultExportDir
const workspaceFs = jest.requireMock("@/lib/files/workspace-fs") as {
  listWorkspaceDir: jest.Mock
  listWorkspaceRoots: jest.Mock
}
const listWorkspaceDirMock = workspaceFs.listWorkspaceDir
const listWorkspaceRootsMock = workspaceFs.listWorkspaceRoots

const HEADLESS_ROOT = { path: "/srv/workspaces", source: "headless-workspaces-dir" as const }

function dir(relPath: string, absolutePath: string) {
  return { relPath, absolutePath, isDir: true, size: 0, mtimeMs: null }
}

function file(relPath: string, absolutePath: string) {
  return { relPath, absolutePath, isDir: false, size: 12, mtimeMs: null }
}

/** A small Host tree under the headless root. */
function serveTree(tree: Record<string, ReturnType<typeof dir | typeof file>[]>) {
  listWorkspaceDirMock.mockImplementation(
    async (_root: string, rel?: string) => tree[rel ?? ""] ?? []
  )
}

const TREE = {
  "": [
    dir("projects", "/srv/workspaces/projects"),
    dir(".cache", "/srv/workspaces/.cache"),
    file("readme.txt", "/srv/workspaces/readme.txt"),
  ],
  projects: [
    dir("projects/api", "/srv/workspaces/projects/api"),
    dir("projects/web", "/srv/workspaces/projects/web"),
  ],
}

function folderRow(name: string) {
  return screen.findByRole("option", { name: `openFolder:${name}` })
}

beforeEach(() => {
  defaultExportDirMock.mockReset().mockResolvedValue("/srv")
  listWorkspaceDirMock.mockReset().mockResolvedValue([])
  listWorkspaceRootsMock.mockReset().mockResolvedValue([])
})

it("starts inside a root the Host declared and lists only its folders", async () => {
  // The old picker opened on `defaultExportDir()`, which on a headless Host is
  // outside the workspaces root, so the dialog's first frame was a refusal.
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  serveTree(TREE)

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await folderRow("projects")).toBeInTheDocument()
  expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv/workspaces", undefined)
  expect(defaultExportDirMock).not.toHaveBeenCalled()
  expect(screen.queryByText("readme.txt")).not.toBeInTheDocument()
  expect(screen.getByTestId("workspace-folder-current")).toHaveTextContent("workspaces")
})

it("enters a folder on click and chooses the folder it is in, by the Host's own path", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  serveTree(TREE)
  const onSelect = jest.fn()
  const onOpenChange = jest.fn()

  render(<WorkspaceFolderPicker open onOpenChange={onOpenChange} onSelect={onSelect} />)

  fireEvent.click(await folderRow("projects"))
  // Lazy: the child listing is only requested once the folder is entered.
  expect(await folderRow("api")).toBeInTheDocument()
  expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv/workspaces", "projects")
  const trail = screen.getByRole("list", { name: "breadcrumb" })
  expect(within(trail).getByRole("button", { name: "projects" })).toHaveAttribute(
    "aria-current",
    "location"
  )

  fireEvent.click(screen.getByRole("button", { name: "chooseCurrent" }))
  expect(onSelect).toHaveBeenCalledWith("/srv/workspaces/projects")
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it("returns from the cache when going back, without asking the Host again", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  serveTree(TREE)

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
  fireEvent.click(await folderRow("projects"))
  await folderRow("api")
  const calls = listWorkspaceDirMock.mock.calls.length

  fireEvent.click(
    within(screen.getByRole("list", { name: "breadcrumb" })).getByRole("button", {
      name: "workspaces",
    })
  )
  expect(await folderRow("projects")).toBeInTheDocument()
  expect(listWorkspaceDirMock.mock.calls.length).toBe(calls)

  // Reload is the one way to re-ask.
  fireEvent.click(screen.getByRole("button", { name: "refresh" }))
  await waitFor(() => expect(listWorkspaceDirMock.mock.calls.length).toBe(calls + 1))
})

it("joins a request already in flight instead of repeating it", async () => {
  jest.useFakeTimers()
  try {
    listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
    serveTree(TREE)
    render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
    const row = await folderRow("projects")

    // Resting on the row prefetches; the click that follows joins that request.
    let resolveProjects: (value: unknown) => void = () => undefined
    listWorkspaceDirMock.mockImplementation((_root: string, rel?: string) =>
      rel === "projects"
        ? new Promise((resolve) => {
            resolveProjects = resolve
          })
        : Promise.resolve(TREE[""])
    )
    fireEvent.pointerEnter(row)
    act(() => jest.advanceTimersByTime(200))
    fireEvent.click(row)
    await act(async () => resolveProjects(TREE.projects))

    expect(listWorkspaceDirMock.mock.calls.filter(([, rel]) => rel === "projects")).toHaveLength(1)
    expect(await folderRow("api")).toBeInTheDocument()
  } finally {
    jest.useRealTimers()
  }
})

it("never lets a slow answer for a folder already left replace the one on screen", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  let resolveSlow: (value: unknown) => void = () => undefined
  listWorkspaceDirMock.mockImplementation(async (_root: string, rel?: string) => {
    if (rel === "projects")
      return new Promise((resolve) => {
        resolveSlow = resolve
      })
    return TREE[""]
  })

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
  fireEvent.click(await folderRow("projects"))
  // Back out before the Host answers.
  fireEvent.click(
    within(screen.getByRole("list", { name: "breadcrumb" })).getByRole("button", {
      name: "workspaces",
    })
  )
  await act(async () => resolveSlow(TREE.projects))

  expect(screen.getByTestId("workspace-folder-current")).toHaveTextContent("workspaces")
  expect(screen.queryByRole("option", { name: "openFolder:api" })).not.toBeInTheDocument()
  expect(screen.getByRole("option", { name: "openFolder:projects" })).toBeInTheDocument()
})

it("goes straight to a typed path inside a declared root", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  serveTree({
    ...TREE,
    "projects/api": [dir("projects/api/src", "/srv/workspaces/projects/api/src")],
  })

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
  await folderRow("projects")

  fireEvent.click(screen.getByRole("button", { name: "editPath" }))
  fireEvent.change(screen.getByLabelText("pathLabel"), {
    target: { value: "/srv/workspaces/projects/api" },
  })
  fireEvent.click(screen.getByRole("button", { name: "go" }))

  expect(await folderRow("src")).toBeInTheDocument()
  expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv/workspaces", "projects/api")
  // One hop, not a walk down every ancestor.
  expect(listWorkspaceDirMock).not.toHaveBeenCalledWith("/srv/workspaces", "projects")
  expect(screen.getByTestId("workspace-folder-current")).toHaveTextContent("api")
})

it("hides dot-folders until asked, and filters the folder it is in", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  serveTree(TREE)

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
  await folderRow("projects")
  expect(screen.queryByRole("option", { name: "openFolder:.cache" })).not.toBeInTheDocument()

  const toggle = screen.getByRole("button", { name: "showHidden:1" })
  fireEvent.click(toggle)
  expect(await folderRow(".cache")).toBeInTheDocument()

  fireEvent.change(screen.getByLabelText("filterLabel"), { target: { value: "zzz" } })
  expect(await screen.findByText("noMatches:zzz")).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "clearFilter" }))
  expect(await folderRow("projects")).toBeInTheDocument()
})

it("drives the list from the keyboard: arrows move, Enter enters, Backspace goes up", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  serveTree(TREE)

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
  await folderRow("projects")
  const filter = screen.getByLabelText("filterLabel")

  fireEvent.keyDown(filter, { key: "Enter" })
  expect(await folderRow("api")).toBeInTheDocument()
  fireEvent.keyDown(screen.getByLabelText("filterLabel"), { key: "ArrowDown" })
  expect(screen.getByRole("option", { name: "openFolder:web" })).toHaveAttribute(
    "aria-selected",
    "true"
  )
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Backspace" })
  expect(await folderRow("projects")).toBeInTheDocument()
  expect(screen.getByTestId("workspace-folder-current")).toHaveTextContent("workspaces")
})

it("falls back to the default export dir when the Host reports no roots", async () => {
  // An older Host has no roots command. Empty means "it did not say", so the
  // previous starting point must still be used instead of a dead dialog.
  listWorkspaceRootsMock.mockResolvedValue([])
  listWorkspaceDirMock.mockResolvedValue([dir("projects", "/srv/projects")])

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await folderRow("projects")).toBeInTheDocument()
  expect(defaultExportDirMock).toHaveBeenCalled()
  expect(listWorkspaceDirMock).toHaveBeenCalledWith("/srv", undefined)
})

it("says the Host refused the path, quotes it, and offers the roots it does allow", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  const refusal = Object.assign(
    new Error(
      'workspace root denied: cwd "/Users/me/code" escapes the workspaces root "/srv/workspaces"'
    ),
    { code: "remote_control_forbidden", retryable: false }
  )
  listWorkspaceDirMock.mockRejectedValue(refusal)

  render(
    <WorkspaceFolderPicker
      open
      initialPath="/Users/me/code"
      onOpenChange={jest.fn()}
      onSelect={jest.fn()}
    />
  )

  const alert = await screen.findByRole("alert")
  expect(alert).toHaveTextContent("loadRefused")
  expect(alert).toHaveTextContent(/escapes the workspaces root/)
  expect(alert).not.toHaveTextContent("loadError")
  // Retrying a refusal cannot help, so it is not offered.
  expect(within(alert).queryByRole("button", { name: /retry/ })).not.toBeInTheDocument()
  // The recovery is one click, not a path the user has to reconstruct.
  expect(within(alert).getByRole("button", { name: "/srv/workspaces" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "chooseCurrent" })).toBeDisabled()
})

it("keeps the generic message for a transport failure and retries on request", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  const blip = Object.assign(new Error("network"), { code: "network", retryable: true })
  listWorkspaceDirMock.mockRejectedValueOnce(blip).mockResolvedValue(TREE[""])

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  const alert = await screen.findByRole("alert")
  expect(alert).toHaveTextContent("loadError")
  expect(alert).not.toHaveTextContent("loadRefused")
  fireEvent.click(within(alert).getByRole("button", { name: "retry" }))
  expect(await folderRow("projects")).toBeInTheDocument()
})

it("reports a refusal raised while resolving the fallback starting path", async () => {
  defaultExportDirMock.mockRejectedValue(
    Object.assign(new Error("no default directory on this host"), {
      code: "unknown_command",
      retryable: false,
    })
  )

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await screen.findByRole("alert")).toHaveTextContent("loadRefused")
})

it("disables the parent button at a declared root rather than hiding it", async () => {
  // Hiding it would merge "there is nothing above this" with "this control does
  // not exist here". The Host's confinement is a fact the user should see.
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  listWorkspaceDirMock.mockResolvedValue([])

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await screen.findByText("empty")).toBeInTheDocument()
  const up = screen.getByRole("button", { name: "up" })
  expect(up).toBeDisabled()
  expect(up).toHaveAttribute("title", "upConfined")
})

it("climbs above an undeclared root on a desktop Host", async () => {
  listWorkspaceRootsMock.mockResolvedValue([])
  listWorkspaceDirMock.mockResolvedValue([dir("projects", "/srv/projects")])

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
  await folderRow("projects")
  fireEvent.click(screen.getByRole("button", { name: "up" }))

  await waitFor(() => expect(listWorkspaceDirMock).toHaveBeenCalledWith("/", undefined))
})

it("keeps the Choose button outside the scrolling body so a short window cannot hide it", async () => {
  // With no height cap the dialog ran past a short window and took the footer,
  // the one control that finishes the task, with it. jsdom does no layout, so
  // this pins the structure that makes that impossible: a capped column whose
  // body scrolls and whose footer is not part of that body.
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  serveTree(TREE)

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)
  await folderRow("projects")

  const dialog = screen.getByRole("dialog")
  expect(dialog).toHaveClass("flex", "flex-col")
  expect(dialog.className).toMatch(/max-h-\[min\(90dvh/)
  const body = screen.getByTestId("workspace-folder-body")
  expect(body).toHaveClass("min-h-0", "flex-1")
  expect(body).not.toContainElement(screen.getByRole("button", { name: "chooseCurrent" }))
})

it("lets a long root path shrink its entry so the path truncates instead of overflowing", async () => {
  const longRoot = {
    path: "/srv/a/very/deeply/nested/workspaces/root/that/does/not/fit/on/one/line",
    source: "headless-workspaces-dir" as const,
  }
  listWorkspaceRootsMock.mockResolvedValue([longRoot])

  render(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  const entry = await screen.findByRole("button", { name: `openRootAction:${longRoot.path}` })
  // A flex item's default `min-width: auto` is its content, which is what let
  // the path push the entry wider than the dialog.
  expect(entry.closest("li")).toHaveClass("min-w-0", "max-w-full")
  expect(entry).toHaveAttribute("aria-current", "location")
})

it("asks the Host afresh on every opening", async () => {
  listWorkspaceRootsMock.mockResolvedValue([HEADLESS_ROOT])
  serveTree(TREE)
  const { rerender } = render(
    <WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />
  )
  await folderRow("projects")
  const calls = listWorkspaceDirMock.mock.calls.length

  rerender(<WorkspaceFolderPicker open={false} onOpenChange={jest.fn()} onSelect={jest.fn()} />)
  rerender(<WorkspaceFolderPicker open onOpenChange={jest.fn()} onSelect={jest.fn()} />)

  expect(await folderRow("projects")).toBeInTheDocument()
  expect(listWorkspaceDirMock.mock.calls.length).toBe(calls + 1)
  expect(listWorkspaceRootsMock).toHaveBeenCalledTimes(2)
})
