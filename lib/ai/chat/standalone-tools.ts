// Standalone (BYOK) tool bridge — projects the renderer-executable tool
// manifest onto AI SDK tool definitions so a phone with no paired desktop can
// still run a real agent loop.
//
// Why this is a bridge and not a new tool layer:
//
//  - `resolveSendOptions` (`lib/claude/build-options.ts`) already assembles
//    `sendOptions.pluginTools` — the full catalog of tools the sidecar proxies
//    BACK to the renderer (web_search / web_fetch, skills, slash commands,
//    editor, team, and every plugin-registered tool), each carrying a name, a
//    description, and a JSON Schema.
//  - `handlePluginToolExec` (`lib/claude/plugin-tool-ipc.ts`) already executes
//    exactly that catalog in the renderer, behind the `@cognia/redact` PII gate
//    and the per-plugin rate limiter.
//  - `createSdkEventMapper` already maps AI SDK `tool-call` / `tool-result` /
//    `tool-error` / `start-step` / `finish-step` parts onto the renderer's
//    `tool_use` / `tool_result` envelopes.
//
// All three halves existed; `runStandaloneTurn` was simply never handed a
// `tools` map. This module is the missing wire, so standalone mode inherits the
// same catalog, the same executor, and the same PII gate as the paired path
// rather than growing a parallel one.
//
// Platform boundary: tools whose renderer handler needs the desktop (Pro IDE
// editor reads, the terminal dock's PTY) only enter `pluginTools` when
// `resolveSendOptions` enables that capability, so a phone simply never sees
// them. If one does slip through, its handler throws and the failure surfaces
// as a labelled `tool-error` block — never a silent no-op.

import { jsonSchema, tool, type Tool, type ToolSet } from "ai"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { z } from "zod"
import { loggers } from "@cognia/logging"

import type { ClaudeEvent, SendOptions } from "@cognia/agent-config-types"
import { handlePluginToolExec } from "@/lib/claude/plugin-tool-ipc"
import { requestLocalToolApproval } from "@/lib/claude/ipc"
import { resolvePermissionDetailed, type PermissionVerdict } from "@/lib/claude/permissions/ruleset"
import { canonicalizeCommand, splitCommandSegments } from "@/lib/claude/permissions/command-parse"

/** Keep standalone provider/credit use bounded to the product's eight-step ceiling. */
export const STANDALONE_MAX_STEPS = 8
const MAX_TOOL_NAME_LENGTH = 64
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

export function isUsableStandaloneToolName(name: string): boolean {
  return VALID_TOOL_NAME.test(name)
}

/** Browser-safe mirror of sidecar policy/tool-catalog/model-names.ts. */
export function sanitizeStandaloneToolName(name: string): string {
  const hash = () => bytesToHex(sha256(new TextEncoder().encode(name))).slice(0, 7)
  let safe = name.replace(/[^a-zA-Z0-9_-]+/g, "_")
  if (safe.replace(/_/g, "") === "") safe = `tool_${hash()}`
  if (safe.length > MAX_TOOL_NAME_LENGTH) safe = `${safe.slice(0, 56)}_${hash()}`
  return safe
}

type ManifestEntry = NonNullable<SendOptions["pluginTools"]>[number] & {
  requiresApproval?: boolean
  requiresPerCallApproval?: boolean
  requiresHumanApproval?: boolean
}

const CLAUDE_ALIASES: Readonly<Record<string, string>> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  multi_edit: "MultiEdit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  ls: "LS",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
}
const PLAN_PLUGIN_TOOLS = new Set([
  "dispatch_agent",
  "Task",
  "load_skill",
  "load_skill_resource",
  "ask_user",
])
const ACCEPT_EDITS_PLUGIN_TOOLS = new Set(["sandbox_write", "sandbox_edit", "sandbox_text_editor"])
const VERDICT_RANK = { allow: 0, ask: 1, deny: 2 }

function toolIdentity(name: string): { bare: string; server: string; names: string[] } {
  const bare = name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name
  const server = name.startsWith("mcp__") ? (name.split("__")[1] ?? "") : "cognia-plugin-tools"
  const canonical = Object.entries(CLAUDE_ALIASES).find(([, alias]) => alias === bare)?.[0] ?? bare
  return {
    bare,
    server,
    names: [
      ...new Set([
        name,
        bare,
        canonical,
        `mcp__cognia-plugin-tools__${bare}`,
        `mcp__cognia-plugin-tools__${canonical}`,
        ...(CLAUDE_ALIASES[canonical]
          ? [CLAUDE_ALIASES[canonical], `mcp__cognia-tools__${canonical}`]
          : []),
      ]),
    ],
  }
}

