import type { ModuleToolsEntry } from "./manifest-types"
import {
  bareToolName,
  declaredModuleTools,
  findDeclaredModuleTool,
  moduleToolNamesWhere,
  moduleToolPermissionClasses,
  permissionClassesOf,
} from "./tool-declarations"

const load = async () => ({ toolFamily: { surface: () => null, run: async () => null } })

const entries: ModuleToolsEntry[] = [
  {
    module: "crate",
    stage: "stable",
    declare: {
      crate_list: { consent: "allow", effect: "read" },
      crate_send: { consent: "per-call", effect: "outbound", cancellable: false },
      crate_unlock: { consent: "ask", effect: "write", secrets: true },
    },
    load,
  },
  {
    module: "lab",
    stage: "experimental",
    declare: { lab_probe: { consent: "allow", effect: "write", precedence: "fallback" } },
    load,
  },
]

describe("tool declarations", () => {
  it("lists every declared tool in registry and declaration order, whatever the stage", () => {
    expect(declaredModuleTools(entries).map((t) => `${t.module}/${t.name}`)).toEqual([
      "crate/crate_list",
      "crate/crate_send",
      "crate/crate_unlock",
      "lab/lab_probe",
    ])
  })

  it("finds a tool by its bare or prefixed name", () => {
    expect(bareToolName("mcp__cognia-plugin-tools__crate_send")).toBe("crate_send")
    expect(bareToolName("crate_send")).toBe("crate_send")
    expect(findDeclaredModuleTool("mcp__cognia-plugin-tools__crate_send", entries)).toMatchObject({
      name: "crate_send",
      module: "crate",
    })
    expect(findDeclaredModuleTool("lab_probe", entries)?.module).toBe("lab")
    expect(findDeclaredModuleTool("nope", entries)).toBeUndefined()
  })

  it("derives the name lists policy reads", () => {
    expect(moduleToolNamesWhere((d) => d.effect === "outbound", entries)).toEqual(["crate_send"])
    expect(moduleToolNamesWhere((d) => d.effect !== "read", entries)).toEqual([
      "crate_send",
      "crate_unlock",
      "lab_probe",
    ])
    expect(moduleToolNamesWhere((d) => d.cancellable === false, entries)).toEqual(["crate_send"])
  })

  it("puts a tool in the permission classes its effect and secrets name", () => {
    expect(permissionClassesOf({ consent: "allow", effect: "read" })).toEqual([])
    expect(moduleToolPermissionClasses("crate_send", entries)).toEqual(["outbound"])
    expect(moduleToolPermissionClasses("mcp__cognia-plugin-tools__crate_unlock", entries)).toEqual([
      "secrets",
    ])
    expect(moduleToolPermissionClasses("unknown_tool", entries)).toEqual([])
  })
})
