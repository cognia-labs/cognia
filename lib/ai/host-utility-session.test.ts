jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueueHostStateIntentIfAvailable: jest.fn(async (input) => ({ id: input.actionId })),
  awaitHostStateIntentSettlement: jest.fn(async () => ({ outcome: "applied" })),
}))
jest.mock("@/lib/sync/host-state-service", () => ({ hydrateHostStateSession: jest.fn() }))
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  getRuntimeSnapshot: jest.fn(() => ({
    host: { hostStateScope: { accountId: "host-account", runtimeTargetId: "host-target" } },
  })),
}))
jest.mock("@/lib/tauri", () => ({ transport: {} }))
jest.mock("@/lib/claude/ipc", () => ({ closeSession: jest.fn() }))

import {
  awaitHostStateIntentSettlement,
  enqueueHostStateIntentIfAvailable,
} from "@/lib/db/mobile-outbound-queue"
import { hydrateHostStateSession } from "@/lib/sync/host-state-service"
import { closeSession } from "@/lib/claude/ipc"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { withHostUtilitySession } from "./host-utility-session"

const enqueue = jest.mocked(enqueueHostStateIntentIfAvailable)
const settle = jest.mocked(awaitHostStateIntentSettlement)
const run = jest.fn(async () => "reply")
const options = () => ({
  sessionId: "utility-owned",
  providerId: "openai",
  model: "private-model",
  assertCurrent: jest.fn(),
  signal: new AbortController().signal,
})

beforeEach(() => {
  jest.clearAllMocks()
  enqueue.mockImplementation(async (input) => ({ id: input.actionId }) as never)
  settle.mockResolvedValue({ outcome: "applied" })
  jest.mocked(closeSession).mockResolvedValue(undefined)
  jest.mocked(hydrateHostStateSession).mockResolvedValue(undefined)
  jest.mocked(getRuntimeSnapshot).mockReturnValue({
    host: { hostStateScope: { accountId: "host-account", runtimeTargetId: "host-target" } },
  } as never)
  run.mockResolvedValue("reply")
})

it("waits for Host admission before the model and confirms the owned deletion", async () => {
  let admit!: () => void
  const admission = new Promise<void>((resolve) => {
    admit = resolve
  })
  settle.mockImplementationOnce(async () => {
    await admission
    return { outcome: "applied" }
  })
  const pending = withHostUtilitySession(options(), run)
  while (!settle.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 0))
  expect(run).not.toHaveBeenCalled()
  admit()
  await expect(pending).resolves.toBe("reply")
  expect(enqueue.mock.calls.map(([input]) => input.action.kind)).toEqual([
    "session.create",
    "session.delete",
  ])
  expect(enqueue.mock.calls[0][0]).toEqual({
    sessionId: "utility-owned",
    actionId: "utility-owned:create",
    action: {
      kind: "session.create",
      title: "Background utility",
      seed: { provider: "openai", model: "private-model" },
    },
  })
  expect(closeSession).toHaveBeenCalledWith("utility-owned")
  expect(hydrateHostStateSession).toHaveBeenCalledWith(
    expect.objectContaining({
      accountId: "host-account",
      runtimeTargetId: "host-target",
      sessionId: "utility-owned",
    })
  )
  expect(settle).toHaveBeenLastCalledWith("utility-owned:delete", { timeoutMs: 5000 })
})

it.each(["pending", "rejected"] as const)("never sends on a %s create receipt", async (outcome) => {
  settle.mockResolvedValue(outcome === "pending" ? { outcome } : { outcome, code: "denied" })
  await expect(withHostUtilitySession(options(), run)).rejects.toThrow(/creation/)
  expect(run).not.toHaveBeenCalled()
  expect(enqueue).toHaveBeenCalledTimes(1)
  expect(closeSession).not.toHaveBeenCalled()
})

it("reconciles the same delayed create and removes it without ever sending a model request", async () => {
  settle.mockResolvedValueOnce({ outcome: "pending" }).mockResolvedValue({ outcome: "applied" })
  await expect(withHostUtilitySession(options(), run)).rejects.toThrow("creation pending")
  expect(run).not.toHaveBeenCalled()
  expect(settle.mock.calls.map(([id]) => id)).toEqual([
    "utility-owned:create",
    "utility-owned:create",
    "utility-owned:delete",
  ])
  expect(enqueue).toHaveBeenCalledTimes(2)
})

it("cleans an admitted session after cancellation without dispatching the model", async () => {
  const controller = new AbortController()
  settle.mockImplementationOnce(async () => {
    controller.abort()
    return { outcome: "applied" }
  })
  await expect(
    withHostUtilitySession({ ...options(), signal: controller.signal }, run)
  ).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
  expect(closeSession).toHaveBeenCalledWith("utility-owned")
  expect(enqueue).toHaveBeenLastCalledWith(
    expect.objectContaining({ action: { kind: "session.delete" } })
  )
})

it("never sends cleanup to a replacement account, target, or device", async () => {
  let current = true
  const assertCurrent = () => {
    if (!current) throw new Error("Host changed")
  }
  settle.mockImplementationOnce(async () => {
    current = false
    return { outcome: "applied" }
  })
  await expect(withHostUtilitySession({ ...options(), assertCurrent }, run)).rejects.toThrow(
    "Host changed"
  )
  expect(run).not.toHaveBeenCalled()
  expect(closeSession).not.toHaveBeenCalled()
  expect(enqueue).toHaveBeenCalledTimes(1)
})

it("reports an unconfirmed delete instead of returning a successful model reply", async () => {
  settle.mockResolvedValueOnce({ outcome: "applied" }).mockResolvedValueOnce({ outcome: "pending" })
  await expect(withHostUtilitySession(options(), run)).rejects.toThrow("cleanup pending")
  expect(run).toHaveBeenCalledTimes(1)
  expect(enqueue).toHaveBeenCalledTimes(2)
})

it("removes its session after a provider failure without retrying the request", async () => {
  run.mockRejectedValueOnce(new Error("provider refused"))
  await expect(withHostUtilitySession(options(), run)).rejects.toThrow("provider refused")
  expect(run).toHaveBeenCalledTimes(1)
  expect(enqueue).toHaveBeenLastCalledWith(
    expect.objectContaining({ action: { kind: "session.delete" } })
  )
})

it("fails closed when the Host does not offer a session admission path", async () => {
  enqueue.mockResolvedValueOnce(null)
  await expect(withHostUtilitySession(options(), run)).rejects.toThrow("admission is unavailable")
  expect(run).not.toHaveBeenCalled()
  expect(closeSession).not.toHaveBeenCalled()
})
