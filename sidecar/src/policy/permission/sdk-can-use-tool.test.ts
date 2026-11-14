// The Agent SDK rail's plugin-access wiring:
// `createAnthropicCanUseTool` must build the plugin-access map from
// `sendOptions.pluginTools` itself — if that construction regresses, a
// declared-read plugin tool (e.g. ripgrep_search) silently loses the
// built-in credential-path deny.

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { createDoomLoopGuard } from "../doom-loop.ts"
import type { PendingApproval } from "./approval.ts"
import { createAnthropicCanUseTool } from "./sdk-can-use-tool.ts"
import type { PermissionSendOptions } from "./ladder.ts"
import { createWorkerToolAdmission, type WorkerToolAdmission } from "../fence/admission.ts"

function mkRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cognia-canusetool-"))
}

function mkGate(
  sendOptions: PermissionSendOptions,
  {
    emit = () => {},
    pendingApprovals = new Map(),
    workerToolAdmission,
  }: {
    emit?: (frame: Record<string, unknown>) => void
    pendingApprovals?: Map<string, PendingApproval>
    workerToolAdmission?: WorkerToolAdmission
  } = {}
) {
  return createAnthropicCanUseTool({
    sendOptions,
    sessionId: "s1",
    emit,
    log: () => {},
    pendingApprovals,
    pluginToolNameAliases: new Map(),
    doomGuard: createDoomLoopGuard(),
    workerToolAdmission,
  })
}

const RG_TOOL = "mcp__cognia-plugin-tools__ripgrep-tools:ripgrep_search"
const RG_ENTRY = {
  name: "ripgrep-tools:ripgrep_search",
  description: "search",
  jsonSchema: {},
  pluginId: "ripgrep-tools",
  access: "read",
  pathParams: ["path"],
}

test("interactive forms cannot be silently approved by bypass or standing grants", async () => {
  const pending = new Map<string, PendingApproval>()
  const frames: Array<Record<string, unknown>> = []
  const tool = "Runtime:Elicitation"
  const gate = mkGate(
    { permissionMode: "bypassPermissions", alwaysAllowTools: [tool] },
    {
      pendingApprovals: pending,
      emit: (frame) => {
        frames.push(frame)
        queueMicrotask(() =>
          pending
            .get(frame.requestId as string)
            ?.resolve({ behavior: "allow", updatedInput: { response: "yes" } })
        )
      },
    }
  )
  const result = await gate(tool, {}, { requiresInteraction: true })
  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.requiresPerCallApproval, true)
  assert.deepEqual(result.updatedInput, { response: "yes" })
  const refused = await mkGate({ permissionMode: "dontAsk" })(
    tool,
    {},
    { requiresInteraction: true }
  )
  assert.equal(refused.behavior, "deny")
})

test("anthropic canUseTool denies a declared-read plugin tool on a credential path", async () => {
  const root = mkRoot()
  const secret = path.join(root, ".ssh", "id_rsa")
  // A ruleset allow would otherwise approve this silently — only the
  // plugin-access map turns it into a confinement deny.
  const canUseTool = mkGate({
    permissionRuleset: { [RG_TOOL]: "allow" },
    confinement: { enabled: true, roots: [root] },
    cwd: root,
    pluginTools: [RG_ENTRY],
  })
  const res = await canUseTool(RG_TOOL, { path: secret }, {})
  assert.equal(res.behavior, "deny")
  assert.match(String(res.message), /credential|protected|denied/)
})

test("anthropic canUseTool keeps undeclared plugin tools opaque to confinement", async () => {
  const root = mkRoot()
  const secret = path.join(root, ".ssh", "id_rsa")
  const canUseTool = mkGate({
    permissionRuleset: { [RG_TOOL]: "allow" },
    confinement: { enabled: true, roots: [root] },
    cwd: root,
    pluginTools: [], // no manifest entry → no access class → opaque
  })
  const res = await canUseTool(RG_TOOL, { path: secret }, {})
  assert.equal(res.behavior, "allow")
})

