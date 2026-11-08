import type { ModuleSyncHandlersEntry } from "@/lib/modules/manifest-types"
import { MODULE_SYNC_HANDLERS } from "@/lib/modules/generated/sync-handlers"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  __setModuleSyncHandlersForTesting,
  hasModuleSyncHandler,
  moduleSyncPull,
  moduleSyncServe,
  serveModuleSyncTable,
} from "./module-handlers"
import type { SyncCursor, SyncDelta, SyncOutcome } from "./types"

const transport = {} as Transport
const cursor: SyncCursor = { since: 0 }
const okOutcome: SyncOutcome = {
  ok: true,
  result: { table: "memories", applied: 1, nextSince: 5 },
}
const delta: SyncDelta<unknown> = { rows: [{ id: "m" }], deleted_ids: [], next_since: 5 }

function entry(overrides: Partial<ModuleSyncHandlersEntry> = {}): ModuleSyncHandlersEntry {
  return {
    module: "memory",
    stage: "stable",
    tables: ["memories"],
    load: async () => ({
      syncHandlers: {
        memories: { pull: async () => okOutcome, serve: async () => delta },
      },
    }),
    ...overrides,
  }
}

afterEach(() => __setModuleSyncHandlersForTesting())

describe("module sync handlers", () => {
  it("runs the owning module's pull, loading its file once", async () => {
    const load = jest.fn(entry().load)
    __setModuleSyncHandlersForTesting([entry({ load })])
    const pull = moduleSyncPull("memories")
    await expect(pull(transport, cursor)).resolves.toEqual(okOutcome)
    await expect(pull(transport, cursor)).resolves.toEqual(okOutcome)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("fails a table nobody owns as not_implemented, naming the table", async () => {
    __setModuleSyncHandlersForTesting([])
    await expect(moduleSyncPull("petProfile")(transport, cursor)).resolves.toEqual({
      ok: false,
      failure: {
        table: "petProfile",
        reason: "not_implemented",
        message: "no module provides the petProfile sync handler",
      },
    })
  })

  it("fails a declared table the module's file does not provide", async () => {
    __setModuleSyncHandlersForTesting([
      entry({ tables: ["memories", "petProfile"], load: entry().load }),
    ])
    const outcome = await moduleSyncPull("petProfile")(transport, cursor)
    expect(outcome.ok).toBe(false)
  })

  it("gives an experimental module no tables", async () => {
    __setModuleSyncHandlersForTesting([entry({ stage: "experimental" })])
    expect(hasModuleSyncHandler("memories")).toBe(false)
    await expect(moduleSyncServe("memories")).resolves.toBeUndefined()
  })

  it("retries a file that failed to load on the next sync", async () => {
    const load = jest
      .fn<ReturnType<ModuleSyncHandlersEntry["load"]>, []>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockImplementation(entry().load)
    __setModuleSyncHandlersForTesting([entry({ load })])
    await expect(moduleSyncPull("memories")(transport, cursor)).rejects.toThrow("chunk failed")
    await expect(moduleSyncPull("memories")(transport, cursor)).resolves.toEqual(okOutcome)
  })

  it("serves a table through the owner's reader, passing the context through", async () => {
    const serve = jest.fn(async () => delta)
    __setModuleSyncHandlersForTesting([
      entry({
        load: async () => ({ syncHandlers: { memories: { pull: async () => okOutcome, serve } } }),
      }),
    ])
    const context = { contentProtocolVersion: 1, deps: { memoryColdStartLimit: 2 } }
    await expect(serveModuleSyncTable("memories", 4, context)).resolves.toBe(delta)
    expect(serve).toHaveBeenCalledWith(4, context)
  })

  it("leaves a table without a contributed reader to the host's generic reader", async () => {
    __setModuleSyncHandlersForTesting([
      entry({
        module: "connectors",
        tables: ["conversationOverrides"],
        load: async () => ({
          syncHandlers: { conversationOverrides: { pull: async () => okOutcome } },
        }),
      }),
    ])
    expect(hasModuleSyncHandler("conversationOverrides")).toBe(true)
    await expect(
      serveModuleSyncTable("conversationOverrides", 0, { deps: {} })
    ).resolves.toBeUndefined()
    await expect(serveModuleSyncTable("sessions", 0, { deps: {} })).resolves.toBeUndefined()
  })

  it("every table a module declares is one the orchestrator pulls through it", async () => {
    const { SYNC_HANDLER_TABLES } = await import("./companion-sync")
    const declared = MODULE_SYNC_HANDLERS.flatMap((owner) => owner.tables)
    expect(declared.length).toBeGreaterThan(0)
    for (const table of declared) expect(SYNC_HANDLER_TABLES).toContain(table)
    for (const owner of MODULE_SYNC_HANDLERS) {
      const { syncHandlers } = await owner.load()
      expect(Object.keys(syncHandlers).sort()).toEqual([...owner.tables].sort())
    }
  })
})
