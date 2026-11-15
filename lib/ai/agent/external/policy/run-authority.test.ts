/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { recordedRunMetadata } from "@/lib/execution/acting-authority"
import { enforceExternalRunAuthority, bindExternalRunAuthority } from "./run-authority"
import { externalAuthorityStepGuard, externalAuthorityOptions } from "./run-authority"

it.each(["pi-rpc", "opencode", "opencode-v2"] as const)(
  "%s refuses an unrepresentable native argument deny rather than disabling all Bash",
  (protocol) => {
    expect(() =>
      externalAuthorityOptions(
        { schemaVersion: 1, tools: { deny: ["Bash(rm:*)"] } },
        {},
        { protocol }
      )
    ).toThrow("tools.deny: Bash(rm:*)")
    try {
      externalAuthorityOptions(
        { schemaVersion: 1, tools: { deny: ["Bash(rm:*)"] } },
        {},
        { protocol }
      )
    } catch (error) {
      expect(error).toMatchObject({ reason: "unsupported_authority" })
    }
  }
)

it("carries the inherited mode into the existing engine permission translator", () => {
  expect(
    externalAuthorityOptions(
      { schemaVersion: 1, permissionMode: "plan" },
      { permissionMode: "bypassPermissions" },
      { protocol: "acp" }
    )
  ).toMatchObject({ permissionMode: "plan", permissionCeiling: { permissionMode: "plan" } })
})
it.each([
  { maxTurns: 2 },
  { permissionProfile: { outbound: "deny" as const } },
  { tools: { allow: [] } },
  { tools: { deny: ["Bash"] } },
  { mcpServers: { only: [] } },
  { skills: { only: [] } },
  { subagents: { only: [] } },
])("names the engine and the untranslatable inherited field: %j", (field) => {
  expect(() =>
    externalAuthorityOptions({ schemaVersion: 1, ...field }, {}, { protocol: "http" })
  ).toThrow("unsupported_authority: http:")
})
it("rounds auto toward the nearest non-auto mode", () => {
  expect(
    externalAuthorityOptions(
      { schemaVersion: 1, permissionMode: "auto" },
      { permissionMode: "bypassPermissions" },
      { protocol: "acp" }
    ).permissionMode
  ).toBe("acceptEdits")
})

it("does not pin a child with no mode to an ancestor's bypass mode", () => {
  expect(
    externalAuthorityOptions(
      { schemaVersion: 1, permissionMode: "bypassPermissions" },
      {},
      { protocol: "acp" }
    ).permissionMode
  ).toBe("default")
})
it("withholds a projected-only deny without refusing unrelated native tools", () => {
  expect(
    externalAuthorityOptions(
      { schemaVersion: 1, tools: { deny: ["mcp__cognia-tools__bash"] } },
      {},
      { protocol: "acp" }
    ).nativePolicy
  ).toBeUndefined()
})
it("translates the native Pi surface and filters Host-provided MCP servers", () => {
  const out = externalAuthorityOptions(
    {
      schemaVersion: 1,
      tools: { allow: ["read"], deny: ["bash"] },
      mcpServers: { only: ["safe"] },
      skills: { only: [] },
      subagents: { only: [] },
      maxTurns: 2,
    },
    { maxSteps: 10, context: { custom: { mcpServers: [{ name: "safe" }, { name: "unsafe" }] } } },
    { protocol: "pi-rpc" }
  )
  expect(out.nativePolicy).toEqual({
    tools: { allow: ["read"], deny: ["bash"] },
    mcpServers: { only: ["safe"] },
    skills: { only: [] },
    subagents: { only: [] },
  })
  expect(out.maxSteps).toBe(2)
  expect(out.context?.custom?.mcpServers).toEqual([{ name: "safe" }])
})
it("routes inherited unattended permissions through the Host responder", async () => {
  const out = externalAuthorityOptions(
    { schemaVersion: 1, permissionProfile: { outbound: "deny" } },
    {},
    { protocol: "acp" }
  )
  await expect(
    out.onPermissionRequest!({
      id: "p",
      requestId: "p",
      sessionId: "s",
      title: "send",
      toolInfo: { name: "send" },
    } as never)
  ).resolves.toMatchObject({ granted: false, reason: expect.stringContaining("unattended") })
})
beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})
it.each(["codex-app-server", "acp", "opencode"] as const)(
  "does not treat a top-level %s turn's own resolved options as an inherited ceiling",
  async (protocol) => {
    await getDb().executionRuns.add({
      id: "root",
      kind: "agent-turn",
      sourceId: "root",
      title: "root",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
      ...recordedRunMetadata("local", { runId: "root" }),
      authority: {
        schemaVersion: 1,
        tools: { allow: ["Read"] },
        maxTurns: 30,
        mcpServers: { only: ["cognia-tools"] },
      },
    })
    const options = {
      allowedTools: ["Read"],
      maxSteps: 30,
      context: {
        custom: { mcpServers: [{ name: "cognia-tools", command: "node", args: [], env: [] }] },
      },
    }
    await expect(
      enforceExternalRunAuthority({ executionRunId: "root" }, options, { protocol })
    ).resolves.toBe(options)
  }
)