test("anthropic canUseTool honors manifest-declared pathParams beyond PATH_KEYS", async () => {
  const root = mkRoot()
  const secret = path.join(root, ".aws", "credentials")
  const tool = "mcp__cognia-plugin-tools__my-plugin:exporter"
  const canUseTool = mkGate({
    permissionRuleset: { [tool]: "allow" },
    confinement: { enabled: true, roots: [root] },
    cwd: root,
    pluginTools: [
      {
        name: "my-plugin:exporter",
        description: "x",
        jsonSchema: {},
        pluginId: "my-plugin",
        access: "read",
        pathParams: ["export_dest"],
      },
    ],
  })
  // `export_dest` is not a built-in PATH_KEY — only the declared pathParams
  // make the credential deny see it.
  const res = await canUseTool(tool, { export_dest: secret }, {})
  assert.equal(res.behavior, "deny")
})

test("anthropic canUseTool escalates a declared-write plugin tool escaping the roots", async () => {
  const root = mkRoot()
  const outside = path.join(mkRoot(), "out.txt")
  const tool = "mcp__cognia-plugin-tools__my-plugin:file_writer"
  const emitted: Record<string, unknown>[] = []
  const pending = new Map<string, PendingApproval>()
  const canUseTool = mkGate(
    {
      confinement: { enabled: true, roots: [root] },
      cwd: root,
      pluginTools: [
        {
          name: "my-plugin:file_writer",
          description: "w",
          jsonSchema: {},
          pluginId: "my-plugin",
          access: "write",
          pathParams: ["path"],
        },
      ],
    },
    {
      emit: (ev) => {
        emitted.push(ev)
        // Auto-approve so the round-trip resolves.
        queueMicrotask(() =>
          pending
            .get(ev.requestId as string)
            ?.resolve({ behavior: "allow", updatedInput: { ok: 1 } })
        )
      },
      pendingApprovals: pending,
    }
  )
  const res = await canUseTool(tool, { path: outside }, {})
  // Confinement "ask" falls through to the approval round-trip.
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]?.type, "permission_request")
  assert.equal(emitted[0]?.toolName, tool)
  assert.equal(res.behavior, "allow")
  assert.deepEqual(res.updatedInput, { ok: 1 })
})

test("anthropic canUseTool survives non-array pluginTools", async () => {
  const root = mkRoot()
  // A foreign/legacy sender shape must degrade to opaque, not throw.
  for (const bad of [undefined, null, "str", { name: "x" }]) {
    const canUseTool = mkGate({
      permissionRuleset: { [RG_TOOL]: "allow" },
      confinement: { enabled: true, roots: [root] },
      cwd: root,
      pluginTools: bad,
    })
    const res = await canUseTool(RG_TOOL, { path: "src" }, {})
    assert.equal(res.behavior, "allow")
  }
})

test("approval input rewrites are checked against the same hard authority", async () => {
  const pendingApprovals = new Map<string, PendingApproval>()
  const gate = mkGate({}, { pendingApprovals })
  const pending = gate("Read", { path: "/workspace/safe" }, {})
  const entry = [...pendingApprovals.values()][0]
  assert.ok(entry)
  entry.resolve({ behavior: "allow", updatedInput: { content: "private@example.com" } })
  assert.equal((await pending).behavior, "deny")
})

// ADR-0201: browser_set_files (like browser_fill_credential) asks on every
// call. A ruleset allow, an always-allow grant or bypassPermissions must not
// skip it, dontAsk denies it, and an "always allow" answer can never persist
// the SDK's suggested rule.
const SET_FILES_TOOL = "mcp__cognia-plugin-tools__browser_set_files"
const SET_FILES_ENTRY = { name: "browser_set_files", requiresApproval: true }

