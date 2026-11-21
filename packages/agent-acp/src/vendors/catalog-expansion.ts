/**
 * ACP-specific deviations for the 2026-10-27 catalog expansion. The common
 * transport owns execution; these profiles constrain vendor authority and
 * never manufacture negotiated optional capabilities (ADR-0217).
 */
import type {
  AcpPermissionMode,
  ExternalAgentTokenUsage,
} from "@cognia/agent-contracts/external-agent"
import type { AcpVendorProfile } from "../vendor-profile"

function safeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/**
 * OMP computes per-turn deltas on the server (`buildTurnUsage`) and reports them
 * on `PromptResponse.usage`; projecting directly avoids double-diffing against
 * session cumulative trackers while rejecting negative/malformed counters.
 */
function ohMyPiPromptUsage(result: {
  usage?: {
    inputTokens?: unknown
    outputTokens?: unknown
    totalTokens?: unknown
    cachedReadTokens?: unknown
    cachedWriteTokens?: unknown
    thoughtTokens?: unknown
  } | null
}): ExternalAgentTokenUsage | undefined {
  const usage = result.usage
  if (
    !usage ||
    typeof usage !== "object" ||
    !safeNonNegativeInt(usage.inputTokens) ||
    !safeNonNegativeInt(usage.outputTokens) ||
    !safeNonNegativeInt(usage.totalTokens)
  ) {
    return undefined
  }
  for (const key of ["cachedReadTokens", "cachedWriteTokens", "thoughtTokens"] as const) {
    const value = usage[key]
    if (value !== undefined && value !== null && !safeNonNegativeInt(value)) {
      return undefined
    }
  }
  const cacheReadTokens = safeNonNegativeInt(usage.cachedReadTokens)
    ? usage.cachedReadTokens
    : undefined
  const cacheWriteTokens = safeNonNegativeInt(usage.cachedWriteTokens)
    ? usage.cachedWriteTokens
    : undefined
  const reasoningTokens = safeNonNegativeInt(usage.thoughtTokens) ? usage.thoughtTokens : undefined
  if (
    usage.totalTokens === 0 &&
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    !cacheReadTokens &&
    !cacheWriteTokens &&
    !reasoningTokens
  ) {
    return undefined
  }
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  }
}

function brokerModes(
  execute: string,
  plan = "plan",
  supported: readonly AcpPermissionMode[] = ["default", "bypassPermissions"]
): NonNullable<AcpVendorProfile["permissionModes"]> {
  return {
    supportedCanonicalModes: supported,
    toNative: (mode) => {
      if (!supported.includes(mode))
        throw new Error(
          `This ACP runtime cannot enforce ${mode} against native pre-approved tools; use ${supported.join(" or ")}`
        )
      return mode === "plan" ? plan : execute
    },
    toCanonical: (native, current) => {
      if (native === plan && plan !== execute && supported.includes("plan")) return "plan"
      if (native === execute) {
        return current && current !== "plan" && supported.includes(current) ? current : "default"
      }
      // Unrecognized native modes stay restricted rather than silently granting
      // bypassPermissions auto-approval in the host permission broker.
      return "default"
    },
    requireAdvertised: { fallback: [execute] },
  }
}

function rejectUnmediatedMandatoryApprovals(
  label: string
): NonNullable<AcpVendorProfile["validateConfiguration"]> {
  return (config) => {
    if (config.requireApprovalFor?.length)
      throw new Error(
        `${label} can execute native pre-approved tools without an ACP permission request; mandatory host approval rules cannot be enforced`
      )
  }
}

