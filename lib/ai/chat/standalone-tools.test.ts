/**
 * @jest-environment jsdom
 */
import type { SendOptions } from "@cognia/agent-config-types"
import { generateText, isStepCount } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { loggers } from "@cognia/logging"
import { createToolPermissionGate } from "../../../sidecar/src/policy/permission/ai-sdk-gate"
import { sanitizeModelToolName } from "../../../sidecar/src/policy/tool-catalog/model-names"
import { builtinToModelOutput } from "../../../sidecar/src/tools/adapters/ai-sdk-output"
import { resolveForToolCall } from "../../../sidecar/src/policy/permission/resolver"

const handlePluginToolExec = jest.fn()
const requestLocalToolApproval = jest.fn()
jest.mock("@/lib/ai/agent/execution/sidecar-client", () => ({
  requestLocalToolApproval: (...args: unknown[]) => requestLocalToolApproval(...args),
}))
jest.mock("@/lib/plugin/bridge/agent-tool-dispatch", () => ({
  handlePluginToolExec: (...args: unknown[]) => handlePluginToolExec(...args),
}))

import {
  buildStandaloneTools,
  isUsableStandaloneToolName,
  STANDALONE_MAX_STEPS,
  standalonePermissionDecision,
  standaloneRulesetVerdict,
  sanitizeStandaloneToolName,
  standaloneToModelOutput,
} from "./standalone-tools"

type Manifest = NonNullable<SendOptions["pluginTools"]>

const entry = (name: string, overrides: Partial<Manifest[number]> = {}): Manifest[number] => ({
  name,
  description: `${name} description`,
  jsonSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  pluginId: "cognia-web-builtin",
  ...overrides,
})

/** The AI SDK's `(input, options)` executor, untyped for fixture options. */
type LooseExecute = (input: unknown, options: Record<string, unknown>) => Promise<unknown>
const executorOf = (tool: { execute?: unknown }) => tool.execute as LooseExecute

/** AI SDK passes `(input, options)`; only `toolCallId` matters here. */
const runTool = (tool: unknown, args: Record<string, unknown>, toolCallId = "call-1") =>
  (
    tool as {
      execute: (a: unknown, o: { toolCallId: string }) => Promise<unknown>
    }
  ).execute(args, { toolCallId })

beforeEach(() => {
  handlePluginToolExec.mockReset()
  requestLocalToolApproval.mockReset().mockResolvedValue({ allowed: true, input: { q: "x" } })
})

