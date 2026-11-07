import { loggers } from "@cognia/logging"
import type { ModuleWorkflowNodesEntry } from "@/lib/modules/manifest-types"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import { __setModuleWorkflowNodesForTesting, loadModuleWorkflowNodes } from "./module-nodes"
import { __resetRegistryForTesting, getExecutor, registerNodeExecutor } from "./registry"

const KIND = "action.site.build" as WorkflowNodeKind
const OTHER = "action.site.publish" as WorkflowNodeKind

function registering(kind: WorkflowNodeKind) {
  return jest.fn(async () => {
    registerNodeExecutor({ kind, typeVersion: 1, execute: async () => ({ output: null }) })
    return { workflowNodeKinds: [kind] }
  })
}

function entry(
  module: string,
  load: ModuleWorkflowNodesEntry["load"],
  stage: ModuleWorkflowNodesEntry["stage"] = "stable"
): ModuleWorkflowNodesEntry {
  return { module, stage, load }
}

let errorLog: jest.SpyInstance

beforeEach(() => {
  __resetRegistryForTesting()
  errorLog = jest.spyOn(loggers.app, "error").mockImplementation(() => undefined)
})

afterEach(() => {
  __setModuleWorkflowNodesForTesting(null)
  errorLog.mockRestore()
})

describe("loadModuleWorkflowNodes", () => {
  it("registers each contributing module's executors once", async () => {
    const load = registering(KIND)
    __setModuleWorkflowNodesForTesting([entry("sites", load)])
    await loadModuleWorkflowNodes()
    await loadModuleWorkflowNodes()
    expect(load).toHaveBeenCalledTimes(1)
    expect(getExecutor(KIND, 1)).toBeDefined()
  })

  it("shares one load between concurrent callers", async () => {
    const load = registering(KIND)
    __setModuleWorkflowNodesForTesting([entry("sites", load)])
    await Promise.all([loadModuleWorkflowNodes(), loadModuleWorkflowNodes()])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("leaves an experimental module out", async () => {
    const load = registering(KIND)
    __setModuleWorkflowNodesForTesting([entry("sites", load, "experimental")])
    await loadModuleWorkflowNodes()
    expect(load).not.toHaveBeenCalled()
    expect(getExecutor(KIND, 1)).toBeUndefined()
  })

  it("logs a declared kind the import did not register", async () => {
    __setModuleWorkflowNodesForTesting([
      entry("sites", async () => ({ workflowNodeKinds: [OTHER] })),
    ])
    await loadModuleWorkflowNodes()
    expect(errorLog).toHaveBeenCalledWith("workflow nodes a module declares were not registered", {
      module: "sites",
      missing: [OTHER],
    })
  })

  it("keeps loading the others when one module fails, and retries the failed one", async () => {
    const failing = jest
      .fn<ReturnType<ModuleWorkflowNodesEntry["load"]>, []>()
      .mockRejectedValueOnce(new Error("chunk failed"))
      .mockImplementation(registering(OTHER))
    const load = registering(KIND)
    __setModuleWorkflowNodesForTesting([entry("goal", failing), entry("sites", load)])

    await loadModuleWorkflowNodes()
    expect(getExecutor(KIND, 1)).toBeDefined()
    expect(getExecutor(OTHER, 1)).toBeUndefined()
    expect(errorLog).toHaveBeenCalledWith("workflow node contribution failed to load", {
      module: "goal",
      error: "Error: chunk failed",
    })

    await loadModuleWorkflowNodes()
    expect(failing).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledTimes(1)
    expect(getExecutor(OTHER, 1)).toBeDefined()
  })
})
