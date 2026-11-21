import { ACP_VENDOR_PROFILES } from "../vendor-profiles"
import {
  ampAcpProfile,
  autohandCodeAcpProfile,
  codebuddyAcpProfile,
  kilocodeAcpProfile,
  mistralVibeAcpProfile,
  mimoCodeAcpProfile,
  museAcpProfile,
  ohMyPiAcpProfile,
  zcodeAcpProfile,
} from "./catalog-expansion"

describe("audited ACP integrations", () => {
  it("resolves every newly wired agent without confusing sibling runtimes", () => {
    for (const id of [
      "auggie",
      "autohand-code",
      "codebuddy",
      "command-code",
      "kilocode",
      "mistral-vibe",
      "mimo-code",
      "hermes-agent",
      "oh-my-pi",
      "muse",
      "amp",
      "zcode",
    ])
      expect(ACP_VENDOR_PROFILES.some((profile) => profile.id === id)).toBe(true)
    expect(ohMyPiAcpProfile.commandNames).toEqual(["omp"])
  })

  it("does not pretend Amp can honor host approval lists or restrictive modes", () => {
    expect(() => ampAcpProfile.permissionModes!.toNative("default")).toThrow("cannot enforce")
    expect(ampAcpProfile.permissionModes!.toNative("bypassPermissions")).toBe("default")
    expect(() =>
      ampAcpProfile.validateConfiguration!({ requireApprovalFor: ["Bash"] } as never)
    ).toThrow("approval")
    expect(() => ampAcpProfile.validateConfigOption!("execution-environment", "orb")).toThrow("Orb")
  })

  it("refuses mandatory approval lists when native allow rules can skip ACP callbacks", () => {
    for (const id of [
      "auggie",
      "autohand-code",
      "codebuddy",
      "command-code",
      "kilocode",
      "mistral-vibe",
      "mimo-code",
      "muse",
      "hermes-agent",
      "oh-my-pi",
    ]) {
      const profile = ACP_VENDOR_PROFILES.find((entry) => entry.id === id)!
      expect(() => profile.validateConfiguration!({ requireApprovalFor: ["*"] } as never)).toThrow(
        "mandatory host approval"
      )
      expect(() =>
        profile.validateConfiguration!({
          requireApprovalFor: [],
          stateIsolation: "isolated",
        } as never)
      ).not.toThrow()
    }
  })

  it("restores approval-capable native modes without inheriting upstream auto-approval", () => {
    for (const [profile, execute] of [
      [autohandCodeAcpProfile, "default"],
      [codebuddyAcpProfile, "default"],
      [kilocodeAcpProfile, "build"],
      [mistralVibeAcpProfile, "ask"],
    ] as const) {
      expect(profile.reapplySessionMode).toBe(true)
      expect(profile.permissionModes!.toNative("default")).toBe(execute)
      for (const mode of ["dontAsk", "plan", "acceptEdits"] as const)
        expect(() => profile.permissionModes!.toNative(mode)).toThrow("cannot enforce")
      expect(profile.permissionModes!.toCanonical(execute, "default")).toBe("default")
      expect(profile.permissionModes!.toCanonical("unrecognized-permissive-mode", "dontAsk")).toBe(
        "default"
      )
    }
  })

  it("maps oh-my-pi native plan mode without escalating unknown modes to bypassPermissions", () => {
    const modes = ohMyPiAcpProfile.permissionModes!
    expect(modes.supportedCanonicalModes).toEqual(["default", "plan", "bypassPermissions"])
    expect(modes.toNative("plan")).toBe("plan")
    expect(modes.toNative("default")).toBe("default")
    expect(modes.toNative("bypassPermissions")).toBe("default")
    for (const mode of ["dontAsk", "acceptEdits"] as const)
      expect(() => modes.toNative(mode)).toThrow("cannot enforce")
    expect(modes.toCanonical("plan", "bypassPermissions")).toBe("plan")
    expect(modes.toCanonical("plan", "default")).toBe("plan")
    expect(modes.toCanonical("default", "plan")).toBe("default")
    expect(modes.toCanonical("default", "bypassPermissions")).toBe("bypassPermissions")
    expect(modes.toCanonical("unknown-mode", "bypassPermissions")).toBe("default")
  })

  it("projects oh-my-pi per-turn promptUsage directly and marks usage_update as session_context", () => {
    expect(ohMyPiAcpProfile.usageUpdateScope).toBe("session_context")
    const promptUsage = ohMyPiAcpProfile.promptUsage!
    expect(
      promptUsage({
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          totalTokens: 12,
          cachedReadTokens: 4,
          cachedWriteTokens: 1,
          thoughtTokens: 3,
        },
      })
    ).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
    })
    // Missing, all-zero, negative, float, and invalid shapes stay unknown.
    expect(promptUsage({})).toBeUndefined()
    expect(promptUsage({ usage: null })).toBeUndefined()
    expect(
      promptUsage({ usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
    ).toBeUndefined()
    expect(
      promptUsage({ usage: { inputTokens: -1, outputTokens: 2, totalTokens: 1 } })
    ).toBeUndefined()
    expect(
      promptUsage({ usage: { inputTokens: 1.5, outputTokens: 2, totalTokens: 3 } })
    ).toBeUndefined()
    expect(
      promptUsage({
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, cachedReadTokens: -5 },
      })
    ).toBeUndefined()
  })

  it("extracts structured oh-my-pi promptFailure without guessing prose (#10)", () => {
    const promptFailure = ohMyPiAcpProfile.promptFailure!
    expect(promptFailure({ stopReason: "end_turn" })).toBeUndefined()
    expect(promptFailure({ stopReason: "end_turn", _meta: {} })).toBeUndefined()
    expect(promptFailure({ stopReason: "error" })).toBe("oh-my-pi reported a prompt error")
    expect(promptFailure({ stopReason: "end_turn", _meta: { error: "model_not_supported" } })).toBe(
      "model_not_supported"
    )
    expect(
      promptFailure({
        stopReason: "end_turn",
        _meta: { omp: { error: { message: "HTTP 400 invalid model" } } },
      })
    ).toBe("HTTP 400 invalid model")
  })

  it("projects _omp/compaction/start and _omp/compaction/end notifications (#18)", () => {
    const notify = ohMyPiAcpProfile.notification!
    const ts = new Date("2026-11-21T00:00:00.000Z")
    expect(
      notify(
        "_omp/compaction/start",
        { sessionId: "s1", reason: "threshold", action: "compact" },
        ts
      )
    ).toEqual({
      type: "compaction_update",
      sessionId: "s1",
      timestamp: ts,
      compaction: {
        sessionUpdate: "compaction_update",
        compactionId: "omp-auto-compaction",
        status: "in_progress",
        error: null,
        _meta: { source: "oh-my-pi", reason: "threshold", action: "compact" },
      },
    })
    expect(
      notify(
        "_omp/compaction/end",
        { sessionId: "s1", action: "compact", aborted: false, skipped: false, tokensBefore: 96000 },
        ts
      )
    ).toMatchObject({
      type: "compaction_update",
      compaction: {
        status: "completed",
        error: null,
        _meta: { source: "oh-my-pi", tokensBefore: 96000 },
      },
    })
    expect(notify("_omp/compaction/end", { sessionId: "s1", aborted: true }, ts)).toMatchObject({
      type: "compaction_update",
      compaction: { status: "cancelled" },
    })
    expect(
      notify("_omp/compaction/end", { sessionId: "s1", errorMessage: "context overflow" }, ts)
    ).toMatchObject({
      type: "compaction_update",
      compaction: { status: "failed", error: "context overflow" },
    })
    expect(notify("_omp/compaction/start", {}, ts)).toBeNull()
    expect(notify("_omp/unknown", { sessionId: "s1" }, ts)).toBeNull()
  })

  it("does not expose strict policy ceilings for native pre-approved tools", () => {
    for (const id of [
      "auggie",
      "autohand-code",
      "codebuddy",
      "command-code",
      "kilocode",
      "mistral-vibe",
      "mimo-code",
      "hermes-agent",
      "muse",
    ]) {
      const modes = ACP_VENDOR_PROFILES.find((profile) => profile.id === id)!.permissionModes!
      expect(modes.supportedCanonicalModes).toEqual(["default", "bypassPermissions"])
      for (const mode of ["plan", "dontAsk", "acceptEdits"] as const)
        expect(() => modes.toNative(mode)).toThrow("cannot enforce")
      expect(modes.toCanonical("plan", "plan")).toBe("default")
    }
  })

  it("corrects MiMo terminal auth and retains Muse's per-tool boundary", () => {
    expect(mimoCodeAcpProfile.terminalAuth).toEqual({
      methodId: "opencode-login",
      command: "mimo",
      args: ["auth", "login"],
    })
    expect(museAcpProfile.launchEnv).toMatchObject({
      MUSE_APPROVAL_MODE: "promptUnmatched",
      MUSE_EDITOR_TOOLS: "1",
      MUSE_ALLOW_UNSCOPED_READS: "0",
    })
    expect(zcodeAcpProfile.promptCapabilityOverrides).toEqual({ image: false })
  })
})
