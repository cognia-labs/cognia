import type { AcpVendorProfile } from "../vendor-profile"

/**
 * Kimi Code over ACP. Its native `auto` also skips shell approvals, so every
 * executable mode except `bypassPermissions` maps to `default` and the host's
 * broker keeps edit-only and deny-unapproved policies. A fork stays in the
 * source workspace and ignores MCP servers, which are bound by reload.
 */
export const kimiAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "kimi",
  label: "Kimi",
  commandNames: ["kimi"],
  launch: {
    id: "kimi",
    match: { kind: "base", values: ["kimi"] },
    // Kimi also reads OAuth, identity and executable hooks from KIMI_*; only
    // its reviewed model and runtime contract reaches it.
    env: {
      keys: [
        "KIMI_CODE_HOME",
        "KIMI_CODE_NO_AUTO_UPDATE",
        "KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT",
        "KIMI_DISABLE_TELEMETRY",
        "KIMI_MODEL_NAME",
        "KIMI_MODEL_PROVIDER_TYPE",
        "KIMI_MODEL_BASE_URL",
        "KIMI_MODEL_API_KEY",
        "KIMI_MODEL_CAPABILITIES",
        "KIMI_MODEL_DISPLAY_NAME",
        "KIMI_MODEL_MAX_CONTEXT_SIZE",
        "KIMI_MODEL_MAX_OUTPUT_SIZE",
        "KIMI_MODEL_MAX_COMPLETION_TOKENS",
        "KIMI_MODEL_REASONING_KEY",
        "KIMI_MODEL_ADAPTIVE_THINKING",
        "KIMI_MODEL_TEMPERATURE",
        "KIMI_MODEL_TOP_P",
        "KIMI_MODEL_THINKING_EFFORT",
        "KIMI_MODEL_THINKING_KEEP",
        "KIMI_MCP_STARTUP_TIMEOUT_MS",
        "KIMI_MCP_TOOL_TIMEOUT_MS",
        "KIMI_LOOP_MAX_STEPS_PER_TURN",
        "KIMI_LOOP_MAX_ATTEMPTS_PER_STEP",
      ],
      reviewedPrefixes: ["KIMI_"],
    },
    stateRoots: [".kimi-code"],
    relocation: {
      env: ["KIMI_CODE_HOME"],
      default: ".kimi-code",
      temp: "tmp",
      setEnv: { KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT: "0" },
    },
    isolation: {
      env: { KIMI_CODE_HOME: "kimi" },
      denyReadable: [".kimi-code", ".kimi"],
    },
  },
  permissionModes: {
    toNative: (mode) =>
      mode === "plan" ? "plan" : mode === "bypassPermissions" ? "yolo" : "default",
    toCanonical: (nativeMode, current) => {
      if (nativeMode === "plan") return "plan"
      if (nativeMode === "yolo") return "bypassPermissions"
      if (
        nativeMode === "default" &&
        current &&
        kimiAcpProfile.permissionModes!.toNative(current) === nativeMode
      )
        return current
      return "default"
    },
  },
  // Kimi ACP acknowledges background begin(), without a terminal result.
  // /tasks uses a separate task service and cannot confirm compaction.
  compactionCompletionUnavailable: {
    reason: "kimi_acp_compaction_completion_unavailable",
    message:
      "Kimi ACP compaction completion capability is unavailable; native /compact only starts background work",
  },
  fork: {
    inheritsSourceWorkspace: true,
    requiresDistinctSessionId: true,
    rebindsMcpByReload: true,
  },
})
