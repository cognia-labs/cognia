// AI SDK tool bridge for the non-Anthropic dispatch path.
//
// The Anthropic dispatcher hands built-in tools + plugin tools to the Claude
// Agent SDK as in-process MCP servers. The AI SDK has no MCP-server concept for
// `streamText`, so we convert the SAME built-in tool definitions (and the
// renderer-proxied plugin tools) into native AI SDK `tool()` objects keyed by
// name. This is what lets local / OpenAI / Gemini models actually call tools in
// the main chat — previously the ai-sdk path was text-only.
//
// Tool execution runs through the rail's permission gate
// (src/policy/permission/ai-sdk-gate.ts), so a local model can't silently run
// shell/process tools.

import { tool, jsonSchema } from "ai"
import type { Tool } from "ai"
import { z } from "zod"
import { randomUUID } from "node:crypto"

import { collectCogniaToolDefs } from "../builtin/registry.ts"
import {
  BUILTIN_SERVER_NAME as SERVER_NAME,
  READ_ONLY_TOOL_NAMES,
} from "../../policy/tool-catalog/catalog.ts"
import { PLUGIN_TOOLS_SERVER_NAME } from "../../policy/tool-catalog/names.ts"
import {
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
  toolBudgetMessage,
} from "../middleware/read-only-timeout.ts"

import { awaitPluginToolResponse } from "../plugin/proxy.ts"
import { jsonSchemaPropToZod } from "../plugin/json-schema-zod.ts"
import { parseToolArgs } from "../kernel/args.ts"
import { createToolPermissionGate } from "../../policy/permission/ai-sdk-gate.ts"
import { createPreMutationReporter } from "../middleware/file-checkpoint.ts"
import { createDoomLoopGuard } from "../../policy/doom-loop.ts"
import { prepareModelToolOutput as assertModelSafeToolOutput } from "../../policy/content-safety.ts"
import { assertSafeExternalContent } from "@cognia/content-safety"
import { markAiSdkToolSource } from "./ai-sdk-tool-search.ts"
import { builtinToModelOutput, callToolResultToText, hasRichContentBlock } from "./ai-sdk-output.ts"
import { passesToolLists } from "./allow-list.ts"
import type { ToolDefinition } from "../kernel/define.ts"
import type { ReadTracker } from "../state/read-tracker.ts"
import type { SessionTaskStore } from "../state/tasks.ts"
import type { HostRpcCaller, SessionBgShellRegistry } from "../state/host-background-shells.ts"
import type { PendingPluginToolCalls, PluginToolManifestEntry } from "../plugin/proxy.ts"
import type { ToolPermissionGate } from "../../policy/permission/ai-sdk-gate.ts"
import type { PendingApproval } from "../../policy/permission/approval.ts"
import type { PermissionSendOptions } from "../../policy/permission/ladder.ts"
import type { DoomLoopGuard } from "../../policy/doom-loop.ts"
import type { ProcessSandboxScope } from "../../platform/process/exec.ts"
import type { LazyLspResolver } from "../../services/lsp/lazy-resolver.ts"
import type { CodeGraphIndex } from "../../services/code-graph/index-service.ts"
import type { VerificationBudget } from "../../shared/verification-budget.ts"
import type { WorkerToolAdmission } from "../../policy/fence/admission.ts"

/** An AI SDK tool as this adapter builds it. */
type AiSdkTool = Tool

// Runtime classification uses the adapter's actual registered object, never a
// model-facing name or self-declared tool metadata.
const toolPolicyNames = new WeakMap<object, string>()
export function aiSdkToolPolicyName(definition: object): string | undefined {
  return toolPolicyNames.get(definition)
}

/** The PostToolUse review: the updated output, or undefined/null to pass it through. */
export type ToolOutputReview = (
  namespaced: string,
  toolCallId: string | undefined,
  output: unknown,
  isError: boolean
) => unknown

/** The send-spec fields the adapter reads, beyond what the permission gate reads. */
export interface AiSdkToolSendOptions extends PermissionSendOptions {
  contentSafety?: { injectionProtection: boolean }
  toolSurface?: unknown
  allowedTools?: unknown
  disallowedTools?: unknown
  toolExecutionTimeoutMs?: unknown
  builtinTools?: Readonly<Record<string, boolean | undefined>> | null
  model?: string
  provider?: string
  planTools?: unknown
  sandboxRuntimeRef?: unknown
  turnId?: string
  /** Snapshot files before a mutating call runs (see `file-checkpoint.ts`). */
  fileCheckpointFrames?: boolean
  additionalDirectories?: unknown
  execution?: {
    composition?: { toolPresentation?: string }
    identity?: { attemptId?: string }
  }
}

