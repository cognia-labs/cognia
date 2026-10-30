/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import Dexie from "dexie"

import { activateAccountDatabase, clearAccountDatabaseSelection, getDb } from "@/lib/db/schema"

import {
  getCodeAdoptionTurn,
  getCodeAdoptionTurnByTaskWorkspaceRun,
  getCodeAdoptionTurnForMessage,
  listCodeAdoptionTurnsInRange,
  listCodeAdoptionTurnsBySession,
  listRecentCodeAdoptionTurns,
  persistCodeAdoptionTurn,
  pruneCodeAdoptionTurns,
  captureCodeAdoptionDatabaseScope,
} from "./persist"
import type { CodeAdoptionTurnRow } from "./types"

beforeEach(async () => {
  clearAccountDatabaseSelection()
  await getDb().codeAdoptionTurns.clear()
}, 30_000)
afterEach(() => clearAccountDatabaseSelection())

function turn(sessionId: string, runId: number, ts: number): CodeAdoptionTurnRow {
  return {
    id: `${sessionId}:${runId}`,
    runId,
    sessionId,
    workspaceRoot: "/repo",
    agentKind: "in-app",
    model: "claude-opus-4-8",
    ts,
    totalFiles: 1,
    totalAdded: 3,
    totalRemoved: 1,
    files: [{ path: "a.ts", added: 3, removed: 1, isNew: true, hunks: [[1, 3]] }],
    truncated: false,
  }
}

it("persists and reads back by id", async () => {
  await persistCodeAdoptionTurn(turn("s1", 1, 100))
  const row = await getCodeAdoptionTurn("s1:1")
  expect(row?.totalAdded).toBe(3)
  expect(row?.files[0].hunks).toEqual([[1, 3]])
})

it("rejects stale writes and pruning instead of selecting the newly active database", async () => {
  const scope = captureCodeAdoptionDatabaseScope()
  activateAccountDatabase("code-adoption-persist-other", "host-B")
  await getDb().codeAdoptionTurns.clear()
  await persistCodeAdoptionTurn(turn("new-account", 1, 100))
  await expect(persistCodeAdoptionTurn(turn("old-account", 1, 1), scope)).rejects.toThrow(
    /database scope changed/i
  )
  await expect(pruneCodeAdoptionTurns(0, scope)).rejects.toThrow(/database scope changed/i)
  expect((await getDb().codeAdoptionTurns.toArray()).map((row) => row.sessionId)).toEqual([
    "new-account",
  ])
})

it("does not fall through a delayed run lookup into a newly active database", async () => {
  const table = getDb().codeAdoptionTurns
  let finish!: (value: undefined) => void
  const read = jest.spyOn(table, "get").mockImplementationOnce(
    () =>
      new Dexie.Promise<undefined>((resolve) => {
        finish = resolve
      })
  )
  const result = getCodeAdoptionTurnByTaskWorkspaceRun("run:missing")
  activateAccountDatabase("code-adoption-lookup-other", "host-B")
  await getDb().codeAdoptionTurns.clear()
  await persistCodeAdoptionTurn({
    ...turn("other-account", 1, 10),
    taskWorkspaceRunId: "run:missing",
  })
  finish(undefined)
  await expect(result).rejects.toThrow(/database scope changed/i)
  read.mockRestore()
})

it("put is idempotent on the same turn key", async () => {
  await persistCodeAdoptionTurn(turn("s1", 1, 100))
  await persistCodeAdoptionTurn({ ...turn("s1", 1, 200), totalAdded: 9 })
  const all = await listCodeAdoptionTurnsBySession("s1")
  expect(all).toHaveLength(1)
  expect(all[0].totalAdded).toBe(9)
})

it("lists a session's turns oldest-first", async () => {
  await persistCodeAdoptionTurn(turn("s1", 2, 200))
  await persistCodeAdoptionTurn(turn("s1", 1, 100))
  await persistCodeAdoptionTurn(turn("s2", 1, 150))
  const rows = await listCodeAdoptionTurnsBySession("s1")
  expect(rows.map((r) => r.runId)).toEqual([1, 2])
})