test("anthropic canUseTool asks for browser_set_files on every call whatever the grants", async () => {
  for (const permissionMode of ["bypassPermissions", "acceptEdits", "default"]) {
    const frames: Record<string, unknown>[] = []
    const pendingApprovals = new Map<string, PendingApproval>()
    const canUseTool = mkGate(
      {
        permissionMode,
        permissionRuleset: { [SET_FILES_TOOL]: "allow" },
        alwaysAllowTools: [SET_FILES_TOOL],
        pluginTools: [SET_FILES_ENTRY],
      },
      { emit: (frame) => frames.push(frame), pendingApprovals }
    )
    const pending = canUseTool(
      SET_FILES_TOOL,
      { ref: "f", paths: ["a.txt"] },
      { suggestions: [{ type: "addRules", destination: "session", rules: [], behavior: "allow" }] }
    )
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(frames.length, 1, `${permissionMode}: the call round-trips`)
    assert.equal(frames[0]?.requiresPerCallApproval, true)
    assert.equal(frames[0]?.suppressAlwaysAllowRule, true)
    const entry = [...pendingApprovals.values()][0]
    assert.ok(entry)
    assert.equal(entry.suppressAlwaysAllowRule, true)
    entry.resolve({ behavior: "allow", updatedInput: { ref: "f", paths: ["a.txt"] } })
    const res = await pending
    assert.equal(res.behavior, "allow")
  }
})

test("anthropic canUseTool denies browser_set_files under dontAsk", async () => {
  const frames: Record<string, unknown>[] = []
  const canUseTool = mkGate(
    {
      permissionMode: "dontAsk",
      alwaysAllowTools: [SET_FILES_TOOL],
      pluginTools: [SET_FILES_ENTRY],
    },
    { emit: (frame) => frames.push(frame) }
  )
  const res = await canUseTool(SET_FILES_TOOL, { ref: "f", paths: ["a.txt"] }, {})
  assert.equal(res.behavior, "deny")
  assert.equal(frames.length, 0)
})

// ADR-0239: outbound tools listed in `alwaysExplicitTools`.
const IM_SEND = "mcp__cognia-plugin-tools__im_broadcast"

test("an enforced outbound tool asks per call past an always-allow grant", async () => {
  const pending = new Map<string, PendingApproval>()
  const frames: Array<Record<string, unknown>> = []
  const gate = mkGate(
    {
      alwaysAllowTools: [IM_SEND],
      alwaysExplicitTools: ["im_broadcast"],
      alwaysExplicitToolsMode: "enforce",
    },
    {
      pendingApprovals: pending,
      emit: (frame) => {
        frames.push(frame)
        queueMicrotask(() => pending.get(frame.requestId as string)?.resolve({ behavior: "allow" }))
      },
    }
  )
  const result = await gate(IM_SEND, {}, { toolUseID: "tu-1" })
  assert.equal(result.behavior, "allow")
  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.permissionClass, "outbound")
  assert.equal(frames[0]!.requiresPerCallApproval, true)
  assert.equal(frames[0]!.suppressAlwaysAllowRule, true)
})

test("an observed outbound tool a grant allows is reported once and marked seen", async () => {
  const frames: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const gate = createAnthropicCanUseTool({
    sendOptions: {
      alwaysAllowTools: [IM_SEND],
      alwaysExplicitTools: ["im_broadcast"],
      alwaysExplicitToolsMode: "observe",
    },
    sessionId: "s1",
    emit: (frame) => frames.push(frame),
    log: () => {},
    pendingApprovals: new Map(),
    pluginToolNameAliases: new Map(),
    doomGuard: createDoomLoopGuard(),
    explicitSeen: seen,
  })
  const result = await gate(IM_SEND, { text: "hi" }, { toolUseID: "tu-2" })
  assert.equal(result.behavior, "allow")
  assert.deepEqual(frames, [
    {
      type: "explicit_tool_allowed",
      sessionId: "s1",
      toolUseID: "tu-2",
      toolName: IM_SEND,
      input: { text: "hi" },
      permissionClass: "outbound",
    },
  ])
  assert.deepEqual([...seen], ["tu-2"])
})

