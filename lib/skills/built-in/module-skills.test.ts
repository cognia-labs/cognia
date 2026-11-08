import { loggers } from "@cognia/logging"
import type { ModuleBuiltinSkillsEntry } from "@/lib/modules/manifest-types"
import { z } from "zod"
import {
  __setModuleBuiltInSkillsForTesting,
  builtInSkillAvailabilityGates,
  builtInSkillAvailabilityKey,
  isBuiltInSkillAvailable,
  loadModuleBuiltInSkills,
} from "./module-skills"
import {
  __resetSharedBuiltInSkillRegistry,
  getSharedBuiltInSkillRegistry,
  registerBuiltInSkill,
} from "./registry"
import type { BuiltInSkill, BuiltInSkillAvailability } from "./types"

function skill(id: string, family: string): BuiltInSkill {
  return {
    id,
    family,
    label: { en: id, "zh-CN": id },
    description: { en: id, "zh-CN": id },
    platforms: "any",
    mutation: "read",
    imAccess: "always",
    mcpToolName: id.replace(/\./g, "_"),
    inputSchema: z.object({}),
    execute: async () => ({}),
  }
}

function registering(
  family: string,
  availability?: BuiltInSkillAvailability
): ModuleBuiltinSkillsEntry["load"] {
  return jest.fn(async () => {
    registerBuiltInSkill(skill(`${family}.list`, family))
    return { builtInSkillFamilies: [family], ...(availability ? { availability } : {}) }
  })
}

function entry(
  module: string,
  load: ModuleBuiltinSkillsEntry["load"],
  stage: ModuleBuiltinSkillsEntry["stage"] = "stable"
): ModuleBuiltinSkillsEntry {
  return { module, stage, load }
}

function gate(
  governed: readonly string[],
  settle: BuiltInSkillAvailability["settle"] = async () => "k",
  available = false
): BuiltInSkillAvailability {
  return {
    governs: (id) => governed.includes(id),
    isAvailable: () => available,
    settle: jest.fn(settle),
  }
}

let errorLog: jest.SpyInstance

beforeEach(() => {
  __resetSharedBuiltInSkillRegistry()
  errorLog = jest.spyOn(loggers.app, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  __setModuleBuiltInSkillsForTesting(null)
  errorLog.mockRestore()
})

describe("loadModuleBuiltInSkills", () => {
  it("registers each contributing module's families once, concurrent callers sharing a load", async () => {
    const load = registering("im")
    __setModuleBuiltInSkillsForTesting([entry("connectors", load)])
    await Promise.all([loadModuleBuiltInSkills(), loadModuleBuiltInSkills()])
    await loadModuleBuiltInSkills()
    expect(load).toHaveBeenCalledTimes(1)
    expect(getSharedBuiltInSkillRegistry().get("im.list")).toBeDefined()
  })

  it("awaits a contribution's register before checking its families", async () => {
    __setModuleBuiltInSkillsForTesting([
      entry("connectors", async () => ({
        builtInSkillFamilies: ["lark.doc"],
        register: async () => registerBuiltInSkill(skill("lark.doc.read", "lark.doc")),
      })),
    ])
    await loadModuleBuiltInSkills()
    expect(getSharedBuiltInSkillRegistry().get("lark.doc.read")).toBeDefined()
    expect(errorLog).not.toHaveBeenCalled()
  })

  it("leaves an experimental module out", async () => {
    const load = registering("im")
    __setModuleBuiltInSkillsForTesting([entry("connectors", load, "experimental")])
    await loadModuleBuiltInSkills()
    expect(load).not.toHaveBeenCalled()
  })

  it("logs a declared family the import did not register", async () => {
    __setModuleBuiltInSkillsForTesting([
      entry("connectors", async () => ({ builtInSkillFamilies: ["lark.doc"] })),
    ])
    await loadModuleBuiltInSkills()
    expect(errorLog).toHaveBeenCalledWith(
      "built-in skill families a module declares were not registered",
      { module: "connectors", missing: ["lark.doc"] }
    )
  })

  it("keeps loading the others when one module fails, and retries the failed one", async () => {
    const failing = jest
      .fn<ReturnType<ModuleBuiltinSkillsEntry["load"]>, []>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockImplementation(registering("bot"))
    const load = registering("im")
    __setModuleBuiltInSkillsForTesting([entry("bot", failing), entry("connectors", load)])

    await loadModuleBuiltInSkills()
    expect(getSharedBuiltInSkillRegistry().get("im.list")).toBeDefined()
    expect(getSharedBuiltInSkillRegistry().get("bot.list")).toBeUndefined()
    expect(errorLog).toHaveBeenCalledWith("built-in skill contribution failed to load", {
      module: "bot",
      error: "Error: chunk failed",
    })

    await loadModuleBuiltInSkills()
    expect(failing).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledTimes(1)
    expect(getSharedBuiltInSkillRegistry().get("bot.list")).toBeDefined()
  })
})

describe("availability gates", () => {
  it("drops a skill a loaded gate governs and finds unavailable, and nothing else", async () => {
    expect(isBuiltInSkillAvailable("lark.doc.read")).toBe(true)
    const cli = gate(["lark.doc.read"])
    __setModuleBuiltInSkillsForTesting([entry("connectors", registering("lark.doc", cli))])
    await loadModuleBuiltInSkills()
    expect(builtInSkillAvailabilityGates()).toEqual([cli])
    expect(isBuiltInSkillAvailable("lark.doc.read")).toBe(false)
    expect(isBuiltInSkillAvailable("im.broadcast")).toBe(true)
  })

  it("keys a manifest by what each gate settled for the scope", async () => {
    const cli = gate(["lark.doc.read"], async (scope) =>
      scope.platform && scope.platform !== "lark" ? null : "ready"
    )
    __setModuleBuiltInSkillsForTesting([entry("connectors", registering("lark.doc", cli))])
    await expect(builtInSkillAvailabilityKey({})).resolves.toBe("connectors=ready")
    expect(cli.settle).toHaveBeenCalledWith({})
    await expect(builtInSkillAvailabilityKey({ platform: "telegram" })).resolves.toBe(
      "not-applicable"
    )
  })

  it("keys a gate that cannot settle as failed and logs it", async () => {
    __setModuleBuiltInSkillsForTesting([
      entry(
        "connectors",
        registering(
          "lark.doc",
          gate([], async () => {
            throw new Error("spawn failed")
          })
        )
      ),
    ])
    await expect(builtInSkillAvailabilityKey({})).resolves.toBe("connectors=failed")
    expect(errorLog).toHaveBeenCalledWith("built-in skill availability gate failed to settle", {
      module: "connectors",
      error: "Error: spawn failed",
    })
  })
})