it("lists recent turns newest-first, capped", async () => {
  for (let i = 0; i < 5; i++) await persistCodeAdoptionTurn(turn("s1", i, i * 10))
  const rows = await listRecentCodeAdoptionTurns(3)
  expect(rows.map((r) => r.ts)).toEqual([40, 30, 20])
})

it("prunes to the newest kept rows", async () => {
  for (let i = 0; i < 5; i++) await persistCodeAdoptionTurn(turn("s1", i, i * 10))
  const removed = await pruneCodeAdoptionTurns(2)
  expect(removed).toBe(3)
  const rest = await listRecentCodeAdoptionTurns(10)
  expect(rest.map((r) => r.ts)).toEqual([40, 30])
})

it("prune is a no-op below the cap", async () => {
  await persistCodeAdoptionTurn(turn("s1", 1, 10))
  expect(await pruneCodeAdoptionTurns(5)).toBe(0)
})

it("resolves a row from its authoritative Task Workspace run", async () => {
  await persistCodeAdoptionTurn({
    ...turn("s1", 1, 10),
    taskWorkspaceRunId: "run:s1:1",
    measurement: "taskWorkspace",
  })
  expect((await getCodeAdoptionTurnByTaskWorkspaceRun("run:s1:1"))?.id).toBe("s1:1")
})

it("resolves every physical run of a multi-root turn", async () => {
  await persistCodeAdoptionTurn({
    ...turn("s1", 1, 10),
    measurement: "taskWorkspace",
    taskWorkspaceRunId: "run:primary",
    taskWorkspaceRuns: [
      { runId: "run:primary", workspaceRoot: "/primary", origin: { kind: "local" } },
      { runId: "run:other", workspaceRoot: "/other", origin: { kind: "remote", hostId: "host-a" } },
    ],
  })
  expect((await getCodeAdoptionTurnByTaskWorkspaceRun("run:other"))?.id).toBe("s1:1")
})

it("does not project a same-named run from a different originating Host", async () => {
  await persistCodeAdoptionTurn({
    ...turn("s1", 1, 10),
    taskWorkspaceRunId: "native-run",
    origin: { kind: "remote", hostId: "host-a" },
  })
  await persistCodeAdoptionTurn({
    ...turn("s1", 2, 20),
    taskWorkspaceRunId: "native-run",
    origin: { kind: "remote", hostId: "host-b" },
  })
  expect(
    (
      await getCodeAdoptionTurnByTaskWorkspaceRun("native-run", {
        kind: "remote",
        hostId: "host-b",
      })
    )?.id
  ).toBe("s1:2")
  expect(
    await getCodeAdoptionTurnByTaskWorkspaceRun("native-run", { kind: "local" })
  ).toBeUndefined()
})

it("returns every row in an explicit inclusive time window", async () => {
  await persistCodeAdoptionTurn(turn("s1", 1, 100))
  await persistCodeAdoptionTurn(turn("s1", 2, 200))
  await persistCodeAdoptionTurn(turn("s1", 3, 300))
  expect((await listCodeAdoptionTurnsInRange(100, 200)).map((row) => row.ts)).toEqual([100, 200])
})

it("finds a session's turn by its closing message, newest first", async () => {
  await persistCodeAdoptionTurn({ ...turn("s1", 1, 100), assistantMessageId: "m1" })
  await persistCodeAdoptionTurn({ ...turn("s1", 2, 300), assistantMessageId: "m1" })
  await persistCodeAdoptionTurn({ ...turn("s2", 1, 200), assistantMessageId: "m1" })
  await persistCodeAdoptionTurn({ ...turn("s1", 3, 400), assistantMessageId: "m2" })
  expect((await getCodeAdoptionTurnForMessage("s1", "m1"))?.id).toBe("s1:2")
  expect((await getCodeAdoptionTurnForMessage("s2", "m1"))?.id).toBe("s2:1")
  expect(await getCodeAdoptionTurnForMessage("s1", "missing")).toBeUndefined()
})
