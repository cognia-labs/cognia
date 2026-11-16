/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { recordedRunMetadata, startToolExecutionRun } from "./acting-authority"
import {
  applyRunAuthorityToSendOptions,
  enforceRunAuthorityOnSendOptions,
  persistRunAuthority,
  resolveRunAuthority,
  authorityForSendOptions,
  setRunAuthorityMcpServerIds,
} from "./run-authority"
import type { SendOptions } from "@cognia/agent-config-types"
import type { ExecutionRun, RunAuthorityV1 } from "@/types/execution/run"

const narrow: RunAuthorityV1 = {
  schemaVersion: 1,
  caps: "explicit-v1",
  permissionMode: "plan",
  tools: { allow: ["Read"], deny: ["Bash"] },
  mcpServers: { only: ["safe"] },
  skills: { only: ["read"] },
  subagents: { only: ["reader"] },
  maxTurns: 2,
  permissionProfile: { workspace: "deny", outbound: "deny" },
}
const wider: RunAuthorityV1 = {
  schemaVersion: 1,
  caps: "explicit-v1",
  permissionMode: "bypassPermissions",
  tools: { allow: ["Read", "Bash"], deny: [] },
  mcpServers: { only: ["safe", "unsafe"] },
  skills: { only: ["read", "write"] },
  subagents: { only: ["reader", "writer"] },
  maxTurns: 20,
  permissionProfile: { workspace: "sandbox", outbound: "ask" },
}
function row(id: string, overrides: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id,
    kind: "agent-turn",
    sourceId: id,
    title: id,
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
    ...recordedRunMetadata("local", { runId: id }),
    ...overrides,
  }
}
beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await getDb().mcpServers.bulkPut(
    ["safe", "unsafe"].map((id) => ({
      id,
      name: id,
      transport: "stdio" as const,
      config: { command: id },
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    }))
  )
})

it("keeps only Host-built MCP identities across late option-map replacement", async () => {
  await getDb().executionRuns.add(
    row("parent", {
      authority: { schemaVersion: 1, caps: "explicit-v1", mcpServers: { only: ["A"] } },
    })
  )
  const child = await startToolExecutionRun(undefined, { parentRunId: "parent" })
  const options: SendOptions = { mcpServers: { A: { command: "A" }, B: { command: "B" } } }
  setRunAuthorityMcpServerIds(options, [
    { name: "A", id: "A" },
    { name: "B", id: "B" },
  ])
  options.runAuthorityMcpServerIds = { B: "A" }
  await enforceRunAuthorityOnSendOptions(child.id, options)
  expect(options.runAuthorityMcpServerIds).toEqual({ A: "A", B: "B" })
  expect(Object.keys(options.mcpServers!)).toEqual(["A"])
})