describe("standalone authority and dispatch boundaries", () => {
  const approval = { signal: new AbortController().signal, emit: jest.fn() }
  it.each(["Read", "read", "mcp__cognia-plugin-tools__read", "mcp__cognia-tools__read"])(
    "honors allow and deny aliases for %s",
    (alias) => {
      const options = { pluginTools: [entry("read"), entry("write")] }
      expect(
        Object.keys(buildStandaloneTools({ ...options, allowedTools: [alias] }, "s1")!.tools)
      ).toEqual(["read"])
      expect(
        Object.keys(buildStandaloneTools({ ...options, disallowedTools: [alias] }, "s1")!.tools)
      ).toEqual(["write"])
    }
  )

  it("keeps the disabled surface usable even with host-only policy", () => {
    expect(
      buildStandaloneTools(
        {
          toolSurface: "none",
          confinement: { enabled: true, roots: ["/x"] },
          pluginTools: [entry("search")],
        } as SendOptions,
        "s1"
      )
    ).toBeUndefined()
  })

  it("rechecks both schema and permission after an approved input rewrite", async () => {
    const result = buildStandaloneTools(
      { permissionRuleset: { search: { "/private/**": "deny" } }, pluginTools: [entry("search")] },
      "s1",
      approval
    )!
    requestLocalToolApproval.mockResolvedValueOnce({ allowed: true, input: { q: 123 } })
    await expect(runTool(result.tools.search, { q: "x" })).rejects.toThrow(/input/i)
    requestLocalToolApproval.mockResolvedValueOnce({
      allowed: true,
      input: { q: "x", path: "/private/x" },
    })
    await expect(runTool(result.tools.search, { q: "x" })).rejects.toThrow(/denied/)
    expect(handlePluginToolExec).not.toHaveBeenCalled()
  })

  it("keeps per-call consent ahead of bypass and remembered grants", async () => {
    const manifest = { ...entry("browser_set_files"), requiresApproval: true }
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        permissionRuleset: { "*": "allow" },
        alwaysAllowTools: ["browser_set_files"],
        pluginTools: [manifest],
      },
      "s1",
      approval
    )!
    handlePluginToolExec.mockResolvedValue({ result: "ok" })
    await runTool(result.tools.browser_set_files, { q: "x" })
    await runTool(result.tools.browser_set_files, { q: "x" })
    expect(requestLocalToolApproval).toHaveBeenCalledTimes(2)
    expect(standalonePermissionDecision({ permissionMode: "dontAsk" }, manifest, { q: "x" })).toBe(
      "deny"
    )
  })

  it("cancels work already running in the shared dispatcher", async () => {
    const controller = new AbortController()
    handlePluginToolExec.mockImplementation(
      ({ abortSignal }) =>
        new Promise((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true })
        })
    )
    const result = buildStandaloneTools(
      { permissionMode: "bypassPermissions", pluginTools: [entry("search")] },
      "s1"
    )!
    const pending = executorOf(result.tools.search)(
      { q: "x" },
      { toolCallId: "cancel", messages: [], abortSignal: controller.signal }
    )
    controller.abort(new Error("cancelled"))
    await expect(pending).rejects.toThrow("cancelled")
  })
  it("cuts a call off at the entry's declared deadline and cancels it", async () => {
    let seen: AbortSignal | undefined
    // An executor that keeps going until it is told to stop, then ignores it.
    handlePluginToolExec.mockImplementation(({ abortSignal }) => {
      seen = abortSignal
      return new Promise(() => {})
    })
    const result = buildStandaloneTools(
      { permissionMode: "bypassPermissions", pluginTools: [entry("search", { timeoutMs: 20 })] },
      "s1"
    )!
    await expect(
      executorOf(result.tools.search)({ q: "x" }, { toolCallId: "slow", messages: [] })
    ).rejects.toThrow("plugin tool 'search' timed out after 20ms")
    expect(seen?.aborted).toBe(true)
  })

  it("gives a call no deadline when its entry declares 0", async () => {
    jest.useFakeTimers()
    try {
      let finish!: (value: unknown) => void
      handlePluginToolExec.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
      const result = buildStandaloneTools(
        { permissionMode: "bypassPermissions", pluginTools: [entry("ask", { timeoutMs: 0 })] },
        "s1"
      )!
      const pending = executorOf(result.tools.ask)({ q: "x" }, { toolCallId: "ask", messages: [] })
      await jest.advanceTimersByTimeAsync(10 * 60_000)
      finish({ result: "answered" })
      await expect(pending).resolves.toBe("answered")
    } finally {
      jest.useRealTimers()
    }
  })

  it.each([
    { disallowedTools: ["WebSearch"] },
    { disallowedTools: ["mcp__cognia-plugin-tools__web_search"] },
    { allowedTools: ["artifact_read"] },
    { permissionRuleset: { web_search: "deny" as const } },
    { permissionRuleset: { web_search: { "**": "deny" as const } } },
    { permissionRuleset: { "*": { "*": "deny" as const } } },
    { permissionMode: "plan" as const },
  ])("seals the manifest against %j", (policy) => {
    expect(
      buildStandaloneTools({ pluginTools: [entry("web_search")], ...policy } as SendOptions, "s1")
    ).toBeUndefined()
  })

  it("gates actual path arguments before dispatch", async () => {
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        permissionRuleset: { artifact_read: { "/private/**": "deny", "/public/**": "allow" } },
        pluginTools: [entry("artifact_read", { jsonSchema: { type: "object" } })],
      },
      "s1",
      approval
    )
    await expect(runTool(result!.tools.artifact_read, { path: "/private/x" })).rejects.toThrow(
      /denied/
    )
    expect(handlePluginToolExec).not.toHaveBeenCalled()
    handlePluginToolExec.mockResolvedValue({ result: "public" })
    await expect(runTool(result!.tools.artifact_read, { path: "/public/x" })).resolves.toBe(
      "public"
    )
  })

  it("asks through the local card before executing a consent-required tool", async () => {
    const manifest = { ...entry("artifact_delete"), requiresApproval: true }
    const result = buildStandaloneTools({ pluginTools: [manifest] }, "s1", approval)
    handlePluginToolExec.mockResolvedValue({ result: "ok" })
    await runTool(result!.tools.artifact_delete, { q: "x" })
    expect(requestLocalToolApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        toolName: "artifact_delete",
        input: { q: "x" },
        requiresApproval: true,
        requiresPerCallApproval: true,
        suppressAlwaysAllowRule: true,
      })
    )
    requestLocalToolApproval.mockResolvedValue({ allowed: false })
    await expect(runTool(result!.tools.artifact_delete, { q: "x" })).rejects.toThrow(/denied/)
    expect(handlePluginToolExec).toHaveBeenCalledTimes(1)
  })

  it("forwards the live abort signal and frozen turn/attempt identity", async () => {
    const controller = new AbortController()
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        turnId: "turn-frozen",
        execution: { identity: { attemptId: "attempt-frozen" } } as SendOptions["execution"],
        pluginTools: [entry("load_skill")],
      },
      "s1"
    )
    handlePluginToolExec.mockResolvedValue({ result: "ok" })
    const execute = executorOf(result!.tools.load_skill)
    await execute({ q: "x" }, { toolCallId: "tc", messages: [], abortSignal: controller.signal })
    expect(handlePluginToolExec).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-frozen",
        attemptId: "attempt-frozen",
        abortSignal: controller.signal,
      })
    )
    controller.abort()
    await expect(
      execute({ q: "x" }, { toolCallId: "tc", messages: [], abortSignal: controller.signal })
    ).rejects.toThrow()
    expect(handlePluginToolExec).toHaveBeenCalledTimes(1)
  })

  it("rejects invalid inputs and applies JSON Schema defaults", async () => {
    const schema = {
      type: "object",
      properties: {
        q: { type: "string", minLength: 2, maxLength: 4 },
        limit: { type: "integer", minimum: 1, maximum: 2, default: 1 },
      },
      required: ["q"],
      additionalProperties: false,
    }
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        pluginTools: [entry("search", { jsonSchema: schema })],
      },
      "s1"
    )
    for (const input of [
      {},
      { q: 123 },
      { q: "x" },
      { q: "longer" },
      { q: "ok", limit: 3 },
      { q: "ok", limit: 0 },
      { q: "ok", limit: 1.5 },
      { q: "ok", extra: true },
    ]) {
      await expect(runTool(result!.tools.search, input)).rejects.toThrow(/input/i)
    }
    expect(handlePluginToolExec).not.toHaveBeenCalled()
    handlePluginToolExec.mockResolvedValue({ result: "ok" })
    await runTool(result!.tools.search, { q: "ok" })
    expect(handlePluginToolExec).toHaveBeenCalledWith(
      expect.objectContaining({ args: { q: "ok", limit: 1 } })
    )
  })

  it("throws explicit MCP errors while preserving domain refusals", async () => {
    const result = buildStandaloneTools(
      { permissionMode: "bypassPermissions", pluginTools: [entry("search")] },
      "s1"
    )
    handlePluginToolExec.mockResolvedValue({
      result: { content: [{ type: "text", text: "MCP failed" }], isError: true },
    })
    await expect(runTool(result!.tools.search, { q: "x" })).rejects.toThrow("MCP failed")
    handlePluginToolExec.mockResolvedValue({ result: { ok: false, code: "domain_refusal" } })
    await expect(runTool(result!.tools.search, { q: "x" })).resolves.toEqual({
      ok: false,
      code: "domain_refusal",
    })
  })
})