/** Unattended profiles need the host's permission-class authority. */
export function hasUnsupportedStandalonePolicy(options: SendOptions): boolean {
  if (options.toolSurface === "none") return false
  return Boolean(options.permissionProfile)
}

// Standard path keys and nested operation lists from sidecar confinement's
// collectPathTargets. A read-only metadata tool stays usable until it names
// a filesystem target that requires native canonicalisation.
const HOST_PATH_KEYS = new Set([
  "file_path",
  "filePath",
  "target",
  "target_path",
  "workdir",
  "path",
  "notebook_path",
  "source",
  "source_path",
  "destination",
  "destination_path",
  "dest",
  "oldPath",
  "newPath",
  "pathA",
  "pathB",
  "directory",
  "dir",
  "output",
  "output_path",
  "cwd",
])
const NESTED_PATH_OPERATIONS = ["edits", "files", "operations", "commands"]

function hasHostPathTarget(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  const obj = input as Record<string, unknown>
  const isPath = (value: unknown) => typeof value === "string" && Boolean(value.trim())
  if ([...HOST_PATH_KEYS].some((key) => isPath(obj[key]))) return true
  if (Array.isArray(obj.paths) && obj.paths.some(isPath)) return true
  return NESTED_PATH_OPERATIONS.some((key) => {
    const operations = obj[key]
    return Array.isArray(operations) && operations.some(hasHostPathTarget)
  })
}

function needsHostFilesystemPolicy(
  options: SendOptions,
  entry: ManifestEntry,
  input?: Record<string, unknown>
): boolean {
  const scope = options.builtinProcessSandbox
  const confined = options.confinement?.enabled && options.confinement.roots?.some(Boolean)
  if (!scope && !confined) return false
  // The sandbox-scope step hardcodes these aliases even without manifest
  // access metadata. Other plugin tools opt in via buildPluginAccessMap.
  if (["sandbox_write", "sandbox_edit", "sandbox_text_editor", "sandbox_bash"].includes(entry.name))
    return Boolean(scope)
  const properties = (entry.jsonSchema as { properties?: object }).properties
  return (
    entry.access === "write" ||
    (entry.access === "read" &&
      (Boolean(entry.pathParams?.some((key) => typeof key === "string" && key.trim())) ||
        Boolean(
          properties &&
          Object.keys(properties).some((key) => HOST_PATH_KEYS.has(key) || key === "paths")
        ) ||
        hasHostPathTarget(input)))
  )
}

const RELAXED_SCHEMA_KEYWORDS = new Set([
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
])
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependencies",
])
const SCHEMA_CHILD_KEYS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contains",
  "propertyNames",
  "not",
  "contentSchema",
])
const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])

/** Relax only unsupported schema keywords, preserving names and literal data. */
function relaxUnsupportedSchema(schema: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema
  if (seen.has(schema)) return seen.get(schema)
  const result: Record<string, unknown> = Object.create(null)
  seen.set(schema, result)
  for (const [key, value] of Object.entries(schema)) {
    if (RELAXED_SCHEMA_KEYWORDS.has(key)) continue
    if (SCHEMA_MAP_KEYS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [name, relaxUnsupportedSchema(child, seen)])
      )
    } else if ((SCHEMA_ARRAY_KEYS.has(key) || key === "items") && Array.isArray(value)) {
      result[key] = value.map((child) => relaxUnsupportedSchema(child, seen))
    } else {
      result[key] = SCHEMA_CHILD_KEYS.has(key) ? relaxUnsupportedSchema(value, seen) : value
    }
  }
  return result
}