test("a person's approval of a listed call marks it seen, not reported", async () => {
  const pending = new Map<string, PendingApproval>()
  const frames: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const gate = createAnthropicCanUseTool({
    sendOptions: { alwaysExplicitTools: ["im_broadcast"], alwaysExplicitToolsMode: "observe" },
    sessionId: "s1",
    emit: (frame) => {
      frames.push(frame)
      queueMicrotask(() => pending.get(frame.requestId as string)?.resolve({ behavior: "allow" }))
    },
    log: () => {},
    pendingApprovals: pending,
    pluginToolNameAliases: new Map(),
    doomGuard: createDoomLoopGuard(),
    explicitSeen: seen,
  })
  await gate(IM_SEND, {}, { toolUseID: "tu-3" })
  assert.deepEqual(
    frames.map((f) => f.type),
    ["permission_request"]
  )
  assert.deepEqual([...seen], ["tu-3"])
})

// ADR-0239 phase 2: shell calls with a `gh` write, in their own mode.
test("an enforced shell gh write asks per call past an always-allow grant", async () => {
  const pending = new Map<string, PendingApproval>()
  const frames: Array<Record<string, unknown>> = []
  const gate = mkGate(
    { alwaysAllowTools: ["Bash"], alwaysExplicitGithubWritesMode: "enforce" },
    {
      pendingApprovals: pending,
      emit: (frame) => {
        frames.push(frame)
        queueMicrotask(() => pending.get(frame.requestId as string)?.resolve({ behavior: "allow" }))
      },
    }
  )
  const result = await gate("Bash", { command: "gh pr merge 3" }, { toolUseID: "tu-9" })
  assert.equal(result.behavior, "allow")
  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.permissionClass, "outbound")
  assert.equal(frames[0]!.requiresPerCallApproval, true)
})

test("an observed shell gh write a grant allows is reported once and marked seen", async () => {
  const frames: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  const gate = createAnthropicCanUseTool({
    sendOptions: { alwaysAllowTools: ["Bash"], alwaysExplicitGithubWritesMode: "observe" },
    sessionId: "s1",
    emit: (frame) => frames.push(frame),
    log: () => {},
    pendingApprovals: new Map(),
    pluginToolNameAliases: new Map(),
    doomGuard: createDoomLoopGuard(),
    explicitSeen: seen,
  })
  const input = { command: "gh issue close 4" }
  const result = await gate("Bash", input, { toolUseID: "tu-10" })
  assert.equal(result.behavior, "allow")
  assert.equal(frames.length, 1)
  assert.equal(frames[0]!.type, "explicit_tool_allowed")
  assert.deepEqual([...seen], ["tu-10"])
  await gate("Bash", { command: "gh issue view 4" }, { toolUseID: "tu-11" })
  assert.equal(frames.length, 1)
})