it("refuses a failed Host MCP registry read instead of trusting an adopted map", async () => {
  await getDb().executionRuns.add(row("parent", { authority: narrow }))
  const child = await startToolExecutionRun(undefined, { parentRunId: "parent" })
  const read = jest
    .spyOn(getDb().mcpServers, "toArray")
    .mockRejectedValueOnce(new Error("unavailable"))
  try {
    await expect(
      enforceRunAuthorityOnSendOptions(child.id, { runAuthorityMcpServerIds: { unsafe: "safe" } })
    ).rejects.toMatchObject({ reason: "authority_unavailable" })
  } finally {
    read.mockRestore()
  }
})
it("matches bare and qualified subagent caps without admitting another plugin's qualified id", () => {
  for (const only of [["reviewer"], ["p:reviewer"]]) {
    const options: SendOptions = {
      agents: {
        "p:reviewer": { description: "review", prompt: "review" },
        "q:reviewer": { description: "review", prompt: "review" },
        "p:writer": { description: "write", prompt: "write" },
      },
    }
    applyRunAuthorityToSendOptions(options, { schemaVersion: 1, subagents: { only } })
    expect(Object.keys(options.agents!)).toEqual(
      only[0] === "reviewer" ? ["p:reviewer", "q:reviewer"] : ["p:reviewer"]
    )
  }
})
it("meets every dimension and persists the exact effective authority before dispatch", async () => {
  const parent = row("parent", { authority: narrow })
  await getDb().executionRuns.add(parent)
  await getDb().executionRuns.add(
    row("child", {
      parentRunId: parent.id,
      ...recordedRunMetadata("child", { parent }),
    })
  )
  const resolved = await persistRunAuthority("child", wider)
  expect(resolved.authority).toEqual(narrow)
  expect((await getDb().executionRuns.get("child"))?.authority).toEqual(resolved.authority)
  expect((await getDb().executionRuns.get("child"))?.updatedAt).toBe(1)
})
it("retains a child's own narrowing when the parent has no authority", async () => {
  await getDb().executionRuns.add(row("parent"))
  expect(
    (await resolveRunAuthority({ parentRunId: "parent", requested: wider })).authority
  ).toEqual(wider)
})
it("reads the live identity revision and uses the direct parent's recorded cap", async () => {
  const root = row("root", { authority: narrow })
  root.actingIdentity!.authorityRevision = 7
  await getDb().executionRuns.add(root)
  await getDb().executionRuns.add(
    row("parent", {
      actingIdentity: { ...root.actingIdentity!, authorityRevision: 0 },
      authority: wider,
    })
  )
  const resolved = await resolveRunAuthority({ parentRunId: "parent", requested: wider })
  expect(resolved.actingIdentity?.authorityRevision).toBe(7)
  expect(resolved.authority?.maxTurns).toBe(20)
})
it("keeps a parent's effective caps when its grandparent and identity root were deleted", async () => {
  const grandparent = row("deleted-root", { authority: narrow })
  const parent = row("retained-parent", {
    parentRunId: grandparent.id,
    ...recordedRunMetadata("child", { parent: grandparent }),
    authority: narrow,
  })
  await getDb().executionRuns.add(parent)
  const child = row("restart-child", {
    parentRunId: parent.id,
    ...recordedRunMetadata("child", { parent }),
  })
  await getDb().executionRuns.add(child)
  const options: SendOptions = { maxTurns: 40, allowedTools: ["Read", "Bash"] }
  await enforceRunAuthorityOnSendOptions(child.id, options)
  expect(options.maxTurns).toBe(2)
  expect(options.allowedTools).toEqual(["Read"])
  const resolved = await resolveRunAuthority({ runId: child.id })
  expect(resolved.actingIdentity).toEqual(parent.actingIdentity)
  expect(resolved.inheritedAuthority).toEqual(narrow)
  const { listExecutionRunEvents } = await import("@/lib/db/execution-runs")
  expect(JSON.stringify(await listExecutionRunEvents(child.id))).toContain("ancestor_unavailable")
  await expect(
    resolveRunAuthority({ parentRunId: child.id, requested: wider })
  ).resolves.toMatchObject({ authority: narrow })
})
it("refuses missing parents, cycles, and a requested lane switch", async () => {
  await expect(resolveRunAuthority({ parentRunId: "missing" })).rejects.toMatchObject({
    reason: "parent_not_found",
  })
  const parent = row("parent")
  await getDb().executionRuns.add(parent)
  await expect(
    resolveRunAuthority({
      parentRunId: "parent",
      actingIdentity: {
        ...parent.actingIdentity!,
        lane: "service",
      },
    })
  ).rejects.toMatchObject({ reason: "identity_mismatch" })
  await getDb().executionRuns.update("parent", { parentRunId: "parent" })
  await expect(resolveRunAuthority({ parentRunId: "parent" })).rejects.toMatchObject({
    reason: "authority_unavailable",
  })
})
it.each([false, true])("inherits only marked 3A caps (marked=%s)", async (marked) => {
  const { caps: _caps, ...phaseOne } = narrow
  const parent = row("pre-upgrade", { authority: marked ? narrow : phaseOne })
  await getDb().executionRuns.add(parent)
  await Promise.all([
    resolveRunAuthority({ parentRunId: parent.id }),
    resolveRunAuthority({ parentRunId: parent.id }),
  ])
  const child = await startToolExecutionRun("legacy-session", { parentRunId: parent.id })
  const options: SendOptions = {
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Bash"],
    maxTurns: 40,
    mcpServers: { safe: { command: "safe" }, unsafe: { command: "unsafe" } },
    runAuthorityMcpServerIds: { safe: "safe", unsafe: "unsafe" },
  }
  await enforceRunAuthorityOnSendOptions(child.id, options)
  await resolveRunAuthority({ runId: child.id })
  expect(options.permissionMode).toBe(marked ? "plan" : "bypassPermissions")
  expect(options.allowedTools).toEqual(marked ? ["Read"] : ["Read", "Bash"])
  expect(options.maxTurns).toBe(marked ? 2 : 40)
  expect(Object.keys(options.mcpServers!)).toEqual(marked ? ["safe"] : ["safe", "unsafe"])
  expect(options.runAuthority?.caps).toBe("explicit-v1")
  const observations = await getDb().executionRunEvents.where("runId").equals(parent.id).toArray()
  expect(
    observations.filter((event) => event.payload.operation === "legacy_authority_observed")
  ).toHaveLength(marked ? 0 : 1)
})

