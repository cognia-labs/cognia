/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun, getExecutionRun } from "@/lib/db/execution-runs"
import { executeRunControlCommand } from "@/lib/execution/run-control"
import { controlBestOfNRun, installBestOfNRunControl } from "./run-control"

const canManage = jest.fn(() => true)
jest.mock("./projection", () => ({ canManageBestOfNRuns: () => canManage() }))
const cancel = jest.fn(async (_groupId: string) => ({
  groupId: "group-1",
  teamRunId: "team-run-1",
  phase: "cancelled" as string,
}))
jest.mock("./service", () => ({ cancelBestOfN: (id: string) => cancel(id) }))

const ROW = "execution:best-of-n:team-run-1"
const command = (action: string, key = action) => ({
  runId: ROW,
  action: action as "stop",
  idempotencyKey: `bon-${key}`,
  expectedRevision: 0,
  actor: {},
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  jest.clearAllMocks()
  canManage.mockReturnValue(true)
  await createExecutionRun({
    id: ROW,
    kind: "best-of-n",
    sourceId: "group-1",
    title: "Fix it",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
  })
})

it("stops the group through the Best-of-N service and settles its row once it is cancelled", async () => {
  await controlBestOfNRun(command("stop"))
  expect(cancel).toHaveBeenCalledWith("group-1")
  expect((await getExecutionRun(ROW))?.status).toBe("cancelled")
})

it("leaves the row to the group's own ending while the stop is still winding down", async () => {
  cancel.mockResolvedValueOnce({ groupId: "group-1", teamRunId: "team-run-1", phase: "cancelling" })
  await controlBestOfNRun(command("stop"))
  expect((await getExecutionRun(ROW))?.status).toBe("running")
})

it("refuses off the Host, and for a row that names no group", async () => {
  canManage.mockReturnValue(false)
  await expect(controlBestOfNRun(command("stop"))).rejects.toThrow(/managed on the Host/)
  await expect(
    controlBestOfNRun({ ...command("stop"), runId: "execution:best-of-n:missing" })
  ).rejects.toThrow(/group not found/)
  expect(cancel).not.toHaveBeenCalled()
})

it("has no steer, pause, resume or retry to offer, and opening details touches nothing", async () => {
  for (const action of ["steer", "pause", "resume", "retry"]) {
    await expect(controlBestOfNRun(command(action))).rejects.toMatchObject({
      name: "UnsupportedForKindError",
      kind: "best-of-n",
    })
  }
  await controlBestOfNRun(command("open_details"))
  expect(cancel).not.toHaveBeenCalled()
})

it("answers the control gate once installed, the way the monitor and a paired client reach it", async () => {
  // The row has no initiator, as the team row it replaces had none: the local
  // console's operator grant is what lets the monitor stop it.
  const stop = { ...command("stop", "gate"), actor: { remoteUserId: "operator-1" } }
  const dispose = installBestOfNRunControl()
  const result = await executeRunControlCommand(stop, { operatorIds: ["operator-1"] })
  expect(result.accepted).toBe(true)
  expect(cancel).toHaveBeenCalledWith("group-1")
  dispose()
  const after = await executeRunControlCommand(
    {
      ...stop,
      idempotencyKey: "bon-after",
      expectedRevision: (await getExecutionRun(ROW))!.currentRevision,
    },
    { operatorIds: ["operator-1"] }
  )
  expect(after.accepted).toBe(false)
})
