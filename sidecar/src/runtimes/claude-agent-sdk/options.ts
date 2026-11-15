import { BUILTIN_TOOL_NAMES } from "@anthropic-ai/claude-agent-sdk"
import {
  personalToolDenied,
  personalEgressState,
  beginPersonalEgressOperation,
  releasePersonalEgressOperations,
  opaquePersonalTool,
} from "../../policy/personal-egress.ts"
import type { HookMap } from "../../hooks/kernel/types.ts"
import type { Options, HookCallback } from "@anthropic-ai/claude-agent-sdk"
import { PERSONAL_EGRESS_DENIAL } from "@cognia/agent-contracts/personal-egress"
import { enforceAnthropicToolSurface, normalizeClaudeToolNames } from "./tool-surface.ts"
import type { OptionsContext } from "./runtime-types.ts"

import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { narrowAuthority } from "@cognia/agent-config-types/agent-composition"
import { subagentKeyMatches } from "@cognia/agent-config-types/agent-capability-grant"
import { runAuthorityAllowsMcpServer } from "@cognia/agent-config-types/claude-agent-sdk-options"
import type { SendOptions } from "../../shared/wire/inbound.ts"

import { buildSubprocessEnv } from "./subprocess-env.ts"

import { foldSystemPrompt, thinkingFromBudget } from "./system-prompt.ts"
import { createAnthropicCanUseTool } from "../../policy/permission/sdk-can-use-tool.ts"
import { splitToolName } from "../../policy/tool-catalog/names.ts"
import { toolNameCandidates } from "../../tools/adapters/allow-list.ts"
import {
  enforceAnthropicPermissionChannel,
  type DelegatingSdkOptions,
} from "../../policy/permission/delegated-approval.ts"

import { buildLspHooks } from "../../hooks/lsp-diagnostics.ts"
import { buildAgentHooks, mergeHookMaps } from "../../hooks/agent-hooks.ts"
import { buildLedgerToolHooks } from "./ledger.ts"
import { buildProfileToolHooks } from "./profile-hooks.ts"
import { createNativeHookExecutor } from "../../hooks/native-executor.ts"

import { applyEmbeddedClaudeExecutable } from "./executable.ts"
import {
  applyClaudeAgentSdkOptions,
  resolveClaudeRuntimeExtensions,
  buildSdkInteractionCallbacks,
  intersectTrustedWorkspaceRoots,
} from "./sdk-options.ts"
import { sessionStoreFromSendOptions } from "./session-store.ts"
import { createWorkerToolAdmission, FenceDeniedError } from "../../policy/fence/admission.ts"

/** Native loading canonicalizes paths; the permission decision still uses the id. */
function sameNativeReference(reference: string, loaded: string): boolean {
  if (reference === loaded) return true
  try {
    return realpathSync(reference) === loaded
  } catch {
    return false
  }
}

/** Permission-rule patterns authorize their base tool or MCP server namespace. */
function authorityToolMatches(pattern: string, candidate: string): boolean {
  const base = pattern.split("(", 1)[0]!
  return (
    base === candidate ||
    (base.endsWith("__*") && candidate.startsWith(base.slice(0, -1))) ||
    (base.startsWith("mcp__") && !base.slice(5).includes("__") && candidate.startsWith(`${base}__`))
  )
}

/** Pattern denies remain SDK argument rules, never blanket base-tool denials. */
function authorityToolDenied(pattern: string, candidate: string): boolean {
  return !pattern.includes("(") && authorityToolMatches(pattern, candidate)
}

