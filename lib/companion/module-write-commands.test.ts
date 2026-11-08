import type { ModuleHostWriteCommandsEntry } from "@/lib/modules/manifest-types"
import {
  __setModuleHostWriteCommandsForTesting,
  isModuleHostWriteCommand,
  moduleHostWriteHandler,
} from "./module-write-commands"

const handler = jest.fn(async () => ({ ok: true }))

function entry(
  overrides: Partial<ModuleHostWriteCommandsEntry> = {}
): ModuleHostWriteCommandsEntry {
  return {
    module: "connectors",
    stage: "stable",
    commands: ["connector_reject_draft"],
    load: async () => ({ hostWriteCommands: { connector_reject_draft: handler } }),
    ...overrides,
  }
}

afterEach(() => __setModuleHostWriteCommandsForTesting())

describe("module host write commands", () => {
  it("knows a module's commands before loading its file, and loads it once", async () => {
    const load = jest.fn(entry().load)
    __setModuleHostWriteCommandsForTesting([entry({ load })])
    expect(isModuleHostWriteCommand("connector_reject_draft")).toBe(true)
    expect(load).not.toHaveBeenCalled()
    await expect(moduleHostWriteHandler("connector_reject_draft")).resolves.toBe(handler)
    await expect(moduleHostWriteHandler("connector_reject_draft")).resolves.toBe(handler)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("leaves a command no module answers to the dispatcher's own arms", async () => {
    __setModuleHostWriteCommandsForTesting([entry()])
    expect(isModuleHostWriteCommand("character_upsert")).toBe(false)
    await expect(moduleHostWriteHandler("character_upsert")).resolves.toBeUndefined()
  })

  it("names a command the module declares but its file does not provide", async () => {
    __setModuleHostWriteCommandsForTesting([
      entry({ commands: ["connector_reject_draft", "connector_approve_draft"] }),
    ])
    await expect(moduleHostWriteHandler("connector_approve_draft")).rejects.toThrow(
      "desktop-write command connector_approve_draft is declared by connectors but not provided"
    )
  })

  it("gives an experimental module no commands", async () => {
    __setModuleHostWriteCommandsForTesting([entry({ stage: "experimental" })])
    await expect(moduleHostWriteHandler("connector_reject_draft")).resolves.toBeUndefined()
  })

  it("retries a file that failed to load", async () => {
    const load = jest
      .fn<ReturnType<ModuleHostWriteCommandsEntry["load"]>, []>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockImplementation(entry().load)
    __setModuleHostWriteCommandsForTesting([entry({ load })])
    await expect(moduleHostWriteHandler("connector_reject_draft")).rejects.toThrow("chunk failed")
    await expect(moduleHostWriteHandler("connector_reject_draft")).resolves.toBe(handler)
  })
})