describe("standalone project policies and schema compatibility", () => {
  let warning: jest.SpyInstance
  beforeEach(() => {
    warning = jest.spyOn(loggers.chat, "warn").mockImplementation(() => {})
    handlePluginToolExec.mockResolvedValue({ result: "executed" })
  })
  afterEach(() => warning.mockRestore())

  const policies: SendOptions[] = [
    { confinement: { enabled: true, roots: ["/project"] } },
    {
      builtinProcessSandbox: {
        launcher: "sandbox",
        writableRoots: ["/project"],
        readableRoots: [],
        network: false,
      },
    },
  ]
  it.each(policies)(
    "preserves ungoverned tools under %j and warns about excluded tools",
    async (policy) => {
      const result = buildStandaloneTools(
        {
          ...policy,
          permissionMode: "bypassPermissions",
          pluginTools: [
            entry("web_search"),
            entry("metadata", { access: "read" }),
            entry("file_reader", { access: "read", pathParams: ["target"] }),
            entry("file_writer", { access: "write" }),
            entry("standard_reader", {
              access: "read",
              jsonSchema: { type: "object", properties: { file_path: { type: "string" } } },
            }),
            entry("opaque", { pathParams: ["target"] }),
          ],
        },
        "project"
      )!
      expect(Object.keys(result.tools)).toEqual(["web_search", "metadata", "opaque"])
      await expect(runTool(result.tools.web_search, { q: "x" })).resolves.toBe("executed")
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("host"),
        expect.objectContaining({ names: "file_reader, file_writer, standard_reader" })
      )
      await expect(runTool(result.tools.metadata, { q: "x" })).resolves.toBe("executed")
      for (const input of [
        { q: "x", path: "/project/file" },
        { q: "x", paths: ["/project/file"] },
        { q: "x", operations: [{ file_path: "/project/file" }] },
      ]) {
        await expect(runTool(result.tools.metadata, input)).rejects.toThrow(/denied/)
      }
      expect(handlePluginToolExec).toHaveBeenCalledTimes(2)
    }
  )

  it("does not exclude filesystem tools for disabled or rootless confinement", async () => {
    for (const confinement of [
      { enabled: false, roots: ["/project"] },
      { enabled: true, roots: [] },
    ]) {
      const result = buildStandaloneTools(
        {
          confinement,
          permissionMode: "bypassPermissions",
          pluginTools: [entry("file_writer", { access: "write" })],
        },
        "project"
      )!
      await expect(runTool(result.tools.file_writer, { q: "x" })).resolves.toBe("executed")
    }
    expect(warning).not.toHaveBeenCalled()
  })

  it("respects the sandbox-scope aliases independently of manifest access declarations", () => {
    const manifest = [entry("sandbox_bash"), entry("web_search")]
    expect(
      Object.keys(buildStandaloneTools({ ...policies[0], pluginTools: manifest }, "project")!.tools)
    ).toEqual(["sandbox_bash", "web_search"])
    expect(
      Object.keys(buildStandaloneTools({ ...policies[1], pluginTools: manifest }, "project")!.tools)
    ).toEqual(["web_search"])
    expect(warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ names: "sandbox_bash" })
    )
  })

  it("keeps GitHub tool identity distinct across integrations sharing an action name", () => {
    const options: SendOptions = {
      permissionMode: "bypassPermissions",
      alwaysExplicitGithubWritesMode: "enforce",
      alwaysExplicitGithubTools: ["vendor_a__create_issue"],
    }
    expect(standalonePermissionDecision(options, entry("vendor_a__create_issue"), {})).toBe("ask")
    expect(
      standalonePermissionDecision(options, entry("mcp__plugin__vendor_a__create_issue"), {})
    ).toBe("ask")
    expect(standalonePermissionDecision(options, entry("vendor_b__create_issue"), {})).toBe("allow")
  })

  it("warns even when every tool needs host filesystem enforcement", () => {
    expect(
      buildStandaloneTools(
        { ...policies[0], pluginTools: [entry("file_writer", { access: "write" })] },
        "project"
      )
    ).toBeUndefined()
    expect(warning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ names: "file_writer" })
    )
  })

  it("uses per-call approval for full GitHub names without refusing the turn", async () => {
    const approval = { signal: new AbortController().signal, emit: jest.fn() }
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        permissionRuleset: { "*": "allow" },
        alwaysAllowTools: ["github.create_issue"],
        alwaysExplicitGithubWritesMode: "enforce",
        alwaysExplicitGithubTools: ["github.create_issue"],
        pluginTools: [
          entry("GitHub.Create_Issue"),
          entry("other.create_issue"),
          entry("mcp__plugin__GitHub.Create_Issue"),
        ],
      },
      "github",
      approval
    )!
    for (const name of ["GitHub.Create_Issue", "mcp__plugin__GitHub.Create_Issue"]) {
      const modelName = [...result.aliases].find(([, original]) => original === name)?.[0] ?? name
      await runTool(result.tools[modelName], { q: "x" })
      expect(requestLocalToolApproval).toHaveBeenLastCalledWith(
        expect.objectContaining({
          toolName: name,
          requiresPerCallApproval: true,
          suppressAlwaysAllowRule: true,
          defaultToNo: true,
        })
      )
    }
    await runTool(result.tools.other_create_issue, { q: "x" })
    expect(requestLocalToolApproval).toHaveBeenCalledTimes(2)
    expect(warning).not.toHaveBeenCalled()
    expect(
      standalonePermissionDecision(
        {
          permissionMode: "dontAsk",
          alwaysExplicitGithubWritesMode: "enforce",
          alwaysExplicitGithubTools: ["github.create_issue"],
        },
        entry("GitHub.Create_Issue"),
        {}
      )
    ).toBe("deny")
  })

  it("keeps GitHub observe mode unprompted", async () => {
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        alwaysExplicitGithubWritesMode: "observe",
        alwaysExplicitGithubTools: ["github.create_issue"],
        pluginTools: [entry("github.create_issue")],
      },
      "github"
    )!
    await expect(runTool(result.tools.github_create_issue, { q: "x" })).resolves.toBe("executed")
    expect(requestLocalToolApproval).not.toHaveBeenCalled()
  })

  it.each([
    { dependentRequired: { q: ["other"] } },
    { dependentSchemas: { q: { required: ["other"] } } },
    { if: { required: ["q"] }, then: { required: ["other"] }, else: { required: ["another"] } },
  ])("accepts legal input despite converter-unsupported %j", async (unsupported) => {
    const schema = {
      type: "object",
      properties: { q: { type: "string" }, other: { type: "string" }, another: { type: "string" } },
      required: ["q"],
      additionalProperties: false,
      ...unsupported,
    }
    const original = JSON.stringify(schema)
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        pluginTools: [entry("schema", { jsonSchema: schema })],
      },
      "schema"
    )!
    await expect(runTool(result.tools.schema, { q: "x", other: "legal" })).resolves.toBe("executed")
    await expect(runTool(result.tools.schema, { q: 123 })).rejects.toThrow(/input/i)
    expect(result.tools.schema.inputSchema).toMatchObject({ jsonSchema: schema })
    expect(JSON.stringify(schema)).toBe(original)
  })

  it("relaxes nested schema keywords without deleting property names or literal values", async () => {
    const literal = { if: "literal", then: "literal", dependentRequired: "literal" }
    const schema = {
      type: "object",
      properties: {
        if: { type: "string" },
        literal: { type: "object", default: literal },
        nested: {
          type: "array",
          items: {
            type: "object",
            properties: { value: { type: "integer" } },
            required: ["value"],
            additionalProperties: false,
            if: { required: ["value"] },
            then: { properties: { value: { minimum: 0 } } },
          },
        },
      },
      required: ["if", "literal", "nested"],
      additionalProperties: false,
    }
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        pluginTools: [entry("nested", { jsonSchema: schema })],
      },
      "schema"
    )!
    await expect(
      runTool(result.tools.nested, { if: "property", nested: [{ value: 1 }] })
    ).resolves.toBe("executed")
    expect(handlePluginToolExec).toHaveBeenCalledWith(
      expect.objectContaining({ args: { if: "property", literal, nested: [{ value: 1 }] } })
    )
    await expect(
      runTool(result.tools.nested, { if: "property", literal, nested: [{ value: "bad" }] })
    ).rejects.toThrow(/input/i)
  })

  it("excludes only the unconvertible schema and keeps its neighbors executable", async () => {
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        pluginTools: [
          entry("before"),
          entry("broken.schema", { jsonSchema: { type: "object", unevaluatedProperties: false } }),
          entry("after"),
        ],
      },
      "schema"
    )!
    expect(Object.keys(result.tools)).toEqual(["before", "after"])
    expect([...result.aliases.values()]).not.toContain("broken.schema")
    await expect(runTool(result.tools.before, { q: "x" })).resolves.toBe("executed")
    await expect(runTool(result.tools.after, { q: "x" })).resolves.toBe("executed")
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("schema"),
      expect.objectContaining({ names: "broken.schema" })
    )
  })
})