test("Anthropic approval rewrites cannot enter protected credential paths", async () => {
  const root = mkRoot()
  try {
    const pendingApprovals = new Map<string, PendingApproval>()
    const gate = mkGate(
      {
        cwd: root,
        confinement: { enabled: true, roots: [root] },
        pluginTools: [{ name: "reader", access: "read", pathParams: ["path"] }],
      },
      { pendingApprovals }
    )
    const result = gate("mcp__cognia-plugin-tools__reader", { path: path.join(root, "safe") }, {})
    const entry = [...pendingApprovals.values()][0]!
    entry.resolve({ behavior: "allow", updatedInput: { path: path.join(root, ".ssh", "id_rsa") } })
    const decision = await result
    assert.equal(decision.behavior, "deny")
    assert.match(String(decision.message), /protected credential/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("nested approval schemas validate rewrites before hard authority checks", async () => {
  const pendingApprovals = new Map<string, PendingApproval>()
  const gate = mkGate({}, { pendingApprovals })
  const result = gate(
    "mcp__cognia-tools__file_info",
    { path: "safe" },
    {
      validateInput() {
        throw new Error("invalid arguments for file_info")
      },
    }
  )
  const entry = [...pendingApprovals.values()][0]!
  entry.resolve({ behavior: "allow", updatedInput: { path: 42 } })
  const decision = await result
  assert.equal(decision.behavior, "deny")
  assert.match(String(decision.message), /invalid arguments/)
})

test("nested SDK preflight reuses modes, preapproval and mandatory denials", async () => {
  const read = "mcp__cognia-tools__file_info"
  const edit = "mcp__cognia-tools__directory_create"
  for (const fixture of [
    {
      options: { permissionMode: "bypassPermissions" },
      tool: read,
      approved: false,
      expected: "allow",
    },
    { options: { permissionMode: "dontAsk" }, tool: read, approved: false, expected: "deny" },
    { options: { permissionMode: "dontAsk" }, tool: read, approved: true, expected: "allow" },
    { options: {}, tool: read, approved: true, expected: "allow" },
    { options: { permissionMode: "acceptEdits" }, tool: edit, approved: false, expected: "allow" },
    { options: { permissionMode: "plan" }, tool: read, approved: false, expected: "allow" },
    { options: { permissionMode: "plan" }, tool: edit, approved: true, expected: "deny" },
    {
      options: { permissionMode: "bypassPermissions", permissionRuleset: { [read]: "deny" } },
      tool: read,
      approved: true,
      expected: "deny",
    },
  ]) {
    const pending = new Map<string, PendingApproval>()
    const frames: Record<string, unknown>[] = []
    const gate = mkGate(fixture.options, {
      pendingApprovals: pending,
      emit(frame) {
        frames.push(frame)
        queueMicrotask(() => pending.get(frame.requestId as string)?.resolve({ behavior: "deny" }))
      },
    })
    const decision = await gate(
      fixture.tool,
      { path: "." },
      { sdkPreflight: true, sdkPreapproved: fixture.approved }
    )
    assert.equal(decision.behavior, fixture.expected, JSON.stringify(fixture))
    assert.equal(frames.length, 0, "mode/preapproval decisions must not prompt")
  }
})

test("nested bypass and preapproval preserve hard authority and per-call requirements", async () => {
  const root = mkRoot()
  const read = "mcp__cognia-tools__file_info"
  try {
    for (const options of [
      { permissionMode: "bypassPermissions", confinement: { enabled: true, roots: [root] } },
      { permissionMode: "bypassPermissions", builtinProcessSandbox: { writableRoots: [root] } },
    ]) {
      const result = await mkGate(options)(
        "mcp__cognia-tools__directory_create",
        { path: path.join(root, ".ssh", "id_rsa") },
        { sdkPreflight: true, sdkPreapproved: true }
      )
      assert.equal(result.behavior, "deny")
    }
    for (const permissionMode of ["bypassPermissions", "dontAsk"]) {
      const pending = new Map<string, PendingApproval>()
      const frames: Record<string, unknown>[] = []
      const gate = mkGate(
        { permissionMode, toolPermissionRules: [{ tool: read, decision: "ask" }] },
        {
          pendingApprovals: pending,
          emit(frame) {
            frames.push(frame)
            queueMicrotask(() =>
              pending.get(frame.requestId as string)?.resolve({ behavior: "allow" })
            )
          },
        }
      )
      const decision = await gate(
        read,
        { path: root },
        { sdkPreflight: true, sdkPreapproved: true }
      )
      assert.equal(decision.behavior, permissionMode === "dontAsk" ? "deny" : "allow")
      assert.equal(frames.length, permissionMode === "dontAsk" ? 0 : 1)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("nested mode shortcuts never bypass always-ask permission classes", async () => {
  const tool = "mcp__cognia-plugin-tools__notify_fixture"
  for (const permissionMode of ["bypassPermissions", "dontAsk"]) {
    const pending = new Map<string, PendingApproval>()
    const frames: Record<string, unknown>[] = []
    const gate = mkGate(
      {
        permissionMode,
        permissionProfile: { outbound: "ask" },
        pluginTools: [{ name: "notify_fixture", permissionClasses: ["outbound"] }],
      },
      {
        pendingApprovals: pending,
        emit(frame) {
          frames.push(frame)
          queueMicrotask(() =>
            pending.get(frame.requestId as string)?.resolve({ behavior: "allow" })
          )
        },
      }
    )
    const decision = await gate(tool, {}, { sdkPreflight: true, sdkPreapproved: true })
    assert.equal(decision.behavior, permissionMode === "dontAsk" ? "deny" : "allow")
    assert.equal(frames.length, permissionMode === "dontAsk" ? 0 : 1)
    if (frames.length) assert.equal(frames[0]!.requiresPerCallApproval, true)
  }
})

test("a mid-run fence denies preapproved opaque tools before permissions", async () => {
  const options: PermissionSendOptions = {
    permissionMode: "bypassPermissions",
    alwaysAllowTools: ["Bash", "WebFetch", "WebSearch"],
  }
  const gate = mkGate(options)
  options.personalEgressFenced = true
  for (const name of ["Bash", "WebFetch", "mcp__third__read"])
    assert.equal((await gate(name, {}, {})).behavior, "deny")
  assert.equal((await gate("WebSearch", {}, {})).behavior, "allow")
})

test("H1: only the installed native registry mints Host approval ownership", async () => {
  for (const name of ["Read", "mcp__third__Read", "mcp__cognia-plugin-tools__Read"]) {
    const frames: Record<string, unknown>[] = []
    const pending = new Map<string, PendingApproval>()
    const gate = mkGate(
      { permissionMode: "default" },
      {
        pendingApprovals: pending,
        emit: (frame) => {
          frames.push(frame)
          queueMicrotask(() => pending.get(String(frame.requestId))?.resolve({ behavior: "allow" }))
        },
      }
    )
    await gate(name, {}, { sdkPreflight: true })
    assert.equal(frames.length, 1)
    assert.deepEqual(
      frames[0]!.nativeTool,
      name === "Read" ? { engine: "claude-agent-sdk", name: "Read" } : undefined
    )
  }
})

for (const expired of [false, true]) {
  test(`Claude re-admits after approval and ${expired ? "local expiry" : "host refusal"} interrupts it`, async () => {
    let now = 0
    let allowed = true
    let calls = 0
    let interrupted = 0
    const admission = createWorkerToolAdmission({
      sessionId: "s1",
      now: () => now,
      onDenied() {
        interrupted++
      },
      hostRpc: {
        async call() {
          calls++
          return { allowed, leaseTtlMs: 100 }
        },
      },
    })
    await admission.admit("Bash", "t") // the earlier PreToolUse grant
    const pendingApprovals = new Map<string, PendingApproval>()
    const canUseTool = mkGate({}, { pendingApprovals, workerToolAdmission: admission })
    const waiting = canUseTool("Bash", { command: "pwd" }, { toolUseID: "t" })
    assert.equal(pendingApprovals.size, 1)
    assert.equal(calls, 1, "admission waits until after approval")
    allowed = false
    now = expired ? 100 : 10
    ;[...pendingApprovals.values()][0]!.resolve({ behavior: "allow" })
    const result = await waiting
    assert.equal(result.behavior, "deny")
    assert.equal(result.interrupt, true)
    assert.equal(interrupted, 1)
    // A lapsed local deadline still asks Node (a renewal may have landed); the
    // unrenewed lease is refused there.
    assert.equal(calls, 2)
  })
}

test("an approved profile-hook handoff also rechecks worker authority", async () => {
  let calls = 0
  const admission = createWorkerToolAdmission({
    sessionId: "s",
    onDenied() {},
    hostRpc: {
      async call() {
        calls++
        return { allowed: false }
      },
    },
  })
  const authorize = createAnthropicCanUseTool({
    sendOptions: {},
    sessionId: "s",
    emit() {},
    log() {},
    pendingApprovals: new Map(),
    pluginToolNameAliases: new Map(),
    doomGuard: createDoomLoopGuard(),
    profileApprovals: new Set(["approved"]),
    workerToolAdmission: admission,
  })
  assert.equal((await authorize("Bash", {}, { toolUseID: "approved" })).behavior, "deny")
  assert.equal(calls, 1)
})
