jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@tauri-apps/api/event", () => ({ listen: jest.fn() }))

import {
  __resetWasmLogBufferForTesting,
  getWasmLogs,
  WASM_LOG_DRAIN_FAILURE_KIND,
  WASM_LOG_EVENT,
  WASM_LOGS_COMMAND,
  type WasmLogRecord,
} from "./log-buffer"
import { __resetWasmLogSourceForTesting, drainWasmLogs, installWasmLogSource } from "./log-source"

function record(overrides: Partial<WasmLogRecord> = {}): WasmLogRecord {
  return {
    pluginId: "calc",
    generation: "host-1",
    sequence: 1,
    level: "info",
    scope: "",
    message: "hello",
    timestampMs: 1_000,
    ...overrides,
  }
}

function fakeBridge(drains: Array<unknown | Error> = []) {
  let handler: ((event: { payload: unknown }) => void) | null = null
  const unlisten = jest.fn()
  const invoke = jest.fn(async (_name: string, _args: Record<string, unknown>) => {
    const next = drains.shift()
    if (next instanceof Error) throw next
    return next ?? { generation: null, entries: [] }
  })
  const bridge = {
    listen: jest.fn(async (event: string, h: (e: { payload: unknown }) => void) => {
      expect(event).toBe(WASM_LOG_EVENT)
      handler = h
      return unlisten
    }),
    invoke: invoke as unknown as <T>(name: string, args: Record<string, unknown>) => Promise<T>,
  }
  return {
    bridge,
    invoke,
    unlisten,
    emit: (payload: unknown) => handler?.({ payload }),
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

beforeEach(() => {
  __resetWasmLogBufferForTesting()
  __resetWasmLogSourceForTesting()
})

it("keeps each pushed line", async () => {
  const { bridge, emit, invoke } = fakeBridge()
  await installWasmLogSource({ bridge, forceReinstall: true })
  emit(record())
  emit(record({ sequence: 2, message: "again" }))
  expect(getWasmLogs("calc").map((e) => e.message)).toEqual(["hello", "again"])
  // Contiguous lines need no drain.
  expect(invoke).not.toHaveBeenCalled()
})

it("ignores a malformed event", async () => {
  const { bridge, emit } = fakeBridge()
  await installWasmLogSource({ bridge, forceReinstall: true })
  emit({ pluginId: "calc" })
  expect(getWasmLogs("calc")).toEqual([])
})

it("drains from the cursor when a line arrives ahead of a missing one", async () => {
  const { bridge, emit, invoke } = fakeBridge([
    {
      generation: "host-1",
      entries: [record({ sequence: 2, timestampMs: 1_500, message: "lost" })],
    },
  ])
  await installWasmLogSource({ bridge, forceReinstall: true })
  emit(record())
  emit(record({ sequence: 3, timestampMs: 2_000, message: "third" }))
  await flush()
  expect(invoke).toHaveBeenCalledWith(WASM_LOGS_COMMAND, {
    pluginId: "calc",
    generation: "host-1",
    afterSequence: 1,
  })
  expect(getWasmLogs("calc").map((e) => e.message)).toEqual(["hello", "lost", "third"])
})

it("drains from the start for a plugin nothing was heard from", async () => {
  const { bridge, invoke } = fakeBridge([
    { generation: "host-1", entries: [record({ message: "from init" })] },
  ])
  await installWasmLogSource({ bridge, forceReinstall: true })
  await drainWasmLogs("calc")
  expect(invoke).toHaveBeenCalledWith(WASM_LOGS_COMMAND, {
    pluginId: "calc",
    generation: null,
    afterSequence: null,
  })
  expect(getWasmLogs("calc").map((e) => e.message)).toEqual(["from init"])
})

it("runs one drain at a time per plugin, and once more for a request made during it", async () => {
  const { bridge, invoke } = fakeBridge()
  await installWasmLogSource({ bridge, forceReinstall: true })
  const first = drainWasmLogs("calc")
  const second = drainWasmLogs("calc")
  const third = drainWasmLogs("calc")
  await Promise.all([first, second, third])
  expect(invoke).toHaveBeenCalledTimes(2)
})

it("records a failed drain as an entry instead of throwing", async () => {
  const { bridge } = fakeBridge([new Error("command plugin_wasm_logs not found")])
  await installWasmLogSource({ bridge, forceReinstall: true })
  await expect(drainWasmLogs("calc")).resolves.toBeUndefined()
  expect(getWasmLogs("calc")).toEqual([
    expect.objectContaining({
      kind: WASM_LOG_DRAIN_FAILURE_KIND,
      level: "error",
      message: "command plugin_wasm_logs not found",
    }),
  ])
})

it("does nothing before it is installed, or after it is released", async () => {
  await expect(drainWasmLogs("calc")).resolves.toBeUndefined()
  const { bridge, invoke, unlisten } = fakeBridge()
  const release = await installWasmLogSource({ bridge, forceReinstall: true })
  release()
  expect(unlisten).toHaveBeenCalled()
  await drainWasmLogs("calc")
  expect(invoke).not.toHaveBeenCalled()
})