it("applies a real persisted parent's cap while excluding the child's own record", async () => {
  const make = (id: string) => ({
    id,
    kind: "agent-turn" as const,
    sourceId: id,
    title: id,
    status: "running" as const,
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
    ...recordedRunMetadata("local", { runId: id }),
  })
  const parent = {
    ...make("parent"),
    authority: {
      schemaVersion: 1 as const,
      caps: "explicit-v1" as const,
      permissionMode: "plan" as const,
      maxTurns: 2,
    },
  }
  await getDb().executionRuns.add(parent)
  await getDb().executionRuns.add({
    ...make("child"),
    parentRunId: "parent",
    ...recordedRunMetadata("child", { parent }),
    authority: { schemaVersion: 1, caps: "explicit-v1", maxTurns: 1, tools: { deny: ["write"] } },
  })
  const out = await enforceExternalRunAuthority(
    { executionRunId: "child" },
    { permissionMode: "bypassPermissions", maxSteps: 20 },
    { protocol: "pi-rpc" }
  )
  expect(out).toMatchObject({ permissionMode: "plan", maxSteps: 2 })
  expect((await getDb().executionRuns.get("child"))?.authority).toMatchObject({
    permissionMode: "plan",
    maxTurns: 1,
    tools: { deny: ["write"] },
  })
})

it("counts execution steps once and records the cancellation reason at the bound", async () => {
  const cancel = jest.fn(async () => {})
  const guard = externalAuthorityStepGuard(
    { inheritedRunAuthority: { schemaVersion: 1, maxTurns: 2 } },
    cancel
  )
  const first = {
    type: "tool_use_start",
    toolUseId: "a",
    toolName: "read",
    sessionId: "s",
    timestamp: new Date(),
  } as const
  await guard.observe(first)
  await guard.observe(first)
  expect(cancel).not.toHaveBeenCalled()
  await guard.observe({ ...first, toolUseId: "b" })
  await guard.observe({ ...first, toolUseId: "c" })
  expect(cancel).toHaveBeenCalledTimes(1)
  expect(guard.reason).toBe("run_authority.maxTurns: 2")
})

it("translates Codex shell exclusions and native subagent discovery without a blanket refusal", () => {
  const out = externalAuthorityOptions(
    { schemaVersion: 1, tools: { deny: ["Bash"] }, subagents: { only: ["reader"] } },
    {},
    { protocol: "codex-app-server" }
  )
  expect(out.nativePolicy).toMatchObject({
    tools: { deny: ["Bash"] },
    subagents: { only: ["reader"] },
  })
})

it("never persists an external effective cap onto personal provenance source runs", async () => {
  const make = (id: string, authority: import("@/types/execution/run").RunAuthorityV1) => ({
    id,
    kind: "agent-turn" as const,
    sourceId: id,
    title: id,
    status: "running" as const,
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
    ...recordedRunMetadata("local", { runId: id }),
    authority: { ...authority, caps: "explicit-v1" as const },
  })
  const parent = make("external-parent", { schemaVersion: 1, maxTurns: 3 })
  const source = make("source", { schemaVersion: 1, tools: { deny: ["Bash"] }, maxTurns: 1 })
  await getDb().executionRuns.bulkAdd([
    parent,
    source,
    {
      ...make("external", { schemaVersion: 1, maxTurns: 2 }),
      parentRunId: parent.id,
      ...recordedRunMetadata("child", { parent }),
      authority: { schemaVersion: 1, caps: "explicit-v1", maxTurns: 2 },
    },
  ])
  const output = await enforceExternalRunAuthority(
    bindExternalRunAuthority(
      { personalSources: [{ executionRunId: "external" }, { executionRunId: "source" }] },
      "external"
    ),
    { maxSteps: 9 },
    { protocol: "pi-rpc" }
  )
  expect(output?.maxSteps).toBe(3)
  expect((await getDb().executionRuns.get("external"))?.authority?.maxTurns).toBe(2)
  expect(await getDb().executionRuns.get("source")).toEqual(source)
})

it("maps canonical MCP ids to engine names at the translation boundary", () => {
  const authority = { schemaVersion: 1 as const, mcpServers: { only: ["github-id"] } }
  const out = externalAuthorityOptions(
    authority,
    { context: { custom: { mcpServers: [{ name: "github" }] } } },
    { protocol: "pi-rpc" },
    { "github-id": "github" }
  )
  expect(out.nativePolicy?.mcpServers).toEqual({ only: ["github"] })
  expect(out.inheritedRunAuthority).toEqual(authority)
  expect(out.context?.custom?.mcpServers).toEqual([{ name: "github" }])
})

it("keeps background plugin invocations without a Host run unfenced", async () => {
  const options = { permissionMode: "acceptEdits" as const, allowedTools: ["Read"] }
  expect(
    await enforceExternalRunAuthority({ executionRunId: "" }, options, { protocol: "acp" })
  ).toBe(options)
})

it("retains inherited Pi allows through the permission translator for MCP projection", async () => {
  const { enforceExternalPermissionCeiling } = await import("./permission-ceiling")
  const translated = externalAuthorityOptions(
    { schemaVersion: 1, tools: { allow: ["Read"] } },
    {},
    { protocol: "pi-rpc" }
  )
  expect(translated.permissionCeiling?.allowedTools).toEqual(["Read"])
  const enforced = enforceExternalPermissionCeiling(translated, "pi-rpc", {
    permissionModes: ["default"],
  })
  expect(enforced?.nativePolicy?.tools?.allow).toEqual(["Read"])
  expect(enforced?.permissionCeiling?.allowedTools).toEqual(["Read"])
})
