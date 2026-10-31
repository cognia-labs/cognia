import { settingsFromOpencode } from "./opencode"

describe("settingsFromOpencode", () => {
  it("preserves OpenCode permission rules and reports settings with no Cognia equivalent", () => {
    const drafts = settingsFromOpencode(
      {},
      {
        model: "anthropic/claude-sonnet-5",
        permission: { edit: "deny", bash: { "git push*": "deny", "*": "ask" } },
        theme: "tokyonight",
        instructions: ["CONTRIBUTING.md"],
        share: "manual",
        autoupdate: true,
      }
    )
    expect(drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "defaultModel", incoming: "anthropic/claude-sonnet-5" }),
        expect.objectContaining({
          target: "agentPermissions.toolRules",
          incoming: { edit: "deny", bash: { "git push*": "deny", "*": "ask" } },
        }),
        expect.objectContaining({ key: "theme", supported: false }),
        expect.objectContaining({ key: "instructions", supported: false }),
        expect.objectContaining({ key: "share", supported: false }),
        expect.objectContaining({ key: "autoupdate", supported: false }),
      ])
    )
  })

  it.each(["allow", { "*": "allow" }, { bash: "allow" }, { bash: { "*": "allow" } }])(
    "does not import auto-approval policy %j",
    (permission) => {
      const [policy] = settingsFromOpencode({}, { permission })
      expect(policy).toMatchObject({ target: "unsupported", supported: false, incoming: {} })
      expect(policy.incoming).toEqual({})
      expect(policy.warnings).toHaveLength(1)
      expect(policy.warnings[0]).toContain("1 allow rule was not imported")
      expect(policy.warnings[0]).toContain("manually")
    }
  )

  it("removes top-level and nested allow rules while preserving ask and deny", () => {
    const [policy] = settingsFromOpencode(
      {},
      {
        permission: {
          "*": "allow",
          read: "allow",
          edit: "deny",
          write: "ask",
          bash: { "git status*": "allow", "rm *": "deny", "*": "ask" },
        },
      }
    )
    expect(policy).toMatchObject({ target: "agentPermissions.toolRules", supported: true })
    expect(policy.incoming).toEqual({
      edit: "deny",
      write: "ask",
      bash: { "rm *": "deny", "*": "ask" },
    })
    expect(policy.warnings).toHaveLength(1)
    expect(policy.warnings[0]).toContain("3 allow rules were not imported")
    expect(policy.warnings[0]).toContain("manually")
  })
})
