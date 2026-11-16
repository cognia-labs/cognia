import { SUBAGENT_SOURCE_ADAPTERS } from "./index"
import type {
  ApplyImportResult,
  ImportMergeStrategy,
  ImportTarget,
  SubagentImportDraft,
  SubagentSourceId,
} from "./types"

// Type contract of the importer pipeline: every source id the union names has
// exactly one registered adapter, and a draft built from the union round-trips
// through the shapes the apply step and the import dialog read.

const ALL_SOURCES = {
  "claude-code": true,
  "codex-cli": true,
  opencode: true,
  cursor: true,
  cline: true,
  pi: true,
  "generic-md": true,
} satisfies Record<SubagentSourceId, true>

describe("subagent importer types", () => {
  it("registers one adapter per SubagentSourceId", () => {
    const ids = SUBAGENT_SOURCE_ADAPTERS.map((a) => a.id)
    expect([...ids].sort()).toEqual(Object.keys(ALL_SOURCES).sort())
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("keeps the draft, target, strategy and result shapes the apply step reads", () => {
    const draft: SubagentImportDraft = {
      source: "claude-code",
      sourceKey: "claude-code:code-reviewer",
      name: "Code Reviewer",
      systemPrompt: "Review the diff.",
      sourceFile: ".claude/agents/code-reviewer.md",
      warnings: [],
    }
    const targets: ImportTarget[] = ["subagent-template", "character"]
    const strategies: ImportMergeStrategy[] = ["skip", "overwrite", "duplicate"]
    const result: ApplyImportResult = { imported: 1, skipped: 0, overwritten: 0, failed: [] }
    expect(draft.sourceKey.startsWith(`${draft.source}:`)).toBe(true)
    expect(targets).toHaveLength(2)
    expect(strategies).toHaveLength(3)
    expect(result.imported + result.skipped + result.overwritten + result.failed.length).toBe(1)
  })
})
