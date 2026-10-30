/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"

import { TURN_CHANGES_PREVIEW, TurnChangesCard, turnPatchRunId } from "./turn-changes-card"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

// The confirm dialog renders inline so its action is reachable without Radix.
jest.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  AlertDialogAction: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    onClick: () => void
    "data-testid"?: string
  }) => (
    <button data-testid={rest["data-testid"]} onClick={onClick}>
      {children}
    </button>
  ),
}))

let mockRow: CodeAdoptionTurnRow | null = null
jest.mock("@/hooks/chat/use-turn-changes", () => ({
  useTurnChanges: () => mockRow,
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => ({ id: "s1", projectId: "p1" }),
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn() }))
jest.mock("@/lib/workspace/session-root", () => ({
  sessionExecutionRootPath: () => "/exec-root",
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: { projects: unknown[] }) => unknown) =>
    selector({ projects: [] }),
}))

const getTaskPatchSet = jest.fn()
const undoTaskWorkspace = jest.fn()
jest.mock("@/lib/task-workspace/client", () => ({
  getTaskPatchSet: (...args: unknown[]) => getTaskPatchSet(...args),
  undoTaskWorkspace: (...args: unknown[]) => undoTaskWorkspace(...args),
}))

const revealWorkspaceReview = jest.fn()
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ revealWorkspaceReview }) },
}))

function row(over: Partial<CodeAdoptionTurnRow> = {}): CodeAdoptionTurnRow {
  return {
    id: "s1:1:e",
    runId: 1,
    sessionId: "s1",
    taskWorkspaceRunId: "run:s1:1",
    origin: { kind: "local" },
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: null,
    ts: 1,
    totalFiles: 2,
    totalAdded: 67,
    totalRemoved: 1,
    files: [
      {
        path: "packages/web/src/hooks/use-spaces.test.tsx",
        added: 65,
        removed: 0,
        isNew: true,
        hunks: [],
      },
      { path: "README.md", added: 2, removed: 1, isNew: false, hunks: [] },
    ],
    truncated: false,
    measurement: "taskWorkspace",
    trackingState: "tracked",
    adoptionState: "pending",
    ...over,
  }
}

const applied = {
  state: "applied",
  reversible: true,
  appliedSelectionKnown: true,
  appliedSelection: [],
}

function patchForRun(runId: string) {
  const captured = mockRow?.capturedFiles ?? mockRow?.files ?? []
  return {
    ...applied,
    runId,
    files: captured
      .filter((file) => !file.taskWorkspaceRunId || file.taskWorkspaceRunId === runId)
      .map((file) => ({
        path: file.path,
        origin: file.origin ?? "agent",
        kind: file.kind ?? (file.isNew ? "created" : "modified"),
        binary: false,
        hunks: [{ additions: file.added, deletions: file.removed }],
      })),
  }
}

beforeEach(() => {
  mockRow = row()
  getTaskPatchSet.mockReset().mockImplementation(async (runId: string) => patchForRun(runId))
  undoTaskWorkspace.mockReset()
  revealWorkspaceReview.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
})

async function renderCard() {
  render(<TurnChangesCard sessionId="s1" messageId="m1" />)
  await act(async () => {})
}

describe("turnPatchRunId", () => {
  it("names the run only for a Task Workspace measured turn", () => {
    expect(turnPatchRunId(row())).toBe("run:s1:1")
    expect(turnPatchRunId(row({ measurement: "legacyFingerprint" }))).toBeNull()
    expect(turnPatchRunId(row({ taskWorkspaceRunId: undefined }))).toBeNull()
  })
})