/** Resolve only explicit rules: baked-in *:allow must never approve a call. */
export function standaloneRulesetVerdict(
  options: SendOptions,
  name: string,
  input: Record<string, unknown>
): PermissionVerdict {
  const { bare, names } = toolIdentity(name)
  const isShell = ["bash", "Bash", "shell_execute_advanced", "start_process"].includes(bare)
  const command =
    bare === "start_process"
      ? [input.program, ...(Array.isArray(input.args) ? input.args : [])]
          .filter((v) => typeof v === "string")
          .join(" ")
      : bare === "shell_execute_advanced"
        ? [input.command, ...(Array.isArray(input.args) ? input.args : [])]
            .filter((v) => typeof v === "string")
            .join(" ")
        : input.command
  const target = isShell ? command : (input.file_path ?? input.path)
  const text = typeof target === "string" ? target : ""
  const segments = isShell ? splitCommandSegments(text).map((s) => s.raw) : []
  const targets = segments.length ? segments : [text]
  const explicitVerdict = (value: string): PermissionVerdict | undefined => {
    let matched: PermissionVerdict | undefined
    for (const candidate of names) {
      const rule = options.permissionRuleset?.[candidate]
      if (rule === undefined) continue
      const r = resolvePermissionDetailed(candidate, value, [{ [candidate]: rule }])
      if (r.layer > 0 && (!matched || VERDICT_RANK[r.verdict] > VERDICT_RANK[matched]))
        matched = r.verdict
    }
    // Like the sidecar resolver, an exact tool match outranks the any-tool rule.
    if (matched) return matched
    const wildcard = options.permissionRuleset?.["*"]
    if (wildcard === undefined) return undefined
    const r = resolvePermissionDetailed(name, value, [{ "*": wildcard }])
    return r.layer > 0 ? r.verdict : undefined
  }
  let worst: PermissionVerdict = "allow"
  for (const value of targets) {
    const verdict = explicitVerdict(value) ?? "ask"
    if (isShell && explicitVerdict(canonicalizeCommand(value)) === "deny") return "deny"
    if (VERDICT_RANK[verdict] > VERDICT_RANK[worst]) worst = verdict
  }
  return worst
}

function passesToolPolicy(options: SendOptions, name: string): boolean {
  const { names, bare, server } = toolIdentity(name)
  if (options.toolSurface === "none") return false
  if (names.some((n) => options.disallowedTools?.includes(n))) return false
  if (options.allowedTools?.length && !names.some((n) => options.allowedTools!.includes(n)))
    return false
  if (options.permissionMode === "plan" && !PLAN_PLUGIN_TOOLS.has(bare)) return false
  const rules = options.permissionRuleset
  // Conditional target rules stay offered; execution checks the actual arguments.
  const alwaysDenies = (rule: unknown): boolean =>
    rule === "deny" ||
    Boolean(
      rule &&
      typeof rule === "object" &&
      (Object.hasOwn(rule, "*") || Object.hasOwn(rule, "**")) &&
      Object.values(rule).every((verdict) => verdict === "deny")
    )
  if (names.some((n) => alwaysDenies(rules?.[n]))) return false
  if (alwaysDenies(rules?.["*"]) && !names.some((n) => rules?.[n] !== undefined)) return false
  const allowlist = options.mcpToolAllowlist?.[server]
  return !allowlist || allowlist.includes(bare)
}

function mustAsk(options: SendOptions, entry: ManifestEntry): boolean {
  const { bare } = toolIdentity(entry.name)
  const normalize = (name: string) => name.split("__").at(-1)!.toLowerCase()
  return (
    entry.requiresApproval === true ||
    entry.requiresPerCallApproval === true ||
    entry.requiresHumanApproval === true ||
    (options.alwaysExplicitToolsMode !== "observe" &&
      Boolean(options.alwaysExplicitTools?.some((n) => normalize(n) === normalize(bare)))) ||
    (options.alwaysExplicitGithubWritesMode !== "observe" &&
      Boolean(
        options.alwaysExplicitGithubTools?.some((listed) => {
          const name = entry.name.trim().toLowerCase()
          const full = listed.trim().toLowerCase()
          return Boolean(full) && (name === full || name.endsWith(`__${full}`))
        })
      ))
  )
}