describe("standalone sidecar policy parity", () => {
  it.each(["allow", "ask", "deny"] as const)(
    "prefers an exact %s rule to a wildcard",
    (verdict) => {
      const rules = {
        "*": verdict === "deny" ? "allow" : "deny",
        "mcp__cognia-plugin-tools__artifact_read": verdict,
      } as const
      const actual = standaloneRulesetVerdict({ permissionRuleset: rules }, "artifact_read", {})
      expect(actual).toBe(resolveForToolCall(rules, "mcp__cognia-plugin-tools__artifact_read", {}))
    }
  )
  it.each([
    ["artifact_read", {}, "ask"],
    ["artifact_read", { permissionMode: "bypassPermissions" }, "allow"],
    ["artifact_read", { permissionMode: "dontAsk" }, "deny"],
    ["artifact_read", { permissionMode: "plan" }, "deny"],
    ["load_skill", { permissionMode: "plan" }, "allow"],
    ["load_skill_resource", { permissionMode: "plan" }, "allow"],
    ["ask_user", {}, "allow"],
    ["sandbox_write", { permissionMode: "acceptEdits" }, "allow"],
    ["write", { permissionMode: "acceptEdits" }, "ask"],
    [
      "artifact_read",
      { permissionRuleset: { "mcp__cognia-plugin-tools__artifact_read": "allow" } },
      "allow",
    ],
    [
      "artifact_read",
      {
        permissionRuleset: { "mcp__cognia-plugin-tools__artifact_read": "deny" },
        permissionMode: "bypassPermissions",
      },
      "deny",
    ],
    ["artifact_read", { alwaysAllowTools: ["mcp__cognia-plugin-tools__artifact_read"] }, "allow"],
    [
      "vendor_a__create_issue",
      {
        permissionMode: "bypassPermissions",
        permissionRuleset: { "*": "allow" },
        alwaysExplicitGithubWritesMode: "enforce",
        alwaysExplicitGithubTools: ["vendor_a__create_issue"],
      },
      "ask",
    ],
    [
      "vendor_b__create_issue",
      {
        permissionMode: "bypassPermissions",
        alwaysExplicitGithubWritesMode: "enforce",
        alwaysExplicitGithubTools: ["vendor_a__create_issue"],
      },
      "allow",
    ],
    [
      "browser_set_files",
      {
        permissionMode: "bypassPermissions",
        pluginTools: [{ ...entry("browser_set_files"), requiresApproval: true }],
      },
      "ask",
    ],
  ] as const)("matches the sidecar for %s with %j", async (name, policy, expected) => {
    const options = policy as unknown as SendOptions
    const manifest = options.pluginTools?.[0] ?? entry(name)
    expect(standalonePermissionDecision(options, manifest, {})).toBe(expected)
    let asked = false
    const pending = new Map()
    const gate = createToolPermissionGate({
      sessionId: "parity",
      sendOptions: options,
      pendingApprovals: pending,
      emit: (frame) => {
        asked = true
        queueMicrotask(() =>
          pending.get(frame.requestId)?.resolve({ behavior: "allow", updatedInput: {} })
        )
      },
    })
    if (expected === "deny")
      await expect(gate(`mcp__cognia-plugin-tools__${name}`, {})).rejects.toThrow()
    else {
      await expect(gate(`mcp__cognia-plugin-tools__${name}`, {})).resolves.toEqual({})
      expect(asked).toBe(expected === "ask")
    }
  })

  it.each(["git status", "git push", "echo $(git push)", 'git commit -m "a; b"', "g\\it push"])(
    "matches command rules for %s",
    (command) => {
      const permissionRuleset = {
        Bash: { "git status": "allow", "git push": "deny", "git commit*": "allow" },
      } as const
      expect(standaloneRulesetVerdict({ permissionRuleset }, "Bash", { command })).toBe(
        resolveForToolCall(permissionRuleset, "Bash", { command })
      )
    }
  )
})