/** Runs after SDK overlays so native subagents cannot reopen parent authority. */
export function enforceNativeRunAuthority(options: Options, sendOptions: SendOptions): Options {
  const authority = sendOptions.inheritedRunAuthority
  const childAuthority = sendOptions.runAuthority
  const hasCaps = (value: typeof authority) =>
    value && Object.keys(value).some((key) => !["schemaVersion", "caps", "pools"].includes(key))
  if (!hasCaps(authority) && !hasCaps(childAuthority)) return options
  const inherited = authority ?? { schemaVersion: 1 }
  const allow = normalizeClaudeToolNames(inherited.tools?.allow)
  const deny = normalizeClaudeToolNames(inherited.tools?.deny) ?? []
  if (allow)
    options.tools = (Array.isArray(options.tools) ? options.tools : BUILTIN_TOOL_NAMES).filter(
      (name) =>
        allow.some((pattern) => authorityToolMatches(pattern, name)) &&
        !deny.some((pattern) => authorityToolDenied(pattern, name))
    )
  if (deny.length)
    options.disallowedTools = [...new Set([...(options.disallowedTools ?? []), ...deny])]
  if (inherited.maxTurns !== undefined)
    options.maxTurns = Math.min(options.maxTurns ?? Infinity, inherited.maxTurns)
  const mode = inherited.permissionMode
    ? narrowAuthority(inherited.permissionMode, sendOptions.permissionMode ?? "default")
    : undefined
  if (mode) options.permissionMode = mode
  const servers = inherited.mcpServers?.only
  if (servers) {
    options.mcpServers = Object.fromEntries(
      Object.entries(options.mcpServers ?? {}).filter(([name, config]) =>
        runAuthorityAllowsMcpServer(name, config, sendOptions.runAuthorityMcpServerIds, servers)
      )
    )
    options.strictMcpConfig = true
  }
  if (inherited.skills?.only) {
    options.settingSources = []
    const nativeTrusted =
      Boolean(sendOptions.trustedWorkspaceRoots?.length) &&
      (!sendOptions.cwd || sendOptions.trustedWorkspaceRoots!.includes(sendOptions.cwd)) &&
      (sendOptions.additionalDirectories ?? []).every((root) =>
        sendOptions.trustedWorkspaceRoots!.includes(root)
      )
    options.skills = !nativeTrusted
      ? []
      : Array.isArray(options.skills)
        ? options.skills.filter((id) => inherited.skills!.only!.includes(id))
        : [...inherited.skills.only]
    options.plugins = options.plugins?.filter((plugin) =>
      (sendOptions.runtimeExtensions ?? []).some(
        (ref) =>
          nativeTrusted &&
          ref.id !== undefined &&
          inherited.skills!.only!.includes(ref.id) &&
          sameNativeReference(ref.path, plugin.path)
      )
    )
  }
  const effective = childAuthority ?? inherited
  const childServers = effective.mcpServers?.only
  if (options.agents)
    options.agents = Object.fromEntries(
      Object.entries(options.agents)
        .filter(
          ([name]) =>
            !effective.subagents?.only ||
            effective.subagents.only.some((id: string) => subagentKeyMatches(name, id))
        )
        .map(([name, definition]) => {
          const subMode = effective.permissionMode
            ? narrowAuthority(effective.permissionMode, definition.permissionMode ?? "default")
            : definition.permissionMode
          const childAllow = normalizeClaudeToolNames(effective.tools?.allow)
          const subDenied = [
            ...new Set([
              ...(definition.disallowedTools ?? []),
              ...(normalizeClaudeToolNames(effective.tools?.deny) ?? []),
            ]),
          ]
          const subTools = (definition.tools ?? childAllow)?.filter(
            (tool) =>
              (!childAllow || childAllow.some((pattern) => authorityToolMatches(pattern, tool))) &&
              !subDenied.some((pattern) => authorityToolDenied(pattern, tool))
          )
          const subTurns = [effective.maxTurns, definition.maxTurns].filter(
            (turns): turns is number => turns !== undefined
          )
          return [
            name,
            {
              ...definition,
              ...(subTools ? { tools: subTools } : {}),
              ...(subDenied.length ? { disallowedTools: subDenied } : {}),
              ...(subMode ? { permissionMode: subMode } : {}),
              ...(subTurns.length ? { maxTurns: Math.min(...subTurns) } : {}),
              ...(effective.skills?.only
                ? {
                    skills: (definition.skills ?? []).filter((id) =>
                      effective.skills!.only!.includes(id)
                    ),
                  }
                : {}),
              ...(childServers
                ? {
                    mcpServers: (
                      definition.mcpServers ?? Object.keys(options.mcpServers ?? {})
                    ).flatMap((entry) =>
                      typeof entry === "string" &&
                      runAuthorityAllowsMcpServer(
                        entry,
                        options.mcpServers?.[entry],
                        sendOptions.runAuthorityMcpServerIds,
                        childServers
                      ) &&
                      options.mcpServers?.[entry]
                        ? [entry]
                        : []
                    ),
                  }
                : {}),
            },
          ]
        })
    )
  return options
}