it("rebuilds and restarts an existing run after its direct parent was pruned", async () => {
  const parent = row("parent", { authority: narrow })
  await getDb().executionRuns.add(parent)
  const child = await startToolExecutionRun("session", {
    runId: "retained",
    parentRunId: parent.id,
  })
  await getDb().executionRuns.delete(parent.id)
  expect(
    await startToolExecutionRun("session", { runId: child.id, parentRunId: parent.id })
  ).toEqual(child)
  const options: SendOptions = { permissionMode: "bypassPermissions", maxTurns: 40 }
  await enforceRunAuthorityOnSendOptions(child.id, options)
  expect(options.permissionMode).toBe("plan")
  expect(options.maxTurns).toBe(2)
  expect((await getDb().executionRuns.get(child.id))?.authority).toEqual(narrow)
  await expect(resolveRunAuthority({ parentRunId: parent.id })).rejects.toMatchObject({
    reason: "parent_not_found",
  })
})
it("refuses authority read and persistence failures", async () => {
  const parent = row("parent", { authority: narrow })
  await getDb().executionRuns.add(parent)
  const fail = () => {
    throw new Error("unavailable")
  }
  getDb().executionRuns.hook("updating", fail)
  try {
    await expect(persistRunAuthority("parent", { ...wider, maxTurns: 1 })).rejects.toMatchObject({
      reason: "authority_persistence_failed",
    })
  } finally {
    getDb().executionRuns.hook("updating").unsubscribe(fail)
  }
  const spy = jest.spyOn(getDb().executionRuns, "get").mockRejectedValueOnce(new Error("read"))
  await expect(resolveRunAuthority({ parentRunId: "parent" })).rejects.toMatchObject({
    reason: "authority_unavailable",
  })
  spy.mockRestore()
})

it("applies every bound to options and SDK-native subagents after late widening", async () => {
  const parent = row("parent", { authority: narrow })
  await getDb().executionRuns.add(parent)
  await getDb().executionRuns.add(
    row("child", {
      parentRunId: parent.id,
      ...recordedRunMetadata("child", { parent }),
    })
  )
  const options: SendOptions = {
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Bash"],
    maxTurns: 40,
    mcpServers: { safe: { command: "safe" }, unsafe: { command: "unsafe" } },
    runAuthorityMcpServerIds: { safe: "safe", unsafe: "unsafe" },
    agents: {
      reader: {
        description: "read",
        prompt: "read",
        tools: ["Read", "Bash"],
        skills: ["read", "write"],
        permissionMode: "bypassPermissions",
        maxTurns: 40,
        mcpServers: ["safe", "unsafe", { safe: { command: "override" } }],
      },
      writer: { description: "write", prompt: "write" },
    },
  }
  await enforceRunAuthorityOnSendOptions("child", options, ["read"])
  expect(options).toMatchObject({
    permissionMode: "plan",
    allowedTools: ["Read"],
    disallowedTools: ["Bash"],
    maxTurns: 2,
    permissionProfile: { outbound: "deny", workspace: "deny" },
    strictMcpConfig: true,
    settingSources: [],
  })
  expect(Object.keys(options.mcpServers!)).toEqual(["safe"])
  expect(Object.keys(options.agents!)).toEqual(["reader"])
  expect(options.agents!.reader).toMatchObject({
    tools: ["Read"],
    skills: ["read"],
    mcpServers: ["safe"],
    permissionMode: "plan",
    maxTurns: 2,
  })
  expect((await getDb().executionRuns.get("child"))?.authority).toEqual(options.runAuthority)
})

it("keeps an empty allowlist deny-all on both model rails", () => {
  const options: SendOptions = { allowedTools: ["Bash"], permissionMode: "bypassPermissions" }
  applyRunAuthorityToSendOptions(options, { schemaVersion: 1, tools: { allow: [] } })
  expect(options.allowedTools).toEqual([])
  expect(options.toolSurface).toBe("none")
})