export const auggieAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "auggie",
  label: "Auggie",
  commandNames: ["auggie"],
  launch: {
    id: "auggie",
    match: { kind: "base", values: ["auggie"] },
    env: {
      prefixes: ["AUGMENT_"],
    },
    stateRoots: [".augment"],
  },
  permissionModes: brokerModes("default", "default"),
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Auggie"),
  launchEnv: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
})
export const autohandCodeAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "autohand-code",
  label: "Autohand Code",
  commandNames: ["autohand"],
  launch: {
    id: "autohand-code",
    match: { kind: "base", values: ["autohand"] },
    env: {
      prefixes: ["AUTOHAND_"],
    },
    stateRoots: [".autohand"],
  },
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Autohand Code"),
  permissionModes: brokerModes("default"),
  reapplySessionMode: true,
  terminalAuth: { methodId: "autohand-setup", args: ["--setup"] },
})
export const codebuddyAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "codebuddy",
  label: "CodeBuddy",
  commandNames: ["codebuddy"],
  launch: {
    id: "codebuddy",
    match: { kind: "base", values: ["codebuddy"] },
    env: {
      prefixes: ["CODEBUDDY_"],
    },
    stateRoots: [".codebuddy"],
  },
  validateConfiguration: rejectUnmediatedMandatoryApprovals("CodeBuddy"),
  // Upstream plan inherits the preceding native policy. Cognia's plan broker
  // therefore runs against default rather than inheriting a native bypass.
  permissionModes: brokerModes("default", "default"),
  reapplySessionMode: true,
  // Upstream explicitly treats this flag as a permission bypass.
  launchEnv: { CODEBUDDY_IS_SANDBOX: "", CODEBUDDY_SUBAGENT_PERMISSION_MODE: "ignore" },
})
export const commandCodeAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "command-code",
  label: "Command Code",
  commandNames: ["cmdc", "commandcode", "command-code"],
  launch: {
    id: "command-code",
    match: { kind: "base", values: ["commandcode"] },
    stateRoots: [".commandcode"],
  },
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Command Code"),
  permissionModes: brokerModes("default"),
  reapplySessionMode: true,
  sseMcpServersUnsupported:
    "Command Code does not accept legacy SSE MCP servers; use streamable HTTP",
})
export const kilocodeAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "kilocode",
  label: "Kilo Code",
  commandNames: ["kilo"],
  launch: {
    id: "kilocode",
    match: { kind: "base", values: ["kilo"] },
    env: {
      prefixes: ["KILO_"],
    },
    stateRoots: [".config/kilo", ".local/share/kilo", ".local/state/kilo", ".cache/kilo"],
  },
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Kilo Code"),
  permissionModes: brokerModes("build"),
  reapplySessionMode: true,
})
export const mistralVibeAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "mistral-vibe",
  label: "Mistral Vibe",
  commandNames: ["vibe-acp"],
  launch: {
    id: "mistral-vibe",
    match: { kind: "base", values: ["vibe-acp"] },
    env: {
      prefixes: ["MISTRAL_", "VIBE_"],
    },
    stateRoots: [".vibe"],
    isolation: {
      env: { VIBE_HOME: "vibe" },
      denyReadable: [".vibe"],
    },
    relocation: { env: ["VIBE_HOME"], temp: "tmp" },
  },
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Mistral Vibe"),
  // v3 modes are agent names, and no native plan agent is advertised.
  permissionModes: brokerModes("ask", "ask"),
  reapplySessionMode: true,
})
export const mimoCodeAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "mimo-code",
  label: "MiMo Code",
  commandNames: ["mimo"],
  launch: {
    id: "mimo-code",
    match: { kind: "base", values: ["mimo"] },
    env: {
      prefixes: ["MIMOCODE_"],
    },
    stateRoots: [
      ".config/mimocode",
      ".local/share/mimocode",
      ".local/state/mimocode",
      ".cache/mimocode",
    ],
    isolation: {
      env: { MIMOCODE_HOME: "mimocode" },
      denyReadable: [
        ".config/mimocode",
        ".local/share/mimocode",
        ".local/state/mimocode",
        ".cache/mimocode",
      ],
    },
    relocation: { env: ["MIMOCODE_HOME"], temp: "tmp" },
  },
  validateConfiguration: rejectUnmediatedMandatoryApprovals("MiMo Code"),
  permissionModes: brokerModes("build"),
  reapplySessionMode: true,
  terminalAuth: { methodId: "opencode-login", command: "mimo", args: ["auth", "login"] },
  launchEnv: { MIMOCODE_ENABLE_QUESTION_TOOL: "0" },
})
export const hermesAgentAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "hermes-agent",
  label: "Hermes Agent",
  commandNames: ["hermes", "hermes-acp"],
  launch: {
    id: "hermes-agent",
    match: { kind: "base", values: ["hermes"] },
    env: {
      prefixes: ["HERMES_"],
    },
    stateRoots: [".hermes"],
    isolation: {
      env: { HERMES_HOME: "hermes" },
      denyReadable: [".hermes"],
    },
    relocation: { env: ["HERMES_HOME"], temp: "tmp" },
  },
  permissionModes: brokerModes("default", "default"),
  reapplySessionMode: true,
  validateConfiguration: (
    config: import("@cognia/agent-contracts/external-agent").ExternalAgentConfig
  ) => {
    rejectUnmediatedMandatoryApprovals("Hermes Agent")(config)
    if (config.stateIsolation !== "isolated")
      throw new Error(
        "Hermes requires isolated native state; configure provider credentials with native setup in its Cognia-owned HERMES_HOME"
      )
  },
  requiresControlledDaemon: true,
  launchEnv: { HERMES_TUI_GATEWAY_URL: "" },
  // A transport exit only detaches the ACP viewer from Hermes' gateway.
  cancelAcknowledgementTimeoutMs: 10000,
})
export const ohMyPiAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "oh-my-pi",
  label: "oh-my-pi",
  commandNames: ["omp"],
  launch: {
    id: "oh-my-pi",
    match: { kind: "base", values: ["omp"] },
    env: {
      prefixes: ["OMP_"],
    },
    stateRoots: [".omp"],
  },
  validateConfiguration: rejectUnmediatedMandatoryApprovals("oh-my-pi"),
  permissionModes: brokerModes("default", "plan", ["default", "plan", "bypassPermissions"]),
  reapplySessionMode: true,
  requiresGuardedClientPorts: true,
  promptUsage: ohMyPiPromptUsage,
  usageUpdateScope: "session_context",
})
export const museAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "muse",
  label: "Muse Code",
  commandNames: ["muse-acp"],
  launch: {
    id: "muse",
    match: { kind: "base", values: ["muse-acp"] },
    env: {
      prefixes: ["MUSE_"],
    },
    stateRoots: [".config/muse", ".local/state/muse-acp"],
  },
  permissionModes: brokerModes("default", "default"),
  validateConfiguration: rejectUnmediatedMandatoryApprovals("Muse Code"),
  terminalAuth: { methodId: "muse-login", command: "muse", args: ["login"] },
  requiresSessionMcpHttpGrant: true,
  launchEnv: {
    MUSE_APPROVAL_MODE: "promptUnmatched",
    MUSE_EDITOR_TOOLS: "1",
    MUSE_ALLOW_UNSCOPED_READS: "0",
  },
  sseMcpServersUnsupported: "Muse Code does not accept SSE MCP servers; use stdio or HTTP",
})
export const ampAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "amp",
  label: "Amp",
  commandNames: ["amp-acp"],
  launch: {
    id: "amp",
    match: { kind: "base", values: ["amp-acp"] },
    env: {
      prefixes: ["AMP_"],
    },
    stateRoots: [".config/amp", ".local/share/amp", ".local/state/amp-acp"],
  },
  launchEnv: { AMP_ACP_CONTINUE_LATEST: "0", AMP_ACP_TRANSPORT: "cli" },
  validateConfiguration: (config) => {
    if (config.requireApprovalFor?.length)
      throw new Error("Amp ACP cannot enforce mandatory host approval rules")
  },
  validateConfigOption: (id, value) => {
    if (id === "execution-environment" && value !== "local")
      throw new Error("Amp Orb execution cannot enforce this host's permissions or MCP policy")
    if (id === "permission" && value !== "default")
      throw new Error("Amp's native bypass switch is not a Cognia permission mode")
  },
  permissionModes: {
    supportedCanonicalModes: ["bypassPermissions"],
    toNative: (mode: AcpPermissionMode) => {
      if (mode !== "bypassPermissions")
        throw new Error(
          `Amp ACP cannot enforce ${mode}; explicit unrestricted local execution is required`
        )
      return "default"
    },
    toCanonical: () => "bypassPermissions",
    hostApprovalOption: { id: "permission", value: "default" },
  },
  reapplySessionMode: true,
  semantics: {
    cancel: { scope: "turn", reconnectsAfterCancel: false },
    resume: "native",
    fork: "unsupported",
    approvals: "none",
    processModel: "shared",
    usageReport: "turn",
  },
})
export const zcodeAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "zcode",
  label: "ZCode",
  commandNames: ["zcode-acp"],
  launch: {
    id: "zcode",
    match: { kind: "base", values: ["zcode-acp"] },
    env: {
      prefixes: ["ZCODE_"],
    },
    stateRoots: [".zcode", ".zcode-acp"],
  },
  permissionModes: brokerModes("default", "plan", [
    "default",
    "acceptEdits",
    "dontAsk",
    "bypassPermissions",
    "plan",
  ]),
  reapplySessionMode: true,
  terminalAuth: { methodId: "zcode-login", args: ["--login"] },
  promptCapabilityOverrides: { image: false },
  // The standard stdio path owns approval replies; file and one-shot bridges do not.
  launchEnv: { ZCODE_ACP_APPROVAL_BRIDGE: "0", ZCODE_ACP_APPROVAL_DIR: "" },
})

export const CATALOG_EXPANSION_ACP_PROFILES = Object.freeze([
  auggieAcpProfile,
  autohandCodeAcpProfile,
  codebuddyAcpProfile,
  commandCodeAcpProfile,
  kilocodeAcpProfile,
  mistralVibeAcpProfile,
  mimoCodeAcpProfile,
  hermesAgentAcpProfile,
  ohMyPiAcpProfile,
  museAcpProfile,
  ampAcpProfile,
  zcodeAcpProfile,
])
