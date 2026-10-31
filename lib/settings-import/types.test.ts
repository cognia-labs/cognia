import { isSettingsImportDraft, settingsDraft, type SettingsImportTarget } from "./types"

describe("isSettingsImportDraft", () => {
  it("accepts a complete draft and rejects unsupported shapes", () => {
    expect(
      isSettingsImportDraft({
        id: "codex:model",
        source: "codex",
        group: "model",
        key: "model",
        target: "defaultModel",
        current: "old",
        incoming: "new",
        warnings: [],
        supported: true,
        shared: false,
      })
    ).toBe(true)
    expect(isSettingsImportDraft({ source: "cursor" })).toBe(false)
  })
})

describe("settingsDraft safety policy", () => {
  it.each<[SettingsImportTarget, unknown]>([
    ["permissionMode", "bypassPermissions"],
    ["sandboxDefaultEnabled", false],
    ["workspaceConfinementEnabled", false],
  ])("marks %s = %j unsupported even when explicitly supported", (target, incoming) => {
    const draft = settingsDraft("codex", "permissions", "policy", target, undefined, incoming, {
      supported: true,
      warnings: ["Existing warning."],
    })
    expect(draft).toMatchObject({ target: "unsupported", supported: false, incoming })
    expect(draft.warnings).toContain("Existing warning.")
    expect(draft.warnings.join(" ")).toContain("not imported")
    expect(draft.warnings.join(" ")).toContain("manually")
  })

  it("filters allow rules without mutating the source or discarding safe entries", () => {
    const incoming = Object.freeze({
      "*": "allow",
      Read: "allow",
      Write: "deny",
      Edit: "ask",
      Bash: Object.freeze({ "npm test": "allow", "rm *": "deny", "*": "ask" }),
      Glob: Object.freeze({ "*": "allow" }),
    })
    const draft = settingsDraft(
      "opencode",
      "permissions",
      "permission",
      "agentPermissions.toolRules",
      undefined,
      incoming
    )
    expect(draft).toMatchObject({ target: "agentPermissions.toolRules", supported: true })
    expect(draft.incoming).toEqual({
      Write: "deny",
      Edit: "ask",
      Bash: { "rm *": "deny", "*": "ask" },
    })
    expect(draft.warnings).toHaveLength(1)
    expect(draft.warnings[0]).toContain("4 allow rules were not imported")
    expect(draft.warnings[0]).toContain("manually")
  })

  it("marks a ruleset unsupported only when no safe rules remain", () => {
    const draft = settingsDraft(
      "opencode",
      "permissions",
      "permission",
      "agentPermissions.toolRules",
      undefined,
      { "*": "allow", Bash: { "*": "allow" } }
    )
    expect(draft).toMatchObject({ target: "unsupported", supported: false, incoming: {} })
    expect(draft.incoming).toEqual({})
    expect(draft.warnings).toHaveLength(1)
    expect(draft.warnings[0]).toContain("2 allow rules were not imported")
  })

  it("does not warn when tool rules contain only ask and deny", () => {
    const incoming = { Read: "ask", Bash: { "rm *": "deny" } }
    const draft = settingsDraft(
      "opencode",
      "permissions",
      "permission",
      "agentPermissions.toolRules",
      undefined,
      incoming
    )
    expect(draft).toMatchObject({
      target: "agentPermissions.toolRules",
      supported: true,
      incoming,
      warnings: [],
    })
  })
})
