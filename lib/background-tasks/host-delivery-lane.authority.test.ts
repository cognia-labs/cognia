/** @jest-environment jsdom */
/** The node-only lane suite replaces acceptance; this fixture exercises its real Dexie transaction. */
import "fake-indexeddb/auto"
import { webcrypto } from "node:crypto"
import type { ChatSession } from "@cognia/agent-config-types"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { ensureDirectChatExecutionRun } from "@/lib/execution/direct-chat-run"
import { acceptChatTurn } from "@/lib/work-submission/chat-adapter"
import {
  clearActiveRuntimeTargetContext,
  setActiveRuntimeTargetContext,
} from "@/lib/runtime/runtime-target-context"
import { runHostAutomatedTurn, type HostAutomatedTurnDeps } from "./host-delivery-lane"

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true })
})
beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  setActiveRuntimeTargetContext("account", "target")
}, 30_000)
afterEach(() => clearActiveRuntimeTargetContext())

it.each([true, false])(
  "Host background admission uses the thread's captured parent, present=%s",
  async (present) => {
    if (present) {
      await ensureDirectChatExecutionRun({ sessionId: "coordinator", runId: "coordinator" })
      await getDb().executionRuns.update("coordinator", {
        authority: {
          schemaVersion: 1,
          caps: "explicit-v1" as const,
          permissionMode: "plan",
          maxTurns: 2,
        },
      })
    }
    const session = {
      id: "thread",
      projectThread: { parentExecutionRunId: "coordinator" },
    } as ChatSession
    let settled!: () => void
    let failed!: (error: unknown) => void
    const stopped = new Promise<void>((resolve, reject) => {
      settled = resolve
      failed = reject
    })
    const deps: HostAutomatedTurnDeps = {
      getSession: async () => session,
      isBuiltinRuntime: () => true,
      existingSubmission: async (id) => getDb().workSubmissions.get(`work:${id}`),
      listMessageIds: async () => [],
      accept: (input) => acceptChatTurn(input, { loadKey: async () => new Uint8Array(32).fill(3) }),
      claim: async () => "claimed",
      markStarted: async () => {
        settled()
        return true
      },
      heartbeat: () => () => {},
      writeUserRow: async () => {},
      bindMessageRuns: () => {},
      prepareText: async (_id, text) => text,
      buildOptions: async () => ({}),
      dispatch: jest.fn(async () => {}),
      onError: (error) => failed(error),
    }
    const delivery = { sessionId: "thread", deliveryId: "delivery", text: "result" }
    expect(await runHostAutomatedTurn(delivery, deps)).toBe(true)
    await stopped
    const run = await getDb().executionRuns.get("delivery")
    expect(run?.parentRunId).toBe(present ? "coordinator" : undefined)
    if (present)
      expect(run?.authority).toEqual({
        schemaVersion: 1,
        caps: "explicit-v1",
        permissionMode: "plan",
        maxTurns: 2,
      })
    else
      expect(
        JSON.stringify(await getDb().executionRunEvents.where("runId").equals("delivery").toArray())
      ).toContain("coordinator_parent_unavailable")
    expect(await runHostAutomatedTurn(delivery, deps)).toBe(true)
    expect(deps.dispatch).toHaveBeenCalledTimes(1)
  },
  30_000
)
