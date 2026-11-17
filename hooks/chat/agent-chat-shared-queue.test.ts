/** @jest-environment jsdom */
import { installSharedQueueDrain } from "./agent-chat-shared-queue"

let target: unknown = null
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => target }))
const client = {
  baseUrl: "https://collab",
  enqueueSessionRunInput: jest.fn(async (..._args: unknown[]) => undefined),
  listSessionRunQueue: jest.fn(async (..._args: unknown[]) => [
    { id: "q1", payload: { messageId: "m1", contextSequence: 7 } },
  ]),
}
jest.mock("@/lib/collab/runtime-client", () => ({
  resolveCurrentCollabContext: async () => ({ orgId: "o1", client }),
}))
jest.mock("@/lib/collab/shared-chat-sync", () => ({
  syncSharedSession: async () => ({ cursor: 4 }),
}))
const rows = [{ id: "m1", role: "user", metadata: {} }]
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ messages: { where: () => ({ equals: () => ({ toArray: async () => rows }) }) } }),
}))
let mayDrain = true
jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  canAutomaticallyDrainSharedQueue: async () => mayDrain,
  sharedRequestTranscript: async () => "transcript",
}))
jest.mock("@/lib/runtime/standalone-mode", () => ({ isStandaloneChatMode: () => true }))
jest.mock("@/lib/ai/agent/execution/sidecar-client", () => ({ closeSession: jest.fn() }))
jest.mock("@/lib/device/device-identity", () => ({ getDeviceId: async () => "dev-1" }))
jest.mock("@/lib/collab/shared-room-settings", () => ({
  isRoomAsleepRefusal: (error: unknown) => (error as Error)?.message === "asleep",
}))
const info = jest.fn()
jest.mock("sonner", () => ({ toast: { info: (m: string) => info(m) } }))
let storeListener: ((state: { sessions: Record<string, { status: string }> }) => void) | null = null
const chat = {
  sessions: {} as Record<string, { status: string }>,
  setSessionDiagnostic: jest.fn(),
}
jest.mock("@/stores/chat", () => ({
  useChatStore: {
    getState: () => chat,
    subscribe: (fn: typeof storeListener) => {
      storeListener = fn
      return () => {
        storeListener = null
      }
    },
  },
}))

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
const pulse = (type: string, detail: Record<string, unknown>) =>
  window.dispatchEvent(new CustomEvent(type, { detail }))

function install() {
  const send = jest.fn(async () => undefined)
  const teardown = installSharedQueueDrain({
    sendRef: { current: send as never },
    tCollabRef: { current: ((key: string) => key) as never },
  })
  return { send, teardown }
}

let active: (() => void) | null = null
beforeEach(() => {
  jest.clearAllMocks()
  target = { id: "s1", collaboration: { orgId: "o1", sessionId: "rs1", syncCursor: 3 } }
  chat.sessions = {}
  mayDrain = true
})
afterEach(() => active?.())

it("enqueues a requested message and runs the next queued request with the room transcript", async () => {
  const { send, teardown } = install()
  active = teardown
  pulse("cognia:shared-request-ai", { sessionId: "s1", messageId: "m1" })
  await flush()

  expect(client.enqueueSessionRunInput).toHaveBeenCalledWith(
    "o1",
    "rs1",
    expect.objectContaining({ payload: { messageId: "m1" } })
  )
  expect(send).toHaveBeenCalledWith("transcript", undefined, {
    sessionId: "s1",
    skipUserAppend: true,
    sharedRequest: { messageId: "m1", queueItemId: "q1", takeover: undefined },
  })
})

it("ignores a conversation that is not shared", async () => {
  target = { id: "s1" }
  const { send, teardown } = install()
  active = teardown
  pulse("cognia:shared-queue-updated", { sessionId: "s1" })
  await flush()
  expect(send).not.toHaveBeenCalled()
})

it("leaves an automatic pulse to another device when this one may not drain", async () => {
  mayDrain = false
  const { send, teardown } = install()
  active = teardown
  pulse("cognia:shared-queue-updated", { sessionId: "s1" })
  await flush()
  expect(send).not.toHaveBeenCalled()
})

it("waits for a busy conversation to go idle before draining", async () => {
  chat.sessions = { s1: { status: "streaming" } }
  const { send, teardown } = install()
  active = teardown
  pulse("cognia:shared-run-completed", { sessionId: "s1" })
  await flush()
  expect(send).not.toHaveBeenCalled()

  chat.sessions = { s1: { status: "idle" } }
  storeListener?.({ sessions: chat.sessions })
  await flush()
  expect(send).toHaveBeenCalled()
})

it("says so when the room is asleep, reports other failures, and stops on teardown", async () => {
  client.listSessionRunQueue.mockRejectedValueOnce(new Error("asleep"))
  const { send, teardown } = install()
  pulse("cognia:shared-run-completed", { sessionId: "s1" })
  await flush()
  expect(info).toHaveBeenCalledWith("roomAsleepRefused")

  client.listSessionRunQueue.mockRejectedValueOnce(new Error("offline"))
  pulse("cognia:shared-run-completed", { sessionId: "s1" })
  await flush()
  expect(chat.setSessionDiagnostic).toHaveBeenCalledWith("s1", expect.anything())

  teardown()
  active = null
  pulse("cognia:shared-run-completed", { sessionId: "s1" })
  await flush()
  expect(send).not.toHaveBeenCalled()
  expect(storeListener).toBeNull()
})