export function buildAnthropicOptions({
  sendOptions,
  sessionId,
  emit,
  log,
  hostRpc,
  mcpStderrSink,
  ledgerGate,
  sdkFallbackModel,
  sdkMaxBudgetUsd,
  pendingApprovals,
  pendingPluginHookCalls,
  doomGuard,
  interruptForLedger,
  surface,
  onFenceDenied,
}: OptionsContext & { onFenceDenied?: (error: FenceDeniedError) => void }) {
  personalEgressState(sendOptions)
  const workerAdmission =
    sendOptions.workerToolAdmission === true
      ? createWorkerToolAdmission({
          sessionId: sendOptions.workerToolAdmissionSessionId ?? sessionId,
          hostRpc,
          onDenied: (error) => onFenceDenied?.(error),
        })
      : undefined
  const {
    mergedMcpServers,
    pluginToolNameAliases,
    personalEgressRelayTools,
    modelAllowedTools,
    disallowed,
    lspEnabled,
    lspResolver,
  } = surface
  const resumeId = sendOptions.resumeSessionId ?? sendOptions.forkFromSessionId
  const isFork = sendOptions.forkFromSessionId != null
  // ADR-0028 — per-`query()` env is the per-session account/proxy isolation
  // mechanism. `sendOptions.env` (built by `lib/claude/build-options.ts`)
  // carries the resolved account env (`CLAUDE_CODE_OAUTH_TOKEN`,
  // `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL`, …) plus proxy env. The
  // claude-agent-sdk v0.2.111+ overlays this onto the spawned CLI
  // subprocess's environment; an earlier v0.2.113 brief replace-not-overlay
  // regime is also handled correctly by our explicit `process.env` spread
  // below — DO NOT collapse this to `sendOptions.env` alone or essential
  // host vars like PATH will be lost on Windows.
  //
  // NOTE: there is intentionally no `containerSkillIds` / `skills-2025-10-02`
  // beta-header passthrough here. The Claude Agent SDK exposes NO `query()`
  // option to attach Anthropic-managed (uploaded) skill_ids — verified against
  // sdk 0.3.x (`containerSkillIds` is read by no runtime version, `SdkBeta` has
  // no skills value, no `container.skills` request is built). The old header
  // was inert without the attach; the renderer now warns at resolve time
  // instead of silently dropping (see `lib/claude/build-options.ts`).
  const baseEnv = buildSubprocessEnv(sendOptions)
  // SDK 0.3.302 enables fork subagents by default. Keep Cognia's existing
  // subagent behavior unless the portable context policy explicitly enables it.
  baseEnv.CLAUDE_CODE_FORK_SUBAGENT =
    sendOptions.subagentRuntime?.contextMode === "fork" ? "1" : "0"
  // A ledgered envelope must not hide transport retries inside the CLI: each
  // retry is another billed request the ledger never saw.
  if (ledgerGate.active) baseEnv.CLAUDE_CODE_MAX_RETRIES = "0"

  // M5 Computer Use — merge `sendOptions.appendHeaders` into
  // ANTHROPIC_DEFAULT_HEADERS. The renderer's `resolveSendOptions` populates
  // `appendHeaders["anthropic-beta"]` (typically `computer-use-2025-11-24`)
  // when the active character has `enableComputerUse === true` and at least
  // one native Anthropic tool is registered. The merging is comma-joined and
  // the per-key prefix matches the existing skills-header pattern.
  if (sendOptions.appendHeaders && typeof sendOptions.appendHeaders === "object") {
    const additions = []
    for (const [key, value] of Object.entries(sendOptions.appendHeaders)) {
      if (typeof key !== "string" || typeof value !== "string") continue
      if (!key || !value) continue
      additions.push(`${key}=${value}`)
    }
    if (additions.length > 0) {
      const existing = baseEnv.ANTHROPIC_DEFAULT_HEADERS
      baseEnv.ANTHROPIC_DEFAULT_HEADERS = existing
        ? `${existing},${additions.join(",")}`
        : additions.join(",")
    }
  }

  const executeNativeHook = createNativeHookExecutor({
    personalEgressFenced: () => personalEgressState(sendOptions).fenced,
    cwd: sendOptions.cwd,
    // Native model hooks are separate invocations. They must not inherit the
    // root query's retry policy without its total deadline and cancellation.
    env: Object.fromEntries(
      Object.entries(baseEnv).filter(([name]) => !/^CLAUDE_CODE_RETRY_WATCHDOG/i.test(name))
    ),
    model:
      sendOptions.execution?.modelBindings?.primary &&
      sendOptions.execution.modelBindings.primary !== "inherit"
        ? sendOptions.execution.modelBindings.primary
        : sendOptions.model,
    fallbackModel: sdkFallbackModel,
    mcpServers: mergedMcpServers,
    allowedTools: modelAllowedTools,
    maxBudgetUsd: sdkMaxBudgetUsd,
    ...(workerAdmission ? { workerToolAdmission: workerAdmission } : {}),
  })

  // Allowlist construction — only fields listed below reach the SDK. This is
  // intentional: cognia-next sends a few sidecar-protocol-only fields
  // (`builtinTools`, `bareMode`, `debugMode`, `briefMode`, `aliasResolution`,
  // `routingDecision`, `provider`, `providerCredentials`) that the SDK doesn't
  // recognise. They're consumed earlier in `resolveSendOptions` (translated
  // into env / settingSources / appendSystemPrompt / etc.) or in this
  // dispatcher before this object is built (`builtinTools` → `mergedMcpServers`).
  // One `canUseTool` for the SDK and the profile hook (ADR-0224 A7), which
  // asks through it ahead of the SDK's own modes and hands the approval over.
  const profileApprovals = new Set<string>()
  // Outbound calls `canUseTool` allowed or reported, so the observing
  // PostToolUse hook does not report them twice (ADR-0239).
  const explicitSeen = new Set<string>()
  const sessionCanUseTool = createAnthropicCanUseTool({
    sendOptions,
    sessionId,
    emit,
    log,
    pendingApprovals,
    pluginToolNameAliases,
    doomGuard,
    profileApprovals,
    explicitSeen,
    workerToolAdmission: workerAdmission,
  })
  surface.setNestedToolAuthorizer(async (name, input, extra, validateInput) => {
    const { server, bare } = splitToolName(name)
    const candidates = server ? toolNameCandidates(bare, server) : [name]
    const decision = await sessionCanUseTool(name, input as Record<string, unknown>, {
      signal: extra?.signal,
      toolUseID: randomUUID(),
      displayName: name,
      validateInput,
      sdkPreflight: true,
      sdkPreapproved: candidates.some((candidate) => modelAllowedTools?.includes(candidate)),
    })
    if (decision.behavior !== "allow") {
      throw new Error(String(decision.message ?? `Nested tool denied: ${name}`))
    }
    return decision.updatedInput ?? input
  })
  let options: Options & Record<string, unknown> = {
    cwd: sendOptions.cwd,
    model:
      sendOptions.execution?.modelBindings?.primary &&
      sendOptions.execution.modelBindings.primary !== "inherit"
        ? sendOptions.execution.modelBindings.primary
        : sendOptions.model,
    fallbackModel: sdkFallbackModel,
    // SDK 0.3.x dropped the top-level `appendSystemPrompt` from the public
    // `Options` type. Fold the stable base + dynamic appended sections into the
    // typed `systemPrompt: string | string[]` form (array = separate system
    // blocks, stable→dynamic order) — no reliance on the untyped runtime field.
    systemPrompt: foldSystemPrompt(sendOptions.systemPrompt, sendOptions.appendSystemPrompt),
    allowedTools: modelAllowedTools,
    disallowedTools: disallowed.size > 0 ? [...disallowed] : sendOptions.disallowedTools,
    additionalDirectories: sendOptions.additionalDirectories,
    permissionMode: sendOptions.permissionMode ?? "default",
    mcpServers: mergedMcpServers,
    maxTurns: sendOptions.maxTurns,
    // Hard USD ceiling for this single invocation. The SDK halts and emits a
    // `result` with subtype `error_max_budget_usd` when crossed. Mapped from the
    // active goal's `maxBudgetUsd` by `resolveSendOptions`.
    maxBudgetUsd: sdkMaxBudgetUsd,
    // Deprecated `maxThinkingTokens` → typed `thinking` config (ThinkingEnabled).
    // The ai-sdk path still consumes `sendOptions.maxThinkingTokens` directly,
    // so the translation is localized here to the Anthropic dispatcher.
    thinking: thinkingFromBudget(sendOptions.maxThinkingTokens),
    includePartialMessages: sendOptions.includePartialMessages,
    settingSources: sendOptions.settingSources,
    agents: sendOptions.agents
      ? Object.fromEntries(
          Object.entries(sendOptions.agents).map(([name, definition]) => {
            const { contextPolicy, ...nativeDefinition } = definition
            return [
              name,
              {
                ...nativeDefinition,
                ...(contextPolicy?.compactAtTokens !== undefined
                  ? { autoCompactWindow: contextPolicy.compactAtTokens }
                  : {}),
              },
            ]
          })
        )
      : undefined,
    // Run THIS turn's main thread AS the named subagent (its system prompt, tool
    // restrictions, and model) — Claude Code's `@agent` / `--agent`. Set by
    // `resolveSendOptions` from the composer's `@`-mention, and only ever an id
    // already present in `agents` above (membership-guarded there). Undefined is
    // stripped by the pass below, so a normal turn is unaffected.
    agent: sendOptions.agent,
    // Forward subagent text/thinking as parent_tool_use_id-tagged frames so the
    // renderer's SDK-subagent bridge can render rich nested logs (team /
    // workflow-editor). The query options are an explicit whitelist, so this
    // must be passed through here.
    forwardSubagentText: sendOptions.forwardSubagentText,
    strictMcpConfig: sendOptions.strictMcpConfig,
    effort: sendOptions.effort,
    resume: resumeId,
    forkSession: isFork ? true : undefined,
    env: baseEnv,

    // Capture the claude-code subprocess stderr (incl. spawned stdio MCP
    // servers' diagnostics) into `mcp_log` events. Wrapped by the sink so a
    // downstream emit failure never faults the SDK's stderr pump.
    stderr: (data) => mcpStderrSink.write(data),

    // Diagnostics-after-edit feedback loop (Phase 2). Omitted when LSP is
    // disabled — the strip-undefined pass below removes the field.
    // SDK-native hooks: the LSP diagnostics-after-edit hook (Phase 2) merged
    // with the user's settings.json lifecycle hooks (`sendOptions.hooks`, injected
    // HOST-side after the trust gate). Both are `Partial<Record<HookEvent,
    // HookCallbackMatcher[]>>`; `mergeHookMaps` concatenates per event. Returns
    // undefined when neither contributes, so the strip pass omits the key.
    hooks: mergeHookMaps(
      lspEnabled && lspResolver
        ? buildLspHooks({
            getDiagnostics: async (file) => {
              if (personalEgressState(sendOptions).fenced) throw new Error(PERSONAL_EGRESS_DENIAL)
              const finish = beginPersonalEgressOperation(sendOptions, true)
              try {
                return await lspResolver.getDiagnostics(file, {
                  processContext: { hostRpc, sessionId },
                })
              } finally {
                finish()
              }
            },
          })
        : undefined,
      buildAgentHooks(sendOptions.hooks, {
        emit: (frame) => emit({ ...frame }),
        emitAudit: (frame) => emit({ ...frame }),
        log,
        sessionId,
        cwd: sendOptions.cwd,
        provider: "claude",
        // Which agent this turn belongs to, for the `agents` group selector.
        // The SDK cannot supply it (cognia never launches with `--agent`), so
        // the renderer names the turn and it rides in on sendOptions.
        agentKind: sendOptions.agentKind,
        agentRef: sendOptions.agentRef,
        // Session's plugin-tools manifest: resolves `mcp__cognia-plugin-tools__*`
        // names back to their pluginId for the `tool_provenance` payload field.
        pluginTools: sendOptions.pluginTools,
        // Per-server `declared_by` locators for `mcp` tool_provenance — same
        // keys as the `mcpServers` wire map.
        mcpDeclaredBy: sendOptions.mcpDeclaredBy,
        executeNativeHandler: executeNativeHook,
        personalEgressFenced: () => personalEgressState(sendOptions).fenced,
        beginPersonalEgress: (unproven, toolUseId) =>
          beginPersonalEgressOperation(sendOptions, unproven, toolUseId),
        pendingPluginHookCalls,
        newId: () => randomUUID(),
      }),
      buildLedgerToolHooks({
        gate: ledgerGate,
        onRefused: () => interruptForLedger(),
      }) as unknown as HookMap,
      buildProfileToolHooks({
        sendOptions,
        pluginToolNameAliases,
        canUseTool: sessionCanUseTool,
        profileApprovals,
        explicitSeen,
        emit,
        sessionId,
      }) as unknown as HookMap
    ) as Options["hooks"],

    canUseTool: sessionCanUseTool as Options["canUseTool"],
  }

  // Nested `SendOptions.claudeAgentSdk` — the 29 SDK options the flat allowlist
  // above never covered. Applied AFTER the allowlist so the documented
  // precedence (nested > flat > SDK default) holds, and BEFORE the strip pass so
  // an explicit `undefined` in the block still means "use the SDK default".
  const hostCanUseTool = options.canUseTool as ReturnType<typeof createAnthropicCanUseTool>
  const trustedRoots = intersectTrustedWorkspaceRoots(sendOptions.trustedWorkspaceRoots, [
    sendOptions.cwd,
    ...(sendOptions.additionalDirectories ?? []),
  ])
  const withholdNativeContent =
    Boolean(sendOptions.inheritedRunAuthority?.skills?.only) &&
    (trustedRoots.length === 0 ||
      [sendOptions.cwd, ...(sendOptions.additionalDirectories ?? [])].some(
        (root) => !root || !trustedRoots.includes(root)
      ))
  const nestedSdk = withholdNativeContent
    ? { ...sendOptions.claudeAgentSdk, version: 1 as const, skills: [] }
    : sendOptions.claudeAgentSdk
  const sdkOverlay = applyClaudeAgentSdkOptions(options, nestedSdk, {
    resume: resumeId,
    forkSession: isFork,
    permissionMode: sendOptions.permissionMode,
    bypassConfirmed: sendOptions.bypassPermissionsConfirmed === true,
    // Local skills/plugins are provider-visible code/instructions. A root must
    // be both active for this send and explicitly granted by Workspace Trust;
    // naming cwd/additionalDirectories alone never grants content trust.
    trustedWorkspaceRoots: intersectTrustedWorkspaceRoots(sendOptions.trustedWorkspaceRoots, [
      sendOptions.cwd,
      ...(sendOptions.additionalDirectories ?? []),
    ]),
    cwd: sendOptions.cwd,
    activeWorkspaceRoots: [sendOptions.cwd, ...(sendOptions.additionalDirectories ?? [])],
  })
  if (!withholdNativeContent && sendOptions.runtimeExtensions?.length) {
    const plugins = new Map((options.plugins ?? []).map((plugin) => [plugin.path, plugin]))
    for (const plugin of resolveClaudeRuntimeExtensions(sendOptions, sendOptions.runtimeExtensions))
      plugins.set(plugin.path, plugin)
    options.plugins = [...plugins.values()]
  }
  options.systemPrompt = foldSystemPrompt(
    sendOptions.claudeAgentSdk?.systemPrompt ?? sendOptions.systemPrompt,
    sendOptions.appendSystemPrompt
  )
  Object.assign(
    options,
    buildSdkInteractionCallbacks(sendOptions.claudeAgentSdk, (toolName, input, ctx) =>
      hostCanUseTool(toolName, input, ctx)
    )
  )
  for (const warning of sdkOverlay.warnings) {
    // Surfaced, not swallowed: every one of these is a setting that did not take
    // effect, and the caller cannot tell that from behaviour alone.
    log("warn", `[claudeAgentSdk] ${warning}`)
    emit({ type: "sdk_option_warning", sessionId, message: warning })
  }

  // The session mirror is a LIVE object with methods, so it cannot ride the
  // JSON wire — the nested block carries a descriptor and the real store is
  // built here, against the Rust host over `host_rpc`. Assigned after the
  // overlay because the overlay copies serialisable fields only, and before the
  // strip pass so a `null` from a host without the channel is removed rather
  // than handed to the SDK.
  const sessionStore = sessionStoreFromSendOptions(sendOptions, { hostRpc, log })
  if (sessionStore) {
    options.sessionStore = sessionStore
    // `batched` is the SDK default; only forward an explicit choice.
    const flush = sendOptions.claudeAgentSdk?.sessionStore?.flush
    if (flush) options.sessionStoreFlush = flush
  }

  // A delegated approval is answered by the permission-prompt tool's MCP relay,
  // a separate process the sidecar never sees between the approval and the
  // tool's execution, so admission cannot run after that wait (ADR-0244 I3).
  // A fenced worker-dispatch turn refuses the combination instead of running
  // tools on an approval that may have outlived its lease.
  if (workerAdmission && options.permissionPromptToolName)
    throw new Error(
      "Worker-dispatch turns cannot use a delegated permission prompt tool: tool admission must run after the approval wait"
    )
  options = enforceAnthropicPermissionChannel(
    options as unknown as DelegatingSdkOptions,
    sendOptions,
    pluginToolNameAliases
  ) as unknown as Options & Record<string, unknown>
  options.allowedTools = normalizeClaudeToolNames(options.allowedTools)
  options.disallowedTools = normalizeClaudeToolNames(options.disallowedTools)
  if (Array.isArray(options.tools)) options.tools = normalizeClaudeToolNames(options.tools)
  if (options.agents) {
    options.agents = Object.fromEntries(
      Object.entries(options.agents).map(([name, agent]) => [
        name,
        {
          ...agent,
          tools: normalizeClaudeToolNames(agent.tools),
          disallowedTools: normalizeClaudeToolNames(agent.disallowedTools),
        },
      ])
    )
  }
  options = enforceAnthropicToolSurface(options, sendOptions)
  options = enforceNativeRunAuthority(options, sendOptions)
  // Mandatory hook remains outside overlays and covers SDK-preallowed tools.
  const inFlight = new Map<string, () => void>()
  const personalHook: HookCallback = async (input, toolUseId, hookContext) => {
    const authorityDecision = await runAuthorityHook(input, toolUseId, hookContext)
    if ("hookSpecificOutput" in authorityDecision) return authorityDecision
    const name = "tool_name" in input ? input.tool_name : ""
    if (personalToolDenied(name, sendOptions, BUILTIN_TOOL_NAMES))
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: PERSONAL_EGRESS_DENIAL,
        },
      }
    if (
      !personalEgressState(sendOptions).fenced &&
      !personalEgressRelayTools.has(name) &&
      opaquePersonalTool(name, sendOptions, BUILTIN_TOOL_NAMES)
    ) {
      const id = toolUseId ?? ("tool_use_id" in input ? String(input.tool_use_id) : randomUUID())
      const release = beginPersonalEgressOperation(
        sendOptions,
        /(?:Bash|shell|process|terminal|sandbox_bash)/i.test(name),
        id
      )
      const abort = () => {
        release()
        inFlight.delete(id)
      }
      hookContext.signal.addEventListener("abort", abort, { once: true })
      inFlight.set(id, () => {
        hookContext.signal.removeEventListener("abort", abort)
        release()
      })
      if (hookContext.signal.aborted) abort()
    }
    return {}
  }
  const runAuthorityHook: HookCallback = async (input) => {
    const authority = sendOptions.inheritedRunAuthority
    if (!authority || !("tool_name" in input)) return {}
    const name = input.tool_name
    const { server, bare } = splitToolName(name)
    const candidates = [name, ...toolNameCandidates(bare, server ?? "cognia")]
    const matches = (pattern: string) =>
      candidates.some((candidate) => authorityToolMatches(pattern, candidate))
    const allow = normalizeClaudeToolNames(authority.tools?.allow)
    const deny = normalizeClaudeToolNames(authority.tools?.deny)
    if (
      (allow !== undefined && !allow.some(matches)) ||
      deny?.some((pattern) =>
        candidates.some((candidate) => authorityToolDenied(pattern, candidate))
      )
    )
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Tool withheld by run authority",
        },
      }
    return {}
  }
  const finishPersonalTool: HookCallback = async (input, toolUseId) => {
    const id = toolUseId ?? ("tool_use_id" in input ? String(input.tool_use_id) : "")
    inFlight.get(id)?.()
    inFlight.delete(id)
    return {}
  }
  options.hooks = {
    ...options.hooks,
    PreToolUse: [
      { hooks: [personalHook] },
      ...(options.hooks?.PreToolUse ?? []).map((entry) => ({
        ...entry,
        hooks: entry.hooks.map((hook) => async (...args: Parameters<HookCallback>) => {
          const result = await hook(...args)
          if (
            ("hookSpecificOutput" in result &&
              result.hookSpecificOutput &&
              "permissionDecision" in result.hookSpecificOutput &&
              result.hookSpecificOutput.permissionDecision === "deny") ||
            ("continue" in result && result.continue === false)
          ) {
            const id = args[1] ?? ("tool_use_id" in args[0] ? String(args[0].tool_use_id) : "")
            inFlight.get(id)?.()
            inFlight.delete(id)
          }
          return result
        }),
      })),
    ],
    PostToolUse: [{ hooks: [finishPersonalTool] }, ...(options.hooks?.PostToolUse ?? [])],
    PostToolUseFailure: [
      { hooks: [finishPersonalTool] },
      ...(options.hooks?.PostToolUseFailure ?? []),
    ],
  }

  const authorize = options.canUseTool
  if (authorize)
    options.canUseTool = async (name, input, context) => {
      try {
        const answer = await authorize(name, input, context)
        if (answer?.behavior === "allow") workerAdmission?.assertAllowed()
        if (answer?.behavior === "deny") {
          inFlight.get(context.toolUseID)?.()
          inFlight.delete(context.toolUseID)
          releasePersonalEgressOperations(sendOptions, context.toolUseID)
        }
        return answer
      } catch (error) {
        inFlight.get(context.toolUseID)?.()
        inFlight.delete(context.toolUseID)
        if (error instanceof FenceDeniedError)
          return { behavior: "deny" as const, message: error.message, interrupt: true }
        throw error
      }
    }

  if (workerAdmission) {
    const admit: HookCallback = async (input, toolUseId) => {
      try {
        await workerAdmission.admit("tool_name" in input ? input.tool_name : "", toolUseId)
        workerAdmission.assertAllowed()
        return {}
      } catch (error) {
        if (!(error instanceof FenceDeniedError)) throw error
        const id = toolUseId ?? ("tool_use_id" in input ? String(input.tool_use_id) : "")
        inFlight.get(id)?.()
        inFlight.delete(id)
        return {
          continue: false,
          stopReason: error.code,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: error.message,
          },
        }
      }
    }
    // Outside all overlays/matchers/modes. Existing callbacks also end with
    // admission, so an allow or a slow approval in another hook cannot bypass
    // the fence. Keep the original hook's result only while authority is live.
    options.hooks = {
      ...options.hooks,
      PreToolUse: [
        ...(options.hooks?.PreToolUse ?? []).map((entry) => ({
          ...entry,
          hooks: entry.hooks.map((hook): HookCallback => async (...args) => {
            const result = await hook(...args)
            const admission = await admit(...args)
            if (!("continue" in admission && admission.continue === false)) {
              try {
                workerAdmission.assertAllowed()
              } catch (error) {
                if (!(error instanceof FenceDeniedError)) throw error
                return admit(...args)
              }
            }
            return "continue" in admission && admission.continue === false ? admission : result
          }),
        })),
        { hooks: [admit] },
      ],
    }
  }

  options = applyEmbeddedClaudeExecutable(options)

  // Strip undefined/null so the SDK uses its defaults instead of choking on
  // `null.type` lookups.
  for (const k of Object.keys(options)) {
    if (options[k] === undefined || options[k] === null) delete options[k]
  }

  return options
}
