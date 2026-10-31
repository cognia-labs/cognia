import { settingsFromClaudeCode } from "./claude-code"

describe("settingsFromClaudeCode", () => {
  it("maps model, effort, output style, permissions, and marks hooks shared", () => {
    const drafts = settingsFromClaudeCode(
      { defaultModel: "old", agentPermissions: { toolRules: { Bash: "ask" } } },
      {
        model: "claude-opus-5",
        effortLevel: "high",
        outputStyle: "concise",
        permissions: { ask: ["Read", "Bash"], deny: ["Write"] },
        hooks: { Notification: [{ hooks: [] }] },
      }
    )
    expect(drafts.map((draft) => [draft.target, draft.incoming])).toEqual(
      expect.arrayContaining([
        ["defaultModel", "claude-opus-5"],
        ["defaultEffort", "high"],
        ["outputStyle", "concise"],
        ["agentPermissions.toolRules", { Read: "ask", Bash: "ask", Write: "deny" }],
      ])
    )
    expect(drafts.find((draft) => draft.target === "claudeHooks")).toMatchObject({
      supported: true,
      shared: true,
    })
  })

  it("drops allow rules while keeping deny and ask rules importable", () => {
    const drafts = settingsFromClaudeCode(
      {},
      {
        permissions: {
          allow: ["Bash(npm test)"],
          ask: ["Read"],
          deny: ["Bash(rm -rf *)"],
        },
      }
    )
    const policy = drafts.find((draft) => draft.key === "permissions")!
    expect(policy).toMatchObject({
      target: "agentPermissions.toolRules",
      supported: true,
      incoming: { Read: "ask", "Bash(rm -rf *)": "deny" },
    })
    expect(policy.incoming).toEqual({ Read: "ask", "Bash(rm -rf *)": "deny" })
    expect(policy.warnings).toHaveLength(1)
    expect(policy.warnings[0]).toContain("1 allow rule was not imported")
    expect(policy.warnings[0]).toContain("manually")
  })

  it("marks an allow-only permission policy unsupported after filtering", () => {
    const drafts = settingsFromClaudeCode({}, { permissions: { allow: ["Read", "Bash(*)"] } })
    const policy = drafts.find((draft) => draft.key === "permissions")!
    expect(policy).toMatchObject({ target: "unsupported", supported: false, incoming: {} })
    expect(policy.incoming).toEqual({})
    expect(policy.warnings).toHaveLength(1)
    expect(policy.warnings[0]).toContain("2 allow rules were not imported")
    expect(policy.warnings[0]).toContain("manually")
  })

  it("reports a permission-bypass default as unsupported for safety", () => {
    const drafts = settingsFromClaudeCode({}, { permissions: { defaultMode: "bypassPermissions" } })
    const policy = drafts.find((draft) => draft.key === "defaultMode")!
    expect(policy).toMatchObject({ target: "unsupported", supported: false })
    expect(policy.warnings.join(" ")).toContain("not imported")
    expect(policy.warnings.join(" ")).toContain("manually")
  })
})