describe("standalone model names and output", () => {
  it.each(["ocr.extract", "has space", "🙂", "a".repeat(140), `${"a".repeat(139)}b`])(
    "matches sidecar name sanitizing for %s",
    (name) => {
      expect(sanitizeStandaloneToolName(name)).toBe(sanitizeModelToolName(name))
      expect(sanitizeStandaloneToolName(name)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    }
  )

  it("reserves originals, disambiguates aliases and dispatches the original name", async () => {
    const names = [
      "ocr.extract",
      "ocr_extract",
      "ocr extract",
      "a".repeat(140),
      `${"a".repeat(139)}b`,
    ]
    const result = buildStandaloneTools(
      { permissionMode: "bypassPermissions", pluginTools: names.map((n) => entry(n)) },
      "s1"
    )!
    expect(new Set(Object.keys(result.tools)).size).toBe(names.length)
    expect(result.tools.ocr_extract.description).toBe("ocr_extract description")
    const modelName = [...result.aliases].find(([, original]) => original === "ocr.extract")![0]
    handlePluginToolExec.mockResolvedValue({ result: "text" })
    await runTool(result.tools[modelName], { q: "x" })
    expect(handlePluginToolExec).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ocr.extract" })
    )
  })

  it.each([
    { content: [{ type: "image", data: "YWJj", mimeType: "image/png" }] },
    { content: [{ type: "audio", data: "YWJj", mimeType: "audio/wav" }] },
    {
      content: [
        {
          type: "resource",
          resource: { blob: "YWJj", mimeType: "application/pdf", name: "file.pdf" },
        },
      ],
    },
    { content: [{ type: "resource", resource: { text: "resource text" } }] },
    { content: [{ type: "resource_link", uri: "https://example.test/file", name: "file" }] },
  ])("matches sidecar content output for %j", (output) => {
    expect(standaloneToModelOutput({ output })).toEqual(builtinToModelOutput({ output }))
  })

  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  }
  it("rejects invalid model input through the real SDK validator", async () => {
    const result = buildStandaloneTools(
      { permissionMode: "bypassPermissions", pluginTools: [entry("search")] },
      "s1"
    )!
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          { type: "tool-call", toolCallId: "invalid", toolName: "search", input: '{"q":123}' },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      },
    })
    const response = await generateText({
      model,
      tools: result.tools,
      prompt: "Exercise validation",
      telemetry: { isEnabled: false },
    })
    expect(handlePluginToolExec).not.toHaveBeenCalled()
    expect(response.content).toContainEqual(expect.objectContaining({ type: "tool-error" }))
  })

  it("gives the next real SDK model step image data rather than a JSON envelope", async () => {
    handlePluginToolExec.mockResolvedValue({
      result: { content: [{ type: "image", data: "YWJj", mimeType: "image/png" }] },
    })
    const tools = buildStandaloneTools(
      { permissionMode: "bypassPermissions", pluginTools: [entry("image")] },
      "s1"
    )!.tools
    let calls = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        calls++
        return {
          content:
            calls === 1
              ? [
                  {
                    type: "tool-call" as const,
                    toolCallId: "image-call",
                    toolName: "image",
                    input: '{"q":"x"}',
                  },
                ]
              : [{ type: "text" as const, text: "answer" }],
          finishReason: {
            unified: calls === 1 ? ("tool-calls" as const) : ("stop" as const),
            raw: "stop",
          },
          usage,
          warnings: [],
        }
      },
    })
    await generateText({
      model,
      tools,
      prompt: "Inspect image",
      stopWhen: isStepCount(2),
      telemetry: { isEnabled: false },
    })
    expect(model.doGenerateCalls).toHaveLength(2)
    const toolMessage = model.doGenerateCalls[1].prompt.find((message) => message.role === "tool")!
    expect(toolMessage.content).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        output: {
          type: "content",
          value: [{ type: "file", mediaType: "image/png", data: { type: "data", data: "YWJj" } }],
        },
      })
    )
  })
})

