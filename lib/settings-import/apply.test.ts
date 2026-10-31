import { applySettingsImport } from "./apply"
import { settingsFromCodex } from "./adapters/codex"
import { settingsFromClaudeCode } from "./adapters/claude-code"
import type { SettingsImportDraft, SettingsImportMergeStrategy, SettingsSnapshot } from "./types"

const draft = (overrides: Partial<SettingsImportDraft>): SettingsImportDraft => ({
  id: "opencode:model",
  source: "opencode",
  group: "model",
  key: "model",
  target: "defaultModel",
  current: "old",
  incoming: "new",
  warnings: [],
  supported: true,
  shared: false,
  ...overrides,
})

describe("applySettingsImport", () => {
  it.each<SettingsImportMergeStrategy>(["overwrite", "skip", "duplicate"])(
    "strips only allow entries from a hand-built tool-rules draft under %s",
    async (strategy) => {
      const save = jest.fn()
      const incoming = Object.freeze({
        "*": "allow",
        Read: "allow",
        Write: "deny",
        Edit: "ask",
        Bash: Object.freeze({ "npm test": "allow", "rm *": "deny", "*": "ask" }),
        Glob: Object.freeze({ "*": "allow" }),
      })
      const result = await applySettingsImport(
        [draft({ target: "agentPermissions.toolRules", incoming, current: undefined })],
        ["opencode:model"],
        strategy,
        {
          currentSettings: () => ({ agentPermissions: { commandRules: { "git push*": "ask" } } }),
          save,
          readClaudeUserSettings: jest.fn(),
          writeClaudeUserSettings: jest.fn(),
        }
      )
      expect(save).toHaveBeenCalledTimes(1)
      expect(save).toHaveBeenCalledWith({
        agentPermissions: {
          commandRules: { "git push*": "ask" },
          toolRules: { Write: "deny", Edit: "ask", Bash: { "rm *": "deny", "*": "ask" } },
        },
      })
      expect(result).toMatchObject({ applied: 1, skipped: 0 })
      expect(result.warnings).toHaveLength(1)
      expect(result.warnings[0]).toContain("4 allow rules were not imported")
      expect(result.warnings[0]).toContain("manually")
    }
  )

  it("imports Claude deny rules with only the preview's allow-removal warning", async () => {
    const save = jest.fn()
    const drafts = settingsFromClaudeCode(
      {},
      {
        permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm -rf *)"] },
      }
    )
    const result = await applySettingsImport(drafts, ["claude-code:permissions"], "overwrite", {
      currentSettings: () => ({}),
      save,
      readClaudeUserSettings: jest.fn(),
      writeClaudeUserSettings: jest.fn(),
    })
    expect(save).toHaveBeenCalledWith({
      agentPermissions: { toolRules: { "Bash(rm -rf *)": "deny" } },
    })
    expect(result).toMatchObject({ applied: 1, skipped: 0 })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("1 allow rule was not imported")
  })

  it.each<SettingsImportMergeStrategy>(["overwrite", "skip", "duplicate"])(
    "refuses forged unsafe drafts under %s even when current values are unset",
    async (strategy) => {
      const save = jest.fn()
      const writeClaudeUserSettings = jest.fn()
      const drafts = [
        draft({
          id: "bypass",
          target: "permissionMode",
          incoming: "bypassPermissions",
          current: undefined,
        }),
        draft({
          id: "sandbox-off",
          target: "sandboxDefaultEnabled",
          incoming: false,
          current: undefined,
        }),
        draft({
          id: "unconfined",
          target: "workspaceConfinementEnabled",
          incoming: false,
          current: undefined,
        }),
        draft({
          id: "allow",
          target: "agentPermissions.toolRules",
          incoming: { Bash: "allow" },
          current: undefined,
        }),
      ]
      const result = await applySettingsImport(
        drafts,
        drafts.map((draft) => draft.id),
        strategy,
        {
          currentSettings: () => ({}),
          save,
          readClaudeUserSettings: jest.fn(),
          writeClaudeUserSettings,
        }
      )
      expect(save).not.toHaveBeenCalled()
      expect(writeClaudeUserSettings).not.toHaveBeenCalled()
      expect(result).toMatchObject({ applied: 0, skipped: drafts.length })
      expect(result.warnings).toHaveLength(drafts.length)
      for (const warning of result.warnings) {
        expect(warning).toContain("not imported")
        expect(warning).toContain("manually")
      }
    }
  )

  it.each<SettingsSnapshot>([
    {},
    { permissionMode: "default", sandboxDefaultEnabled: true, workspaceConfinementEnabled: true },
  ])("keeps safety settings unchanged when importing Codex with overwrite: %j", async (current) => {
    const save = jest.fn()
    const drafts = settingsFromCodex(current, {
      model: "gpt-5.4",
      approval_policy: "never",
      sandbox_mode: "danger-full-access",
    })
    const result = await applySettingsImport(
      drafts,
      drafts.map((draft) => draft.id),
      "overwrite",
      {
        currentSettings: () => current,
        save,
        readClaudeUserSettings: jest.fn(),
        writeClaudeUserSettings: jest.fn(),
      }
    )
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith({ defaultModel: "gpt-5.4" })
    expect(result).toMatchObject({ applied: 1, skipped: 3 })
    expect(result.warnings).toHaveLength(3)
  })

  it("writes only selected supported settings and merges nested tool rules", async () => {
    const save = jest.fn(async () => undefined)
    const result = await applySettingsImport(
      [
        draft({}),
        draft({
          id: "opencode:permissions",
          group: "permissions",
          target: "agentPermissions.toolRules",
          incoming: { edit: "deny" },
        }),
        draft({ id: "opencode:theme", key: "theme", supported: false }),
      ],
      ["opencode:model", "opencode:permissions", "opencode:theme"],
      "overwrite",
      {
        currentSettings: () => ({ agentPermissions: { commandRules: { "git push*": "ask" } } }),
        save,
        readClaudeUserSettings: jest.fn(),
        writeClaudeUserSettings: jest.fn(),
      }
    )
    expect(save).toHaveBeenCalledWith({
      defaultModel: "new",
      agentPermissions: {
        commandRules: { "git push*": "ask" },
        toolRules: { edit: "deny" },
      },
    })
    expect(result).toMatchObject({ applied: 2, skipped: 1 })
  })

  it("patches Claude hooks without dropping unknown settings", async () => {
    const writeClaudeUserSettings = jest.fn(async () => ({ path: "/settings.json" }))
    await applySettingsImport(
      [
        draft({
          id: "codex:hooks",
          source: "codex",
          group: "hooks",
          target: "claudeHooks",
          current: undefined,
          incoming: { Notification: [{ hooks: [{ type: "command", command: "notify" }] }] },
        }),
      ],
      ["codex:hooks"],
      "overwrite",
      {
        currentSettings: () => ({}),
        save: jest.fn(),
        readClaudeUserSettings: jest.fn(async () => ({ model: "keep", extra: { future: true } })),
        writeClaudeUserSettings,
      }
    )
    expect(writeClaudeUserSettings).toHaveBeenCalledWith({
      model: "keep",
      extra: { future: true },
      hooks: { Notification: [{ hooks: [{ type: "command", command: "notify" }] }] },
    })
  })
})