// Per-tool execution deadline for READ-ONLY built-ins on the ai-sdk path. The
// constant, the read-only gate, and the recoverable message all live in
// `../middleware/read-only-timeout.ts` so this channel and the Anthropic
// channel (`sdk-mcp.ts`) never drift. Here we bound the handler at
// EXECUTE time and REJECT on timeout so the AI SDK surfaces a `tool-error`; the
// Anthropic side wraps at registration time and returns an `isError` result.
// Exec tools (bash / shell / process / git-run) self-bound and are excluded.
// `0` disables it.

/**
 * Run a built-in tool handler under an optional execution deadline. Only
 * read-only tools are bounded (see {@link DEFAULT_BUILTIN_TOOL_TIMEOUT_MS});
 * everything else runs unbounded exactly as before. On timeout we reject so the
 * AI SDK surfaces a `tool-error`; the orphaned handler is left to settle and be
 * GC'd (read-only tools have no side effects to unwind). The gate runs BEFORE
 * this, so a slow human approval is never counted against the budget.
 *
 * `effective` is the gated/validated args; a `timeoutMs` of 0 / non-finite means
 * no net. `signal` is the step's abort signal, forwarded as `extra.signal` so a
 * handler can actually stop work on a user interrupt — `core-files/rg.ts` and
 * `ast-grep/run.ts` both accept one and, until now, no caller ever supplied
 * it, so an interrupt abandoned the promise while the child process kept
 * running.
 */
