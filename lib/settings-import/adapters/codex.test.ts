import { settingsFromCodex } from "./codex"

describe("settingsFromCodex", () => {
  it("maps model, effort, approval, and sandbox without hiding unsupported policies", () => {
    const drafts = settingsFromCodex(
      {},
      {
        model: "gpt-5.4",
        model_reasoning_effort: "high",
        approval_policy: "never",
        sandbox_mode: "read-only",
        shell_environment_policy: { include_only: ["PATH"] },
        notify: ["terminal-notifier"],
      }
    )
    expect(drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: "defaultModel", incoming: "gpt-5.4", supported: true }),
        expect.objectContaining({ target: "defaultEffort", incoming: "high", supported: true }),
        expect.objectContaining({ key: "approvalPolicy", target: "unsupported", supported: false }),
        expect.objectContaining({ target: "sandboxDefaultEnabled", incoming: true }),
        expect.objectContaining({ key: "shellEnvironmentPolicy", supported: false }),
        expect.objectContaining({ key: "notify", supported: false }),
      ])
    )
  })

  it("does not offer Codex's no-approval policy for import", () => {
    const [draft] = settingsFromCodex({}, { approval_policy: "never" })
    expect(draft).toMatchObject({ target: "unsupported", supported: false })
    expect(draft.warnings.join(" ")).toContain("not imported")
    expect(draft.warnings.join(" ")).toContain("manually")
    expect(draft.warnings.join(" ")).not.toContain("This imports")
  })

  it("does not offer sandbox or workspace-confinement opt-outs for import", () => {
    const drafts = settingsFromCodex({}, { sandbox_mode: "danger-full-access" })
    expect(drafts).toHaveLength(2)
    for (const draft of drafts) {
      expect(draft).toMatchObject({ target: "unsupported", supported: false })
      expect(draft.warnings.join(" ")).toContain("not imported")
      expect(draft.warnings.join(" ")).toContain("manually")
    }
  })

  it.each([
    ["on-failure", "acceptEdits"],
    ["on-request", "default"],
    ["untrusted", "default"],
  ])("keeps the lower-risk %s approval mapping", (approval_policy, mode) => {
    expect(settingsFromCodex({}, { approval_policy })).toEqual([
      expect.objectContaining({ target: "permissionMode", incoming: mode, supported: true }),
    ])
  })

  it.each(["read-only", "workspace-write"])("keeps the sandbox on for %s", (sandbox_mode) => {
    expect(settingsFromCodex({}, { sandbox_mode })).toEqual([
      expect.objectContaining({ target: "sandboxDefaultEnabled", incoming: true, supported: true }),
      expect.objectContaining({
        target: "workspaceConfinementEnabled",
        incoming: true,
        supported: true,
      }),
    ])
  })
})