/** Minimal pure AI-SDK plugin ladder; parity is pinned in standalone-tools.test.ts. */
export function standalonePermissionDecision(
  options: SendOptions,
  entry: ManifestEntry,
  input: Record<string, unknown>
): PermissionVerdict {
  if (!passesToolPolicy(options, entry.name) || needsHostFilesystemPolicy(options, entry, input))
    return "deny"
  const verdict = standaloneRulesetVerdict(options, entry.name, input)
  if (verdict === "deny") return "deny"
  const { bare, names } = toolIdentity(entry.name)
  const perCall = mustAsk(options, entry)
  if (options.permissionMode === "plan" && !perCall) return "allow"
  const granted =
    verdict === "allow" ||
    names.some(
      (n) => options.suppressApprovalForTools?.includes(n) || options.alwaysAllowTools?.includes(n)
    )
  if (options.permissionMode === "dontAsk") return !perCall && granted ? "allow" : "deny"
  if (
    !perCall &&
    (options.permissionMode === "bypassPermissions" ||
      granted ||
      bare === "ask_user" ||
      (options.permissionMode === "acceptEdits" && ACCEPT_EDITS_PLUGIN_TOOLS.has(bare)))
  )
    return "allow"
  return "ask"
}

type ModelOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>
type ModelPart = Extract<ModelOutput, { type: "content" }>["value"][number]
interface McpBlock {
  type?: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  name?: string
  title?: string
  resource?: { text?: string; blob?: string; mimeType?: string; name?: string; title?: string }
}

/** Match the installed SDK's tagged file-data union for image/audio/resources. */
export function standaloneToModelOutput({ output }: { output: unknown }): ModelOutput {
  if (typeof output === "string") return { type: "text", value: output }
  const content = (output as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return { type: "json", value: output as never }
  const blocks = content.filter((b): b is McpBlock => Boolean(b && typeof b === "object"))
  if (blocks.every((b) => b.type === "text"))
    return { type: "text", value: blocks.map((b) => b.text ?? "").join("\n") }
  const value: ModelPart[] = []
  const binary = (data: string, mediaType: string, filename?: string): ModelPart => ({
    type: "file",
    data: { type: "data", data },
    mediaType,
    ...(filename ? { filename } : {}),
  })
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") value.push({ type: "text", text: b.text })
    else if (b.type === "image" && b.data) value.push(binary(b.data, b.mimeType ?? "image/png"))
    else if (b.type === "audio" && b.data) value.push(binary(b.data, b.mimeType ?? "audio/mpeg"))
    else if (b.type === "resource" && b.resource) {
      const r = b.resource
      if (typeof r.text === "string") value.push({ type: "text", text: r.text })
      else if (typeof r.blob === "string")
        value.push(binary(r.blob, r.mimeType ?? "application/octet-stream", r.name ?? r.title))
    } else if (b.type === "resource_link" && typeof b.uri === "string") {
      const label = b.name || b.title
      value.push({ type: "text", text: `${label ? `${label}: ` : ""}${b.uri}` })
    }
  }
  return { type: "content", value }
}

export interface StandaloneToolsResult {
  tools: ToolSet
  /** Model-facing name -> original name, shared with the transcript mapper. */
  aliases: Map<string, string>
}

interface StandaloneApprovalContext {
  signal: AbortSignal
  emit(event: ClaudeEvent): void | Promise<void>
}