it("separates an ancestor ceiling from the launching run's own options", async () => {
  await getDb().executionRuns.add(row("root", { authority: wider }))
  const root = await resolveRunAuthority({ runId: "root" })
  expect(root.authority).toEqual(wider)
  expect(root.inheritedAuthority).toBeUndefined()
  await getDb().executionRuns.add(
    row("child", {
      parentRunId: "root",
      ...recordedRunMetadata("child", { parent: (await getDb().executionRuns.get("root"))! }),
      authority: narrow,
    })
  )
  const child = await resolveRunAuthority({ runId: "child" })
  expect(child.inheritedAuthority).toEqual(wider)
  expect(child.authority?.maxTurns).toBe(2)
})

it("refuses late skill tightening before already-composed instructions can be sent", async () => {
  const parent = row("parent", { authority: { ...narrow, skills: { only: ["read", "write"] } } })
  await getDb().executionRuns.add(parent)
  await getDb().executionRuns.add(
    row("child", { parentRunId: parent.id, ...recordedRunMetadata("child", { parent }) })
  )
  const options: SendOptions = { systemPrompt: "Already composed write skill" }
  await getDb().executionRuns.update(parent.id, { authority: narrow })
  await expect(enforceRunAuthorityOnSendOptions("child", options, ["write"])).rejects.toMatchObject(
    {
      reason: "unsupported_authority",
      message: expect.stringContaining("skills.only changed during preparation"),
    }
  )
})

it("records no derived discovery caps and preserves unrestricted native content", async () => {
  await getDb().executionRuns.add(row("plain", { status: "queued" }))
  const options: SendOptions = {
    allowedTools: ["Read"],
    mcpServers: { available: { command: "mcp" } },
    settingSources: ["project"],
    runtimeExtensions: [{ kind: "directory", path: "/native" }],
    claudeAgentSdk: { version: 1, skills: "all" },
  }
  await enforceRunAuthorityOnSendOptions("plain", options, ["derived"])
  expect(authorityForSendOptions(options)).toEqual({ schemaVersion: 1, caps: "explicit-v1" })
  expect(options.settingSources).toEqual(["project"])
  expect(options.runtimeExtensions).toHaveLength(1)
  expect(options.claudeAgentSdk).toMatchObject({ skills: "all" })
  expect((await getDb().executionRuns.get("plain"))?.authority).toEqual({
    schemaVersion: 1,
    caps: "explicit-v1",
  })
})

it("rebuilds a queued run from fresh caps instead of its previous preparation", async () => {
  await getDb().executionRuns.add(row("retry", { status: "queued", authority: narrow }))
  const options: SendOptions = { runAuthority: wider, allowedTools: ["Read", "Bash"] }
  await enforceRunAuthorityOnSendOptions("retry", options, ["write"])
  expect(options.runAuthority).toEqual(wider)
  expect((await getDb().executionRuns.get("retry"))?.authority).toEqual(wider)
})

it("uses the child's runtime default below a bypass parent", () => {
  const options: SendOptions = {}
  applyRunAuthorityToSendOptions(options, { schemaVersion: 1, permissionMode: "bypassPermissions" })
  expect(options.permissionMode).toBe("default")
})

it.each([false, true])(
  "reseals late tool additions against ancestors only (restricted=%s)",
  async (restricted) => {
    const parent = row("parent", {
      authority: restricted
        ? { schemaVersion: 1, caps: "explicit-v1", tools: { allow: ["A", "B"] } }
        : undefined,
    })
    await getDb().executionRuns.add(parent)
    await getDb().executionRuns.add(
      row("late", {
        status: "queued",
        parentRunId: parent.id,
        ...recordedRunMetadata("child", { parent }),
      })
    )
    const options: SendOptions = {
      allowedTools: ["A", "B"],
      runAuthority: { schemaVersion: 1, tools: { allow: ["A", "B"] } },
    }
    await enforceRunAuthorityOnSendOptions("late", options)
    options.allowedTools!.push("C")
    options.runAuthority = { schemaVersion: 1, tools: { allow: [...options.allowedTools!] } }
    await enforceRunAuthorityOnSendOptions("late", options)
    expect(options.allowedTools).toEqual(restricted ? ["A", "B"] : ["A", "B", "C"])
    expect((await getDb().executionRuns.get("late"))?.authority).toEqual(options.runAuthority)
  }
)