describe("TurnChangesCard", () => {
  it("hides empty records and explains unavailable tracking without a fabricated file card", async () => {
    mockRow = null
    const { rerender, container } = render(<TurnChangesCard sessionId="s1" messageId="m1" />)
    expect(container).toBeEmptyDOMElement()
    mockRow = row({ totalFiles: 0, files: [] })
    rerender(<TurnChangesCard sessionId="s1" messageId="m1" />)
    expect(container).toBeEmptyDOMElement()
    mockRow = row({ trackingState: "unavailable", totalFiles: 0, files: [] })
    rerender(<TurnChangesCard sessionId="s1" messageId="m1" />)
    expect(screen.getByRole("note")).toHaveTextContent("trackingUnavailable")
    expect(screen.queryByTestId("turn-changes-card")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "view" })).not.toBeInTheDocument()
  })

  it("shows the totals and every file with its own counts", async () => {
    await renderCard()
    expect(screen.getByTestId("turn-changes-title")).toHaveTextContent('changed:{"count":2}')
    expect(screen.getByTestId("turn-changes-total")).toHaveTextContent("+67 −1")
    expect(screen.getByTestId("turn-changes-file-README.md")).toHaveTextContent("+2 −1")
    expect(
      screen.getByTestId("turn-changes-file-packages/web/src/hooks/use-spaces.test.tsx")
    ).toHaveTextContent("packages/web/src/hooks/use-spaces.test.tsx")
  })

  it("opens the dock on this turn's diff, and on one file from its row", async () => {
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-view"))
    expect(revealWorkspaceReview).toHaveBeenCalledWith({
      sessionId: "s1",
      rootPath: "/repo",
      scope: { scope: "lastTurn", runId: "run:s1:1", origin: { kind: "local" } },
    })
    fireEvent.click(screen.getByTestId("turn-changes-file-README.md"))
    expect(revealWorkspaceReview).toHaveBeenLastCalledWith({
      sessionId: "s1",
      rootPath: "/repo",
      scope: { scope: "lastTurn", runId: "run:s1:1", origin: { kind: "local" } },
      relPath: "README.md",
    })
  })

  it("explains unavailable fingerprint history without opening the current working tree", async () => {
    mockRow = row({ measurement: "legacyFingerprint" })
    await renderCard()
    expect(getTaskPatchSet).not.toHaveBeenCalled()
    expect(screen.queryByTestId("turn-changes-undo")).toBeNull()
    expect(screen.getByRole("note")).toHaveTextContent("historyUnavailable")
    expect(screen.getByRole("button", { name: "view" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "view" }))
    expect(revealWorkspaceReview).not.toHaveBeenCalled()
  })

  it.each([
    ["ready", true],
    ["reverted", true],
    ["applied", false],
  ])(
    "hides undo for a %s patch (reversible=%s) unless applied and reversible",
    async (state, reversible) => {
      getTaskPatchSet.mockResolvedValue({ ...patchForRun("run:s1:1"), state, reversible })
      await renderCard()
      expect(screen.queryByTestId("turn-changes-undo")).toBeNull()
    }
  )

  it("undoes the turn after confirmation and reports success", async () => {
    undoTaskWorkspace.mockResolvedValue({ state: "reverted", revision: 2, conflicts: [] })
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-undo"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-changes-undo-confirm"))
    })
    expect(undoTaskWorkspace).toHaveBeenCalledWith("run:s1:1", { kind: "local" })
    expect(toastSuccess).toHaveBeenCalledWith('undoSuccess:{"count":2}')
    // The patch is re-read so the button follows the new state.
    await waitFor(() => expect(getTaskPatchSet).toHaveBeenCalledTimes(2))
  })

  it("reports a conflicted undo instead of claiming success", async () => {
    undoTaskWorkspace.mockResolvedValue({
      state: "conflict",
      revision: 2,
      conflicts: [{ path: "README.md", reason: "changed" }],
    })
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-undo"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-changes-undo-confirm"))
    })
    expect(toastError).toHaveBeenCalledWith('undoConflict:{"count":1}')
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("says there is nothing to undo when the patch turns out not to be applied", async () => {
    undoTaskWorkspace.mockResolvedValue({ state: "ready", revision: 2, conflicts: [] })
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-undo"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-changes-undo-confirm"))
    })
    expect(toastError).toHaveBeenCalledWith("undoNotApplied")
  })

  it("reports a failed undo", async () => {
    undoTaskWorkspace.mockRejectedValue(new Error("boom"))
    await renderCard()
    fireEvent.click(screen.getByTestId("turn-changes-undo"))
    await act(async () => {
      fireEvent.click(screen.getByTestId("turn-changes-undo-confirm"))
    })
    expect(toastError).toHaveBeenCalledWith('undoFailed:{"error":"boom"}')
  })

  it("says the turn was reverted once it has been", async () => {
    mockRow = row({ adoptionState: "reverted" })
    await renderCard()
    expect(screen.getByTestId("turn-changes-title")).toHaveTextContent('reverted:{"count":2}')
    expect(screen.queryByTestId("turn-changes-undo")).toBeNull()
  })

  it("lists the first files and expands to all of them", async () => {
    const files = Array.from({ length: TURN_CHANGES_PREVIEW + 3 }, (_, i) => ({
      path: `f${i}.ts`,
      added: 1,
      removed: 0,
      isNew: false,
      hunks: [] as Array<[number, number]>,
    }))
    mockRow = row({ files, totalFiles: files.length, truncated: true })
    await renderCard()
    expect(screen.getAllByTestId(/^turn-changes-file-/)).toHaveLength(TURN_CHANGES_PREVIEW)
    expect(screen.getByTestId("turn-changes-truncated")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("turn-changes-show-all"))
    expect(screen.getAllByTestId(/^turn-changes-file-/)).toHaveLength(files.length)
  })

  it("keeps same-path roots distinct and binds each View and Undo to the originating Host", async () => {
    const origin = { kind: "remote" as const, hostId: "host-a" }
    const runs = [
      { runId: "r1", workspaceRoot: "/one", origin },
      { runId: "r2", workspaceRoot: "/two", origin },
    ]
    const files = [
      {
        path: "same.ts",
        added: 1,
        removed: 0,
        isNew: false,
        hunks: [],
        taskWorkspaceRunId: "r1",
        workspaceRoot: "/one",
        origin: "agent" as const,
      },
      {
        path: "same.ts",
        added: 2,
        removed: 0,
        isNew: false,
        hunks: [],
        taskWorkspaceRunId: "r2",
        workspaceRoot: "/two",
        origin: "agent" as const,
      },
    ]
    mockRow = row({
      taskWorkspaceRunId: "r1",
      taskWorkspaceRuns: runs,
      capturedFiles: [
        ...files,
        {
          path: "upload.txt",
          added: 3,
          removed: 0,
          isNew: true,
          hunks: [],
          taskWorkspaceRunId: "r2",
          workspaceRoot: "/two",
          origin: "user",
        },
      ],
      files,
      totalFiles: 2,
    })
    undoTaskWorkspace.mockResolvedValue({ state: "reverted", conflicts: [] })
    await renderCard()
    expect(getTaskPatchSet).toHaveBeenCalledWith("r2", origin)
    expect(screen.getByTestId("turn-changes-title")).toHaveTextContent('changed:{"count":3}')
    expect(screen.getByText("userContribution")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "view" }))
    expect(revealWorkspaceReview).toHaveBeenLastCalledWith({
      sessionId: "s1",
      rootPath: "/one",
      scope: { scope: "lastTurn", runId: "r1", origin, runs },
    })
    fireEvent.click(screen.getByRole("button", { name: /\/two.*same\.ts/ }))
    expect(revealWorkspaceReview).toHaveBeenLastCalledWith({
      sessionId: "s1",
      rootPath: "/two",
      relPath: "same.ts",
      scope: { scope: "lastTurn", runId: "r2", origin },
    })
    expect(screen.queryByRole("button", { name: "undo" })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: 'undoRoot:{"root":"/two"}' }))
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      'undoRootConfirmDescription:{"root":"/two","count":2}'
    )
    expect(screen.getByRole("alertdialog")).toHaveTextContent('undoUserContributions:{"count":1}')
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "undoConfirm" }))
    })
    expect(undoTaskWorkspace).toHaveBeenCalledWith("r2", origin)
    expect(toastSuccess).toHaveBeenCalledWith('undoSuccess:{"count":2}')
  })

  it("includes an old record's omitted upload before offering whole-patch Undo", async () => {
    const patch = patchForRun("run:s1:1")
    getTaskPatchSet.mockResolvedValue({
      ...patch,
      files: [
        ...patch.files,
        {
          path: "user.txt",
          origin: "user",
          kind: "created",
          binary: false,
          hunks: [{ additions: 3, deletions: 0 }],
        },
      ],
    })
    await renderCard()
    expect(screen.getByTestId("turn-changes-title")).toHaveTextContent('changed:{"count":3}')
    expect(screen.getByRole("button", { name: /user\.txt.*userContribution/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "undo" }))
    expect(screen.getByRole("alertdialog")).toHaveTextContent('undoConfirmDescription:{"count":3}')
    expect(screen.getByRole("alertdialog")).toHaveTextContent('undoUserContributions:{"count":1}')
  })

  it("heals a legacy user-only turn whose agent metric file count was zero", async () => {
    mockRow = row({ totalFiles: 0, files: [], capturedFiles: undefined })
    getTaskPatchSet.mockResolvedValue({
      ...applied,
      runId: "run:s1:1",
      files: [{ path: "upload.txt", kind: "created", origin: "user", hunks: [], binary: true }],
    })
    render(<TurnChangesCard sessionId="s1" messageId="m1" />)
    expect(await screen.findByText("upload.txt")).toBeInTheDocument()
    expect(getTaskPatchSet).toHaveBeenCalledWith("run:s1:1", { kind: "local" })
    expect(screen.getByRole("button", { name: "undo" })).toBeEnabled()
  })

  it("does not offer Undo when the historical patch cannot be read", async () => {
    getTaskPatchSet.mockResolvedValue(null)
    await renderCard()
    expect(screen.getByRole("note")).toHaveTextContent("historyUnavailable")
    expect(screen.queryByRole("button", { name: "undo" })).not.toBeInTheDocument()
  })

  it("keeps origin-unknown legacy run records unavailable instead of reading the selected Host", async () => {
    mockRow = row({ origin: undefined, taskWorkspaceRuns: undefined })
    await renderCard()
    expect(getTaskPatchSet).not.toHaveBeenCalled()
    expect(screen.getByRole("note")).toHaveTextContent("historyUnavailable")
    expect(screen.getByRole("button", { name: "view" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "undo" })).not.toBeInTheDocument()
  })

  it("confirms only the applied file/hunk subset and refuses an unknown applied scope", async () => {
    const patch = patchForRun("run:s1:1")
    getTaskPatchSet.mockResolvedValue({
      ...patch,
      appliedSelection: [{ path: "README.md", hunkIds: ["h1"] }],
    })
    undoTaskWorkspace.mockResolvedValue({ state: "reverted", conflicts: [] })
    const { unmount } = render(<TurnChangesCard sessionId="s1" messageId="m1" />)
    await act(async () => {})
    fireEvent.click(screen.getByRole("button", { name: "undo" }))
    expect(screen.getByRole("alertdialog")).toHaveTextContent('undoConfirmDescription:{"count":1}')
    expect(screen.getByRole("list", { name: "undoAppliedFiles" })).toHaveTextContent(
      'README.md · undoAppliedHunks:{"count":1}'
    )
    expect(screen.getByRole("list", { name: "undoAppliedFiles" })).not.toHaveTextContent(
      "use-spaces.test.tsx"
    )
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "undoConfirm" }))
    })
    expect(toastSuccess).toHaveBeenCalledWith('undoSuccess:{"count":1}')
    unmount()
    getTaskPatchSet.mockResolvedValue({ ...patch, appliedSelectionKnown: false })
    await renderCard()
    expect(screen.queryByRole("button", { name: "undo" })).not.toBeInTheDocument()
  })

  it("keeps a user-only root undoable after another root's agent metrics are reverted", async () => {
    const runs = [
      { runId: "r1", workspaceRoot: "/one", origin: { kind: "local" as const } },
      { runId: "r2", workspaceRoot: "/two", origin: { kind: "local" as const } },
    ]
    mockRow = row({
      taskWorkspaceRunId: "r1",
      taskWorkspaceRuns: runs,
      adoptionState: "reverted",
      capturedFiles: [
        {
          path: "a.ts",
          added: 1,
          removed: 0,
          isNew: true,
          hunks: [],
          taskWorkspaceRunId: "r1",
          workspaceRoot: "/one",
          origin: "agent",
        },
        {
          path: "upload.txt",
          added: 1,
          removed: 0,
          isNew: true,
          hunks: [],
          taskWorkspaceRunId: "r2",
          workspaceRoot: "/two",
          origin: "user",
        },
      ],
    })
    getTaskPatchSet.mockImplementation(async (runId: string) => ({
      ...patchForRun(runId),
      state: runId === "r1" ? "reverted" : "applied",
    }))
    await renderCard()
    expect(screen.getByRole("button", { name: 'undoRoot:{"root":"/two"}' })).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: 'undoRoot:{"root":"/one"}' })
    ).not.toBeInTheDocument()
    expect(screen.getByTestId("turn-changes-title")).toHaveTextContent("changed")
  })
})