export function buildStandaloneTools(
  sendOptions: SendOptions,
  sessionId: string,
  approval?: StandaloneApprovalContext
): StandaloneToolsResult | undefined {
  if (sendOptions.toolSurface === "none") return undefined
  if (hasUnsupportedStandalonePolicy(sendOptions))
    throw new Error("Standalone cannot enforce the requested host permission policy")
  const entries = sendOptions.pluginTools
  if (!entries?.length) return undefined
  const tools: ToolSet = Object.create(null)
  const aliases = new Map<string, string>()
  const seen = new Set<string>()
  const excludedHostTools: string[] = []
  const excludedSchemaTools: string[] = []
  // Reserve safe originals before renaming so dotted names cannot steal them.
  const reserved = new Set(entries.map((e) => e.name).filter(isUsableStandaloneToolName))
  const turnId = sendOptions.turnId
  const attemptId = sendOptions.execution?.identity?.attemptId

  for (const rawEntry of entries) {
    const entry: ManifestEntry = rawEntry
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    if (!passesToolPolicy(sendOptions, entry.name)) continue
    if (needsHostFilesystemPolicy(sendOptions, entry)) {
      excludedHostTools.push(entry.name)
      continue
    }
    // Zod validates without Ajv's runtime code generation, which the webview's
    // CSP forbids. Retry its unsupported dependency/conditional keywords
    // permissively, keeping the original model-facing schema unchanged.
    let validator: z.ZodType
    try {
      validator = z.fromJSONSchema(entry.jsonSchema as Parameters<typeof z.fromJSONSchema>[0])
    } catch {
      try {
        validator = z.fromJSONSchema(
          relaxUnsupportedSchema(entry.jsonSchema) as Parameters<typeof z.fromJSONSchema>[0]
        )
      } catch {
        excludedSchemaTools.push(entry.name)
        continue
      }
    }
    let modelName = entry.name
    if (!isUsableStandaloneToolName(modelName)) {
      modelName = sanitizeStandaloneToolName(entry.name)
      const stem = modelName
      for (let n = 2; reserved.has(modelName); n++) {
        const suffix = `_${n}`
        modelName = `${stem.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`
      }
      reserved.add(modelName)
      aliases.set(modelName, entry.name)
    }
    const validate = (input: unknown) => {
      const parsed = validator.safeParse(input)
      if (!parsed.success)
        return {
          success: false as const,
          error: new Error(`Invalid tool input: ${parsed.error.message}`),
        }
      if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
        return {
          success: false as const,
          error: new Error("Invalid tool input: expected an object"),
        }
      }
      return { success: true as const, value: parsed.data as Record<string, unknown> }
    }
    const parse = (input: unknown) => {
      const result = validate(input)
      if (!result.success) throw result.error
      return result.value
    }
    tools[modelName] = tool({
      description: entry.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        entry.jsonSchema as Parameters<typeof jsonSchema>[0],
        { validate }
      ),
      toModelOutput: standaloneToModelOutput,
      execute: async (args, options) => {
        const signal =
          options.abortSignal && approval?.signal && options.abortSignal !== approval.signal
            ? AbortSignal.any([options.abortSignal, approval.signal])
            : (options.abortSignal ?? approval?.signal)
        signal?.throwIfAborted()
        let input = parse(args ?? {})
        const decision = standalonePermissionDecision(sendOptions, entry, input)
        if (decision === "deny")
          throw new Error(`denied by standalone permission policy: ${entry.name}`)
        if (decision === "ask") {
          if (!approval || !signal)
            throw new Error(`denied: no approval channel to authorize "${entry.name}"`)
          const perCall = mustAsk(sendOptions, entry)
          const answer = await requestLocalToolApproval({
            sessionId,
            toolName: entry.name,
            toolUseId: options.toolCallId,
            input,
            signal,
            ttlMs: sendOptions.approvalTtlMs,
            emit: approval.emit,
            requiresApproval: entry.requiresApproval,
            requiresHumanApproval: entry.requiresHumanApproval,
            ...(perCall
              ? { requiresPerCallApproval: true, suppressAlwaysAllowRule: true, defaultToNo: true }
              : {}),
          })
          if (!answer.allowed) throw new Error(`denied: ${entry.name}`)
          input = parse(answer.input)
          // An approval cannot authorize a rewritten target that policy denies.
          if (standalonePermissionDecision(sendOptions, entry, input) === "deny")
            throw new Error(`denied by standalone permission policy: ${entry.name}`)
        }
        signal?.throwIfAborted()
        const response = await handlePluginToolExec({
          type: "plugin_tool_exec",
          sessionId,
          toolUseId: options.toolCallId,
          name: entry.name,
          args: input,
          ...(signal ? { abortSignal: signal } : {}),
          ...(turnId !== undefined ? { turnId } : {}),
          ...(attemptId !== undefined ? { attemptId } : {}),
          ...(sendOptions.sandboxRuntimeRef
            ? { sandboxRuntimeRef: sendOptions.sandboxRuntimeRef }
            : {}),
        })
        if (response.error) throw new Error(response.error)
        const result = response.result as { content?: unknown; isError?: unknown } | null
        if (result?.isError === true && Array.isArray(result.content)) {
          const text = (result.content as McpBlock[])
            .filter((b) => b?.type === "text")
            .map((b) => b.text)
            .join("\n")
          throw new Error(text || JSON.stringify(result))
        }
        return response.result
      },
    })
  }
  if (excludedHostTools.length)
    loggers.chat.warn("standalone: excluded tools requiring host filesystem policy", {
      names: excludedHostTools.join(", "),
    })
  if (excludedSchemaTools.length)
    loggers.chat.warn("standalone: excluded tools with unsupported JSON schema", {
      names: excludedSchemaTools.join(", "),
    })
  return Object.keys(tools).length ? { tools, aliases } : undefined
}
