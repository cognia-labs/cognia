import {
  agentWorkerManifestV1Schema,
  isAgentWorkerManifestV1,
  type AgentWorkerManifestV1,
} from "./worker-manifest"
import * as v from "valibot"

const manifest: AgentWorkerManifestV1 = {
  manifestVersion: 1,
  runtime: "builtin",
  models: ["test"],
  hardCapabilities: ["worker-dispatch-v1"],
  maxActiveTurns: 1,
  credentialProfileRefs: ["credential:test"],
  workspaceBindingRefs: ["repository:project:repo"],
  taskWorkspace: { enabled: true },
  sandbox: { capabilities: ["filesystem"] },
  platform: { os: "linux", arch: "arm64" },
  executionProfile: {
    profileVersion: 1,
    backendId: "builtin",
    runtimeAdapter: "ai-sdk",
    modelBindings: { primary: "test" },
    deploymentRefs: ["provider:test"],
    capabilities: ["streaming"],
  },
}

describe("AgentWorkerManifestV1", () => {
  it("accepts a bounded local fence grace and rejects invalid grace values", () => {
    expect(
      isAgentWorkerManifestV1({
        ...manifest,
        hardCapabilities: ["worker-self-fence-v1", "turn-interrupt-v1"],
        fenceGraceMs: 5000,
      })
    ).toBe(true)
    expect(
      isAgentWorkerManifestV1({ ...manifest, hardCapabilities: ["worker-self-fence-v1"] })
    ).toBe(false)
    expect(
      isAgentWorkerManifestV1({
        ...manifest,
        hardCapabilities: ["worker-self-fence-v1"],
        fenceGraceMs: 5000,
        executionProfile: { ...manifest.executionProfile, runtimeAdapter: "external" },
      })
    ).toBe(false)
    for (const fenceGraceMs of [-1, 1.5, Infinity]) {
      expect(isAgentWorkerManifestV1({ ...manifest, fenceGraceMs })).toBe(false)
    }
  })
  it("uses the exported schema as the single runtime validator", () => {
    expect(isAgentWorkerManifestV1(manifest)).toBe(true)
    expect(v.safeParse(agentWorkerManifestV1Schema, manifest).success).toBe(true)
    expect(isAgentWorkerManifestV1({ ...manifest, maxActiveTurns: 0 })).toBe(false)
    expect(isAgentWorkerManifestV1({ ...manifest, workspaceBindingRefs: [""] })).toBe(false)
  })

  it("accepts legacy manifests for read-only compatibility", () => {
    const { executionProfile: _, ...legacy } = manifest
    expect(isAgentWorkerManifestV1(legacy)).toBe(true)
  })

  it("rejects malformed execution profiles", () => {
    expect(
      isAgentWorkerManifestV1({
        ...manifest,
        executionProfile: { ...manifest.executionProfile, capabilities: [""] },
      })
    ).toBe(false)
  })
})