it("only a skills cap filters native extensions and retains named content", () => {
  const options: SendOptions = {
    trustedWorkspaceRoots: ["/keep"],
    runtimeExtensions: [
      { kind: "directory", path: "/keep", id: "plugin-keep" },
      { kind: "directory", path: "/drop" },
    ],
    claudeAgentSdk: {
      version: 1,
      skills: "all",
    },
  }
  applyRunAuthorityToSendOptions(options, {
    schemaVersion: 1,
    skills: { only: ["read", "plugin-keep"] },
  })
  expect(options.claudeAgentSdk?.skills).toEqual(["read", "plugin-keep"])
  expect(options.runtimeExtensions).toEqual([
    { kind: "directory", path: "/keep", id: "plugin-keep" },
  ])
})

it("preserves a confirmed replay's own identity root when persisting authority", async () => {
  const parent = row("parent", { authority: narrow, sessionId: "replay-session" })
  await getDb().executionRuns.add(parent)
  const replay = await startToolExecutionRun("replay-session", {
    confirmedSkill: {
      originRunId: parent.id,
      requester: { kind: "local-person" },
      rootSessionId: "replay-session",
    },
  })
  expect(replay.actingIdentity?.rootRunId).toBe(replay.id)
  expect(replay.parentRunId).toBe(parent.id)
  await persistRunAuthority(replay.id, wider)
  expect((await getDb().executionRuns.get(replay.id))?.actingIdentity).toEqual(
    replay.actingIdentity
  )
  await expect(resolveRunAuthority({ runId: replay.id })).resolves.toMatchObject({
    authority: narrow,
  })
})

it("records own explicit caps without reapplying them to the run's own options", async () => {
  await getDb().executionRuns.add(row("own", { status: "queued" }))
  const options: SendOptions = {
    permissionMode: "bypassPermissions",
    allowedTools: ["Read", "Bash"],
    settingSources: ["project"],
    claudeAgentSdk: { version: 1, skills: "all" },
    runAuthority: {
      schemaVersion: 1,
      permissionMode: "plan",
      tools: { allow: ["Read"] },
      skills: { only: ["read"] },
    },
  }
  await enforceRunAuthorityOnSendOptions("own", options, ["other"])
  expect(options.permissionMode).toBe("bypassPermissions")
  expect(options.allowedTools).toEqual(["Read", "Bash"])
  expect(options.settingSources).toEqual(["project"])
  expect(options.claudeAgentSdk?.skills).toBe("all")
  expect((await getDb().executionRuns.get("own"))?.authority).toEqual(options.runAuthority)
})

it("withholds all native local content under an inherited skill cap without workspace trust", () => {
  const options: SendOptions = {
    cwd: "/untrusted",
    runtimeExtensions: [{ kind: "directory", path: "/untrusted/plugin", id: "keep" }],
    claudeAgentSdk: {
      version: 1,
      skills: "all",
    },
  }
  applyRunAuthorityToSendOptions(options, { schemaVersion: 1, skills: { only: ["keep"] } })
  expect(options.claudeAgentSdk?.skills).toEqual([])
  expect(options.runtimeExtensions).toEqual([])
})

it("creates children of phase-1 identities using the legacy parent as their root", async () => {
  const { createExecutionRun } = await import("@/lib/db/execution-runs")
  const grandparent = row("phase1-grandparent")
  delete grandparent.actingIdentity!.rootRunId
  const parent = row("phase1-parent", { parentRunId: grandparent.id })
  delete parent.actingIdentity!.rootRunId
  await getDb().executionRuns.bulkAdd([grandparent, parent])
  const child = await createExecutionRun(
    row("phase1-child", {
      parentRunId: parent.id,
      ...recordedRunMetadata("child", { runId: "phase1-child", parent }),
    })
  )
  expect(child.actingIdentity?.rootRunId).toBe(parent.id)
  expect((await resolveRunAuthority({ runId: child.id })).actingIdentity?.rootRunId).toBe(parent.id)
})

it("adopts under retained ancestry while journaling an unavailable ancestor", async () => {
  const { adoptExecutionRun, listExecutionRunEvents } = await import("@/lib/db/execution-runs")
  const parent = row("adoption-parent", { parentRunId: "pruned-ancestor" })
  const child = row("adoption-child", { status: "queued", actingIdentity: undefined })
  await getDb().executionRuns.bulkAdd([parent, child])
  await expect(adoptExecutionRun(child.id, parent.id)).resolves.toBe(true)
  expect((await getDb().executionRuns.get(child.id))?.parentRunId).toBe(parent.id)
  expect(JSON.stringify(await listExecutionRunEvents(parent.id))).toContain("ancestor_unavailable")
})