function runBuiltinHandler(
  def: Pick<ToolDefinition, "name" | "handler">,
  effective: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
  toolCallId?: string
): Promise<unknown> {
  const net = READ_ONLY_TOOL_NAMES.has(def.name) ? timeoutMs : 0
  const call = () =>
    Promise.resolve(def.handler(effective, { signal, ...(toolCallId ? { toolCallId } : {}) }))
  if (!Number.isFinite(net) || net <= 0) return call()
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<never>((_, reject) => {
    // Keep the timer REF'd: while a read-only handler is in flight we owe the AI
    // SDK a result, so the deadline must hold the event loop open until it fires
    // (or `call()` settles and we clearTimeout). An unref'd timer let the loop
    // drain mid-wait — the process could exit before the budget rejection was
    // ever surfaced, defeating the backstop. The timer is always cleared on
    // settle (the .finally below), so it never lingers; graceful shutdown is
    // driven by stdin-close → process.exit(), not timer GC.
    timer = setTimeout(() => {
      reject(new Error(toolBudgetMessage(def.name, net)))
    }, net)
  })
  return Promise.race([call(), deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Apply the PostToolUse review (renderer round-trip) to a tool's EXECUTE-layer
 * output — this is the only layer where a rewrite actually reaches the model:
 * streamText persists the execute return into the conversation, so a rewrite
 * applied later (e.g. on the fullStream tool-result event) is display-only.
 * `review` returns the updated output, or undefined/null to pass through.
 */
async function applyOutputReview(
  review: ToolOutputReview | undefined,
  namespaced: string,
  toolCallId: string | undefined,
  output: unknown,
  isError: boolean
): Promise<unknown> {
  if (typeof review !== "function") return output
  try {
    const updated = await review(namespaced, toolCallId, output, isError)
    return updated === undefined || updated === null ? output : updated
  } catch {
    return output // fail-open: a broken reviewer never loses a tool result
  }
}

function validatedToolInput(name: string, schema: unknown, input: unknown): unknown {
  const parsed = parseToolArgs(schema, input)
  if (!parsed.ok) throw new Error(`invalid arguments for "${name}": ${parsed.message}`)
  return parsed.value
}

/**
 * Convert one built-in `SdkMcpToolDefinition` into an AI SDK tool. The built-in
 * handler returns an MCP `CallToolResult`; we flatten it to text and re-throw on
 * `isError` so the AI SDK surfaces a `tool-error` (which the model can recover
 * from across steps). Execution is gated through `gate` when supplied.
 */
function builtinDefToAiSdkTool(
  def: ToolDefinition,
  gate: ToolPermissionGate | null | undefined,
  timeoutMs: number,
  reviewToolOutput?: ToolOutputReview,
  injectionProtection = true,
  preserveMcpResult = false,
  workerToolAdmission?: WorkerToolAdmission
): AiSdkTool {
  const namespaced = `mcp__${SERVER_NAME}__${def.name}`
  return tool({
    description: def.description ?? "",
    inputSchema: z.object((def.inputSchema ?? {}) as z.ZodRawShape),
    execute: async (args: unknown, options) => {
      const parsed = validatedToolInput(def.name, def.inputSchema, args)
      const effective = gate
        ? await gate(namespaced, parsed, options?.abortSignal, (input) =>
            validatedToolInput(def.name, def.inputSchema, input)
          )
        : parsed
      const validated = validatedToolInput(def.name, def.inputSchema, effective)
      if (workerToolAdmission) {
        await workerToolAdmission.admit(namespaced, options?.toolCallId)
        workerToolAdmission.assertAllowed()
      }
      let result: unknown
      try {
        result = await runBuiltinHandler(
          def,
          validated,
          timeoutMs,
          options?.abortSignal,
          options?.toolCallId
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const reviewed = await applyOutputReview(
          reviewToolOutput,
          namespaced,
          options?.toolCallId,
          msg,
          true
        )
        const safe = String(assertModelSafeToolOutput(reviewed, injectionProtection))
        throw reviewed === msg && safe === msg ? err : new Error(safe)
      }
      if (result && (result as { isError?: unknown }).isError) {
        const msg = callToolResultToText(result) || `${def.name} failed`
        const reviewed = await applyOutputReview(
          reviewToolOutput,
          namespaced,
          options?.toolCallId,
          msg,
          true
        )
        const safe = String(assertModelSafeToolOutput(reviewed, injectionProtection))
        // A nested `run_code` call keeps the reviewed error as an envelope with
        // its `cognia/failure` kind, the shape the Claude SDK rail produces, so
        // the broker gives the program the same failure on either rail.
        if (preserveMcpResult) {
          return {
            ...(result as Record<string, unknown>),
            content: [{ type: "text", text: safe }],
          }
        }
        throw new Error(safe)
      }
      // Structured content passes through as the raw MCP object for
      // toModelOutput; text-only results keep the established flattening.
      const out =
        preserveMcpResult || hasRichContentBlock(result) ? result : callToolResultToText(result)
      const reviewed = await applyOutputReview(
        reviewToolOutput,
        namespaced,
        options?.toolCallId,
        out,
        false
      )
      return assertModelSafeToolOutput(reviewed, injectionProtection)
    },
    toModelOutput: builtinToModelOutput,
  })
}

/**
 * Convert a plugin tool manifest entry into an AI SDK tool whose `execute`
 * round-trips through the renderer over stdio: it emits `plugin_tool_exec` and
 * awaits a `plugin_tool_response` resolved via `pendingPluginToolCalls` (the
 * same Map claude-host populates for the Anthropic path). Execution is gated.
 */
function pluginToolToAiSdkTool(
  manifest: PluginToolManifestEntry,
  context: {
    emit: (frame: Record<string, unknown>) => void
    sessionId: string
    pendingPluginToolCalls: PendingPluginToolCalls
    gate: ToolPermissionGate | null | undefined
    reviewToolOutput?: ToolOutputReview | undefined
    injectionProtection?: boolean
    remoteExecutionContext?: unknown
    sandboxRuntimeRef?: unknown
    turnId?: string | undefined
    attemptId?: string | undefined
    workerToolAdmission?: WorkerToolAdmission | undefined
  }
): AiSdkTool {
  const {
    emit,
    sessionId,
    pendingPluginToolCalls,
    gate,
    reviewToolOutput,
    sandboxRuntimeRef,
    turnId,
    attemptId,
    injectionProtection = true,
  } = context
  const namespaced = `mcp__${PLUGIN_TOOLS_SERVER_NAME}__${manifest.name}`
  assertSafeExternalContent(manifest, injectionProtection)
  const validator = jsonSchemaPropToZod(manifest.jsonSchema ?? { type: "object" }, true)
  return tool({
    description: manifest.description ?? "",
    inputSchema: jsonSchema(
      (manifest.jsonSchema ?? { type: "object", properties: {} }) as Parameters<
        typeof jsonSchema
      >[0],
      {
        validate: async (value) => {
          const parsed = validator.safeParse(value)
          return parsed.success
            ? { success: true, value: parsed.data }
            : {
                success: false,
                error: new Error(
                  `invalid arguments for "${manifest.name}": ${parsed.error.message}`
                ),
              }
        },
      }
    ),
    execute: async (args: unknown, options) => {
      const remoteExecutionContext = context.remoteExecutionContext
      const parsed = validatedToolInput(manifest.name, validator, args)
      const effective = gate
        ? await gate(namespaced, parsed, options?.abortSignal, (input) =>
            validatedToolInput(manifest.name, validator, input)
          )
        : parsed
      const validated = validatedToolInput(manifest.name, validator, effective)
      const toolUseId = options?.toolCallId || randomUUID()
      if (context.workerToolAdmission) {
        await context.workerToolAdmission.admit(namespaced, toolUseId)
        context.workerToolAdmission.assertAllowed()
      }
      // Preserve the manifest's lifecycle contract on the AI SDK rail just as
      // buildPluginToolsServer does on the Anthropic rail. In particular,
      // dispatch_agent/ask_user declare `timeoutMs: 0`: the child run or human
      // interaction owns its own bounds, so the generic 120s relay timeout must
      // not sever a still-live round-trip while the renderer keeps working.
      const pending = awaitPluginToolResponse(
        pendingPluginToolCalls,
        toolUseId,
        manifest.name,
        typeof manifest.timeoutMs === "number" ? manifest.timeoutMs : undefined
      )
      emit({
        type: "plugin_tool_exec",
        sessionId,
        toolUseId,
        name: manifest.name,
        args: validated,
        ...(turnId ? { turnId } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(sandboxRuntimeRef ? { sandboxRuntimeRef } : {}),
        ...(remoteExecutionContext ? { remoteExecutionContext } : {}),
      })
      const response = await pending
      const payload = response ? response.result : null
      const mcpError =
        payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { content?: unknown }).content) &&
        (payload as { isError?: unknown }).isError === true
      if (response?.error || mcpError) {
        const msg = response?.error
          ? String(response.error)
          : callToolResultToText(payload) || `${manifest.name} failed`
        const reviewed = await applyOutputReview(
          reviewToolOutput,
          namespaced,
          options?.toolCallId,
          msg,
          true
        )
        const safe = assertModelSafeToolOutput(reviewed, injectionProtection)
        throw new Error(String(safe))
      }
      // A plugin that already speaks MCP passes its content blocks straight
      // through for `builtinToModelOutput` to map — the same treatment built-in
      // tools get above. Without this a plugin can only ever return text, so an
      // media result reaches the model (and the chat) as base64 gibberish.
      const out = hasRichContentBlock(payload)
        ? payload
        : typeof payload === "string"
          ? payload
          : JSON.stringify(payload ?? null)
      const reviewed = await applyOutputReview(
        reviewToolOutput,
        namespaced,
        options?.toolCallId,
        out,
        false
      )
      return assertModelSafeToolOutput(reviewed, injectionProtection)
    },
    toModelOutput: builtinToModelOutput,
  })
}

/**
 * Build the AI SDK `tools` map for a turn: built-in tools gated by enabled
 * categories (`sendOptions.builtinTools`) plus any renderer-proxied plugin
 * tools (`sendOptions.pluginTools`). Returns `{}` when nothing is available, so
 * the dispatcher can omit the `tools` option entirely.
 */
export function buildAiSdkTools({
  sendOptions,
  emit,
  sessionId,
  processSignal,
  groupProofSupported,
  pendingApprovals,
  pendingPluginToolCalls,
  lspResolver,
  codeGraphResolver,
  readTracker,
  bgShells,
  hostRpc,
  taskStore,
  doomGuard: providedDoomGuard,
  reviewToolOutput,
  verificationBudget,
  workerToolAdmission,
}: {
  sendOptions: AiSdkToolSendOptions
  emit: (frame: Record<string, unknown>) => void
  sessionId: string
  processSignal?: AbortSignal | undefined
  groupProofSupported?: boolean | undefined
  pendingApprovals?: Map<string, PendingApproval> | undefined
  pendingPluginToolCalls?: PendingPluginToolCalls | undefined
  lspResolver?: LazyLspResolver | null | undefined
  codeGraphResolver?: CodeGraphIndex | null | undefined
  readTracker?: ReadTracker | null | undefined
  bgShells?: SessionBgShellRegistry | null | undefined
  hostRpc?: HostRpcCaller | null | undefined
  taskStore?: SessionTaskStore | undefined
  /** A caller-owned guard, so the session can reset it per turn. */
  doomGuard?: DoomLoopGuard | undefined
  reviewToolOutput?: ToolOutputReview | undefined
  verificationBudget?: VerificationBudget | undefined
  workerToolAdmission?: WorkerToolAdmission | undefined
}): Record<string, AiSdkTool> {
  // An empty `allowedTools` array means "no filtering" on this path. Honor the
  // explicit runtime-wide deny-all contract before collecting any built-in or
  // plugin definitions so Support sessions cannot inherit a tool accidentally.
  if (sendOptions.toolSurface === "none") return {}

  const tools: Record<string, AiSdkTool> = {}
  // Accept a caller-owned guard so the session can `reset()` it per turn (the
  // guard counts identical-call repetition WITHIN a turn — matching the
  // Anthropic path, which gets a fresh guard per `query()`). Falls back to an
  // owned guard for callers/tests that don't pass one.
  const doomGuard = providedDoomGuard ?? createDoomLoopGuard()
  const permissionGate = createToolPermissionGate({
    emit,
    sessionId,
    pendingApprovals,
    sendOptions,
    doomGuard,
  })
  // A host that rewinds files gets the original bytes of every target after
  // the gate allows a call and before the tool runs; earlier would snapshot
  // calls that are then denied, later would race the write.
  const reportPreMutation =
    sendOptions.fileCheckpointFrames === true
      ? createPreMutationReporter({
          emit: (frame) => emit({ ...frame }),
          sessionId,
          cwd: sendOptions.cwd,
          workspaceRoots: [
            ...(sendOptions.cwd ? [sendOptions.cwd] : []),
            ...(Array.isArray(sendOptions.additionalDirectories)
              ? sendOptions.additionalDirectories.filter(
                  (dir): dir is string => typeof dir === "string" && dir.length > 0
                )
              : []),
          ],
        })
      : null
  const gate: ToolPermissionGate = reportPreMutation
    ? async (toolName, input, signal, validateInput) => {
        const effective = await permissionGate(toolName, input, signal, validateInput)
        reportPreMutation(toolName, effective)
        return effective
      }
    : permissionGate

  // Deny-list enforcement. The Anthropic path delegates allowed/disallowed
  // tool filtering to the agent SDK; `streamText` has no such concept, so the
  // bridge must honour `disallowedTools` itself — restricted mode (untrusted
  // workspace) and the IM-channel blacklist both arrive through it. Entries
  // may be bare (`bash`) or namespaced (`mcp__cognia-tools__bash`).
  const disallowed = new Set<unknown>(
    Array.isArray(sendOptions.disallowedTools) ? sendOptions.disallowedTools : []
  )

  // Allow-list enforcement (parity with the Anthropic path, where the agent
  // SDK applies `allowedTools` itself). When a character / skill / mode scopes
  // the tool palette, the AI-SDK path must honour it too — previously the
  // whitelist was built by `resolveSendOptions` but never consulted here, so a
  // restricted character silently kept its full tool set on non-Anthropic
  // providers. Deny (`disallowedTools`, checked separately) still wins.
  const allowSet =
    Array.isArray(sendOptions.allowedTools) && sendOptions.allowedTools.length > 0
      ? new Set<string>(sendOptions.allowedTools as string[])
      : null

  // Per-tool execution deadline for read-only built-ins (see
  // `DEFAULT_BUILTIN_TOOL_TIMEOUT_MS`). Honour an explicit override (incl. `0` to
  // disable); fall back to the default safety net otherwise.
  const builtinToolTimeoutMs =
    typeof sendOptions.toolExecutionTimeoutMs === "number"
      ? sendOptions.toolExecutionTimeoutMs
      : DEFAULT_BUILTIN_TOOL_TIMEOUT_MS

  const isToolAllowed = (name: string, server = SERVER_NAME) =>
    passesToolLists(name, server, allowSet, disallowed)
  const bashVisible = () => isToolAllowed("bash")

  for (const def of collectCogniaToolDefs({
    ...(bashVisible() && verificationBudget
      ? {
          verificationBudget,
          authorizeVerificationCommand: async (input: unknown, signal?: AbortSignal) => {
            if (!bashVisible()) throw new Error("Bash is not allowed in this tool surface")
            const approved = await gate(`mcp__${SERVER_NAME}__bash`, input, signal)
            // Each batch command runs `bash.handler` directly after its own
            // approval wait, so admission follows that wait (ADR-0244 WP2b).
            if (workerToolAdmission) {
              await workerToolAdmission.admit(`mcp__${SERVER_NAME}__bash`)
              workerToolAdmission.assertAllowed()
            }
            return approved
          },
          // The batch awaits again between this approval and the spawn, so the
          // synchronous final check runs at the spawn itself.
          ...(workerToolAdmission
            ? { beforeVerificationCommand: () => workerToolAdmission.assertAllowed() }
            : {}),
        }
      : {}),
    enabled: sendOptions.builtinTools,
    isToolAllowed,
    isToolDenied: (name) => !passesToolLists(name, SERVER_NAME, null, disallowed),
    emit,
    authorizeTool: (name, input, extra, validateInput) =>
      gate(name, input, extra?.signal, validateInput),
    executeTool: async (def, input, extra) => {
      const nested = builtinDefToAiSdkTool(
        def,
        undefined,
        builtinToolTimeoutMs,
        reviewToolOutput,
        sendOptions.contentSafety?.injectionProtection,
        true,
        workerToolAdmission
      )
      return nested.execute!(input, {
        // `run_code` names each nested call after itself, so this call's
        // admission and output review carry the same id as its trace.
        toolCallId: extra?.toolCallId ?? randomUUID(),
        messages: [],
        abortSignal: extra?.signal,
        context: {},
      })
    },
    // The send spec carries the whole launch policy, a ProcessSandboxScope.
    builtinProcessSandbox: (sendOptions.builtinProcessSandbox ?? undefined) as
      ProcessSandboxScope | undefined,
    lspResolver,
    codeGraphResolver,
    readTracker,
    cwd: sendOptions.cwd,
    dispatchPath: "ai-sdk",
    bgShells,
    hostRpc,
    sessionId,
    processSignal,
    groupProofSupported,
    taskStore,
    model: sendOptions.model,
    provider: sendOptions.provider,
    // ADR-0117: the frozen composition decides which tool surface the model
    // sees. Read from the send spec rather than re-derived here, so renderer
    // and sidecar cannot disagree about what this turn is.
    toolPresentation: sendOptions.execution?.composition?.toolPresentation,
    // ADR-0045 plan authoring — same default as the Anthropic path.
    planTools: sendOptions.planTools !== false,
  })) {
    // The registry already applied the allow and deny lists (and admitted the
    // Code entry by its own rule); filtering again here dropped `run_code`.
    if (!def || !def.name) continue
    tools[def.name] = markAiSdkToolSource(
      builtinDefToAiSdkTool(
        def,
        gate,
        builtinToolTimeoutMs,
        reviewToolOutput,
        sendOptions.contentSafety?.injectionProtection,
        false,
        workerToolAdmission
      ),
      {
        serverName: SERVER_NAME,
        alwaysLoad: def.alwaysLoad === true,
      }
    )
    toolPolicyNames.set(tools[def.name]!, `mcp__${SERVER_NAME}__${def.name}`)
  }

  if (Array.isArray(sendOptions.pluginTools) && pendingPluginToolCalls) {
    for (const manifest of sendOptions.pluginTools as (PluginToolManifestEntry | null)[]) {
      if (!manifest || !manifest.name) continue
      if (!isToolAllowed(manifest.name, PLUGIN_TOOLS_SERVER_NAME)) continue
      tools[manifest.name] = markAiSdkToolSource(
        pluginToolToAiSdkTool(manifest, {
          emit,
          sessionId,
          pendingPluginToolCalls,
          gate,
          workerToolAdmission,
          reviewToolOutput,
          injectionProtection: sendOptions.contentSafety?.injectionProtection,
          get remoteExecutionContext() {
            return sendOptions.remoteExecutionContext
          },
          sandboxRuntimeRef: sendOptions.sandboxRuntimeRef,
          turnId: sendOptions.turnId,
          attemptId: sendOptions.execution?.identity?.attemptId,
        }),
        { serverName: PLUGIN_TOOLS_SERVER_NAME }
      )
      toolPolicyNames.set(
        tools[manifest.name]!,
        `mcp__${PLUGIN_TOOLS_SERVER_NAME}__${manifest.name}`
      )
    }
  }

  // Rebuild in sorted-key order so the tools map serializes identically
  // across turns/sessions — built-in registry and pluginTools arrive in
  // registration order, and an unstable order silently breaks provider
  // prompt-cache prefix matching.
  const sorted: Record<string, AiSdkTool> = {}
  for (const name of Object.keys(tools).sort()) sorted[name] = tools[name]!
  return sorted
}

export const __testing__ = {
  builtinDefToAiSdkTool,
  pluginToolToAiSdkTool,
  applyOutputReview,
  runBuiltinHandler,
  assertModelSafeToolOutput,
  DEFAULT_BUILTIN_TOOL_TIMEOUT_MS,
}