describe("isUsableStandaloneToolName", () => {
  it.each(["web_search", "web-fetch", "Tool123", "a".repeat(64)])("accepts %s", (name) => {
    expect(isUsableStandaloneToolName(name)).toBe(true)
  })

  it.each(["", "has space", "dots.in.name", "emoji🙂", "a".repeat(65)])("rejects %s", (name) => {
    expect(isUsableStandaloneToolName(name)).toBe(false)
  })
})

describe("buildStandaloneTools", () => {
  it("exposes no executable tools when the runtime tool surface is disabled", () => {
    expect(
      buildStandaloneTools(
        { toolSurface: "none", pluginTools: [entry("web_search")] },
        "support-session"
      )
    ).toBeUndefined()
    expect(handlePluginToolExec).not.toHaveBeenCalled()
  })

  it("returns undefined when the turn carries no tool manifest", () => {
    expect(buildStandaloneTools({}, "s1")).toBeUndefined()
    expect(buildStandaloneTools({ pluginTools: [] }, "s1")).toBeUndefined()
  })

  it("projects each manifest entry onto a described AI SDK tool", () => {
    const result = buildStandaloneTools(
      { pluginTools: [entry("web_search"), entry("web_fetch")] },
      "s1"
    )

    expect(Object.keys(result!.tools)).toEqual(["web_search", "web_fetch"])
    expect(result!.aliases.size).toBe(0)
    expect((result!.tools.web_search as { description?: string }).description).toBe(
      "web_search description"
    )
  })

  it("reversibly sanitizes provider-invalid names", () => {
    const result = buildStandaloneTools(
      { pluginTools: [entry("bad name"), entry("web_search")] },
      "s1"
    )

    expect(Object.keys(result!.tools)).toEqual(["bad_name", "web_search"])
    expect(result!.aliases.get("bad_name")).toBe("bad name")
  })

  it("preserves a manifest containing only renamed tools", () => {
    expect(
      buildStandaloneTools({ pluginTools: [entry("bad name")] }, "s1")!.aliases.get("bad_name")
    ).toBe("bad name")
  })

  it("keeps the first registration when a name is duplicated", () => {
    const result = buildStandaloneTools(
      {
        pluginTools: [
          entry("web_search", { description: "builtin" }),
          entry("web_search", { description: "plugin duplicate" }),
        ],
      },
      "s1"
    )

    expect(Object.keys(result!.tools)).toHaveLength(1)
    expect((result!.tools.web_search as { description?: string }).description).toBe("builtin")
  })

  it("executes through the renderer tool handler with the session + call id", async () => {
    handlePluginToolExec.mockResolvedValue({
      type: "plugin_tool_response",
      sessionId: "s1",
      toolUseId: "call-9",
      result: { hits: 3 },
    })

    const result = buildStandaloneTools(
      {
        pluginTools: [entry("web_search")],
        sandboxRuntimeRef: "sandbox-runtime:standalone",
        permissionMode: "bypassPermissions",
      },
      "s1"
    )
    await expect(runTool(result!.tools.web_search, { q: "cognia" }, "call-9")).resolves.toEqual({
      hits: 3,
    })

    expect(handlePluginToolExec).toHaveBeenCalledWith({
      type: "plugin_tool_exec",
      sessionId: "s1",
      toolUseId: "call-9",
      name: "web_search",
      args: { q: "cognia" },
      // The entry's relay deadline (the 120s default) travels as the signal.
      abortSignal: expect.any(AbortSignal),
      sandboxRuntimeRef: "sandbox-runtime:standalone",
    })
  })

  it("projects spawn_task through the same renderer executor", async () => {
    handlePluginToolExec.mockResolvedValue({ result: { ok: true, taskSessionId: "task-1" } })
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        pluginTools: [
          entry("spawn_task", {
            jsonSchema: {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            },
          }),
        ],
      },
      "parent-1"
    )

    await expect(runTool(result!.tools.spawn_task, { title: "Fix cleanup" })).resolves.toEqual({
      ok: true,
      taskSessionId: "task-1",
    })
    expect(handlePluginToolExec).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "parent-1", name: "spawn_task" })
    )
  })

  it("normalises missing args to an empty object", async () => {
    handlePluginToolExec.mockResolvedValue({ result: "ok" })
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        pluginTools: [entry("web_search", { jsonSchema: { type: "object" } })],
      },
      "s1"
    )

    await runTool(result!.tools.web_search, undefined as unknown as Record<string, unknown>)

    expect(handlePluginToolExec.mock.calls[0][0].args).toEqual({})
  })

  it("rethrows a handler error so the SDK emits a tool-error part", async () => {
    handlePluginToolExec.mockResolvedValue({ error: "blocked by the PII redaction gate" })
    const result = buildStandaloneTools(
      {
        permissionMode: "bypassPermissions",
        pluginTools: [entry("web_search", { jsonSchema: { type: "object" } })],
      },
      "s1"
    )

    await expect(runTool(result!.tools.web_search, { q: "x" })).rejects.toThrow(
      "blocked by the PII redaction gate"
    )
  })

  it("bounds the loop so a mis-prompted model cannot run away", () => {
    expect(STANDALONE_MAX_STEPS).toBeGreaterThan(1)
    expect(STANDALONE_MAX_STEPS).toBeLessThanOrEqual(16)
  })
})
