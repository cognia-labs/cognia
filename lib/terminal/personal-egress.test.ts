/** @jest-environment jsdom */
const proofListeners = new Map<string, (event: { payload: { sessionId: string } }) => void>()
const proofInvoke = jest.fn(async (..._args: unknown[]) => ({ status: "stillRunning" }))
jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(
    async (topic: string, callback: (event: { payload: { sessionId: string } }) => void) => {
      proofListeners.set(topic, callback)
      return () => proofListeners.delete(topic)
    }
  ),
}))
jest.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => proofInvoke(...args) }))
import { BaseTerminalSession } from "./base-session"
import { registerLiveSession, unregisterLiveSession } from "./session-registry"
import { retainTerminalPersonalEgress } from "./personal-egress"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { startToolExecutionRun, LOCAL_PERSON_RUN } from "@/lib/execution/acting-authority"
import { addPersonalMarksToRun } from "@/lib/execution/personal-marks"
import { readRunPersonalTaint } from "@/lib/execution/personal-sink"

class LeaseSession extends BaseTerminalSession {
  readonly info = { id: "lease-pty", alive: true } as import("./types").SessionInfo
  async write() {}
  async resize() {}
  async detach() {}
  async takeControl() {}
  async releaseControl() {}
  async kill() {
    this.handleExit(null)
  }
  disconnect() {
    this.handleExit(null, false)
  }
}
const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)
it("F5 transport loss and missing handles retain a PTY lease until a confirmed Host exit", async () => {
  const owner = await startToolExecutionRun("lease-owner", { localAuthorization: LOCAL_PERSON_RUN })
  const child = await startToolExecutionRun("lease-child", { parentRunId: owner.id })
  const session = new LeaseSession()
  registerLiveSession(session)
  const mark = { person: { kind: "local-person" as const }, source: "F5", markedAt: 1 }
  try {
    retainTerminalPersonalEgress({ executionRunId: owner.id }, session.id)
    expect(await readRunPersonalTaint({ executionRunId: child.id })).toMatchObject({
      verified: true,
      marks: [],
    })
    session.disconnect()
    unregisterLiveSession(session.id)
    await expect(addPersonalMarksToRun({ executionRunId: child.id }, [mark])).rejects.toMatchObject(
      { code: "personal-egress-denied" }
    )
    await session.kill()
    await expect(
      addPersonalMarksToRun({ executionRunId: child.id }, [mark])
    ).resolves.toBeUndefined()
  } finally {
    await session.kill()
    unregisterLiveSession(session.id)
  }
})

it("F5 a replacement handle's confirmed exit survives registry removal", async () => {
  const owner = await startToolExecutionRun("replacement-owner", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await startToolExecutionRun("replacement-child", { parentRunId: owner.id })
  const original = new LeaseSession()
  const replacement = new LeaseSession()
  registerLiveSession(original)
  try {
    retainTerminalPersonalEgress({ executionRunId: owner.id }, original.id)
    original.disconnect()
    unregisterLiveSession(original.id)
    registerLiveSession(replacement)
    await replacement.kill()
    unregisterLiveSession(replacement.id)
    await expect(
      addPersonalMarksToRun({ executionRunId: child.id }, [
        { person: { kind: "local-person" }, source: "F5", markedAt: 1 },
      ])
    ).resolves.toBeUndefined()
  } finally {
    await replacement.kill()
    unregisterLiveSession(replacement.id)
  }
})

it("test reset releases synthetic leases without changing production exit rules", async () => {
  const { __clearTerminalPersonalEgressForTesting } = await import("./personal-egress")
  const run = await startToolExecutionRun("test-reset", { localAuthorization: LOCAL_PERSON_RUN })
  retainTerminalPersonalEgress({ executionRunId: run.id }, "synthetic-unconfirmed")
  __clearTerminalPersonalEgressForTesting()
  await expect(
    addPersonalMarksToRun({ executionRunId: run.id }, [
      { person: { kind: "local-person" }, source: "reset", markedAt: 1 },
    ])
  ).resolves.toBeUndefined()
})

it("R11 headless lease subscribes to real exit proof and releases before quiesce", async () => {
  const { retainHeadlessPersonalEgress, __clearTerminalPersonalEgressForTesting } =
    await import("./personal-egress")
  const owner = await startToolExecutionRun("r11-proof-owner", {
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await startToolExecutionRun("r11-proof-child", { parentRunId: owner.id })
  retainHeadlessPersonalEgress({ executionRunId: owner.id }, "r11-proof-session")
  for (let n = 0; !proofListeners.size && n < 100; n++)
    await new Promise((resolve) => setTimeout(resolve, 1))
  expect(proofListeners.has("terminal:headless-exit-proof")).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(proofInvoke).toHaveBeenCalledWith("terminal_headless_kill", {
    sessionId: "r11-proof-session",
    observeOnly: true,
  })
  const event = proofListeners.get("terminal:headless-exit-proof")!
  event({ payload: { sessionId: "unrelated" } })
  event({ payload: { sessionId: "r11-proof-session" } })
  expect(proofListeners.size).toBe(0)
  await expect(
    addPersonalMarksToRun({ executionRunId: child.id }, [
      { person: { kind: "local-person" }, source: "R11", markedAt: 1 },
    ])
  ).resolves.toBeUndefined()
  __clearTerminalPersonalEgressForTesting()
})
