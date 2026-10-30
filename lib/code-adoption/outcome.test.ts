/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"

import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"
import type { PatchSet } from "@/lib/task-workspace/types"

import { recordTaskWorkspaceOutcome } from "./outcome"
import { getCodeAdoptionTurn, persistCodeAdoptionTurn } from "./persist"
import type { CodeAdoptionTurnRow } from "./types"

const row: CodeAdoptionTurnRow = {
  id: "session:3",
  runId: 3,
  sessionId: "session",
  taskWorkspaceRunId: "run:session:3",
  workspaceRoot: "/repo",
  agentKind: "in-app",
  model: "opus",
  ts: 100,
  totalFiles: 1,
  totalAdded: 4,
  totalRemoved: 2,
  files: [
    {
      path: "src/a.ts",
      added: 4,
      removed: 2,
      isNew: false,
      hunks: [],
      acceptedAdded: 0,
      acceptedRemoved: 0,
      adoptionState: "pending",
    },
  ],
  truncated: false,
  measurement: "taskWorkspace",
  trackingState: "tracked",
  adoptionState: "pending",
  proposedFiles: 1,
  proposedAdded: 4,
  proposedRemoved: 2,
  acceptedFiles: 0,
  acceptedAdded: 0,
  acceptedRemoved: 0,
}

const patch: PatchSet = {
  patchId: "patch:run:session:3",
  taskId: "task:message",
  runId: "run:session:3",
  state: "applied",
  baseRevision: 0,
  appliedRevision: 1,
  reversible: true,
  appliedSelectionKnown: true,
  appliedSelection: [{ path: "src/a.ts", hunkIds: ["h1"] }],
  files: [
    {
      path: "src/a.ts",
      oldPath: null,
      kind: "modified",
      resourceKind: "file",
      beforeHash: "before",
      afterHash: "after",
      beforeMode: 420,
      afterMode: 420,
      binary: false,
      hunks: [
        {
          id: "h1",
          header: "@@ -1,2 +1,2 @@",
          forwardPatchHash: "f1",
          inversePatchHash: "i1",
          additions: 2,
          deletions: 1,
        },
        {
          id: "h2",
          header: "@@ -10,2 +10,3 @@",
          forwardPatchHash: "f2",
          inversePatchHash: "i2",
          additions: 2,
          deletions: 1,
        },
      ],
    },
  ],
  createdAt: 100,
}

beforeEach(async () => {
  clearAccountDatabaseSelection()
  await getDb().codeAdoptionTurns.clear()
  await persistCodeAdoptionTurn(row)
})

afterEach(() => clearAccountDatabaseSelection())

it("does not write the previous account's outcome after its row read completes in a new namespace", async () => {
  const table = getDb().codeAdoptionTurns
  let finish!: (value: CodeAdoptionTurnRow) => void
  const read = jest.spyOn(table, "get").mockImplementationOnce(
    () =>
      new Dexie.Promise<CodeAdoptionTurnRow>((resolve) => {
        finish = resolve
      })
  )
  const result = recordTaskWorkspaceOutcome(patch)
  activateAccountDatabase("code-adoption-outcome-other", "host-B")
  await getDb().codeAdoptionTurns.clear()
  finish(row)
  await expect(result).rejects.toThrow(/database scope changed/i)
  expect(await getDb().codeAdoptionTurns.toArray()).toEqual([])
  read.mockRestore()
})

it("records a partial hunk application as the adopted subset", async () => {
  await recordTaskWorkspaceOutcome(patch)

  expect(await getCodeAdoptionTurn("session:3")).toEqual(
    expect.objectContaining({
      adoptionState: "partiallyAccepted",
      acceptedFiles: 1,
      acceptedAdded: 2,
      acceptedRemoved: 1,
    })
  )
})

it("removes adopted lines after the applied patch is undone", async () => {
  await recordTaskWorkspaceOutcome({ ...patch, state: "reverted" })

  expect(await getCodeAdoptionTurn("session:3")).toEqual(
    expect.objectContaining({
      adoptionState: "reverted",
      acceptedFiles: 0,
      acceptedAdded: 0,
      acceptedRemoved: 0,
    })
  )
})

it("updates only the owning root when two captured runs changed the same path", async () => {
  await persistCodeAdoptionTurn({
    ...row,
    taskWorkspaceRuns: [
      { runId: patch.runId, workspaceRoot: "/one" },
      { runId: "run:other", workspaceRoot: "/two" },
    ],
    totalFiles: 2,
    totalAdded: 8,
    totalRemoved: 4,
    proposedFiles: 2,
    proposedAdded: 8,
    proposedRemoved: 4,
    files: [
      {
        ...row.files[0],
        taskWorkspaceRunId: patch.runId,
        workspaceRoot: "/one",
        adoptionState: "accepted",
        acceptedAdded: 4,
        acceptedRemoved: 2,
      },
      {
        ...row.files[0],
        taskWorkspaceRunId: "run:other",
        workspaceRoot: "/two",
        adoptionState: "accepted",
        acceptedAdded: 4,
        acceptedRemoved: 2,
      },
    ],
  })
  await recordTaskWorkspaceOutcome({ ...patch, runId: "run:other", state: "reverted" })
  const updated = await getCodeAdoptionTurn(row.id)
  expect(updated?.files.map((file) => [file.taskWorkspaceRunId, file.adoptionState])).toEqual([
    [patch.runId, "accepted"],
    ["run:other", "reverted"],
  ])
  expect(updated).toMatchObject({
    adoptionState: "partiallyAccepted",
    acceptedFiles: 1,
    acceptedAdded: 4,
    acceptedRemoved: 2,
  })
})
