import {
  migrateTeammateExecutionBinding,
  resolveTeammateExecutionBinding,
} from "./execution-binding-resolver"

describe("resolveTeammateExecutionBinding", () => {
  it("member wins over run/team/app when set", () => {
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "pinned", deploymentRef: "dep-member" },
      runOverride: { mode: "pinned", deploymentRef: "dep-run" },
      teamDefault: { mode: "pinned", deploymentRef: "dep-team" },
      appDefault: { mode: "pinned", deploymentRef: "dep-app" },
    })
    expect(resolved.source).toBe("member")
    expect(resolved.policy).toEqual({ deploymentRef: "dep-member" })
    expect(resolved.executionTarget).toEqual({ mode: "colocate" })
    expect(resolved.trace.managedForced).toBe(false)
  })

  it("inherit falls through the fixed precedence chain member → run → team → app", () => {
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "inherit" },
      runOverride: { mode: "inherit" },
      teamDefault: { mode: "pinned", runtimePolicy: "ai-sdk", modelRole: "fast" },
      appDefault: { mode: "pinned", deploymentRef: "dep-app" },
    })
    expect(resolved.source).toBe("team-default")
    expect(resolved.policy).toEqual({ runtimePolicy: "ai-sdk", modelBindingRef: "fast" })
    expect(resolved.trace.consulted).toEqual(["managed", "member", "run", "team-default"])
  })

  it("managed force-all short-circuits everything and is EXPLICIT in the trace", () => {
    const resolved = resolveTeammateExecutionBinding({
      managedForceAll: { mode: "pinned", deploymentRef: "dep-managed" },
      member: { mode: "pinned", deploymentRef: "dep-member" },
    })
    expect(resolved.source).toBe("managed")
    expect(resolved.policy).toEqual({ deploymentRef: "dep-managed" })
    expect(resolved.trace.managedForced).toBe(true)
  })

  it("pool mode exposes candidate ids ONLY — no policy leaks", () => {
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "pool", candidateIds: ["dep-a", "dep-b"] },
    })
    expect(resolved.source).toBe("member")
    expect(resolved.candidateIds).toEqual(["dep-a", "dep-b"])
    expect(resolved.policy).toEqual({})
  })

  it("a fully-inherited chain resolves to the app default with an empty policy", () => {
    const resolved = resolveTeammateExecutionBinding({})
    expect(resolved.source).toBe("app-default")
    expect(resolved.policy).toEqual({})
    expect(resolved.candidateIds).toBeUndefined()
  })

  it("pinned credential references pass through as refs", () => {
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "pinned", credentialProfileRef: "cred-1" },
    })
    expect(resolved.policy).toEqual({ credentialProfileRef: "cred-1" })
  })

  it("resolves host placement independently from deployment selection", () => {
    const resolved = resolveTeammateExecutionBinding({
      member: {
        mode: "pool",
        candidateIds: ["dep-a"],
        executionTarget: { mode: "pinned", hostRef: "device:worker-a" },
      },
    })
    expect(resolved.policy).toEqual({
      executionTarget: { mode: "pinned", hostRef: "device:worker-a" },
    })
    expect(resolved.candidateIds).toEqual(["dep-a"])
    expect(resolved.executionTarget).toEqual({ mode: "pinned", hostRef: "device:worker-a" })
  })

  it("keeps an explicit host when inheriting the deployment policy", () => {
    const executionTarget = { mode: "pinned", hostRef: "device:member" } as const
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "inherit", executionTarget },
      teamDefault: { mode: "pinned", deploymentRef: "dep-team", executionTarget: { mode: "auto" } },
    })
    expect(resolved.policy).toEqual({ deploymentRef: "dep-team", executionTarget })
    expect(resolved.executionTarget).toEqual(executionTarget)
  })

  it("keeps a host-only binding when every deployment inherits", () => {
    const executionTarget = { mode: "auto" } as const
    const resolved = resolveTeammateExecutionBinding({
      member: { mode: "inherit", executionTarget },
    })
    expect(resolved.policy).toEqual({ executionTarget })
    expect(resolved.executionTarget).toEqual(executionTarget)
  })
})

describe("migrateTeammateExecutionBinding", () => {
  it("keeps an existing execution binding untouched", () => {
    const execution = { mode: "pinned" as const, deploymentRef: "dep-1" }
    expect(migrateTeammateExecutionBinding({ execution })).toBe(execution)
  })

  it("pins a provider-only config onto its provider-id deployment ref", () => {
    expect(migrateTeammateExecutionBinding({ provider: "zhipu" })).toEqual({
      mode: "pinned",
      deploymentRef: "zhipu",
    })
  })

  it("returns undefined when the config names neither a binding nor a provider", () => {
    expect(migrateTeammateExecutionBinding({})).toBeUndefined()
    expect(migrateTeammateExecutionBinding({ model: "m" })).toBeUndefined()
  })
})
