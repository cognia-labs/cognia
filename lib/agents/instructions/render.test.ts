import { renderInstructions } from "./render"
import { resolveInstructionsConfig, type InstructionFile } from "./types"

function file(label: string, content: string): InstructionFile {
  return { absPath: `/proj/${label}`, label, source: "project", content }
}

describe("renderInstructions", () => {
  it("renders labelled blocks joined by separators with a preamble", () => {
    const r = renderInstructions(
      [file("CLAUDE.md", "root rules"), file("sub/AGENT.md", "sub rules")],
      resolveInstructionsConfig()
    )
    expect(r.section).toContain("project instruction files")
    expect(r.section).toContain("## CLAUDE.md\n\nroot rules")
    expect(r.section).toContain("## sub/AGENT.md\n\nsub rules")
    expect(r.section).toContain("\n\n---\n\n")
    expect(r.warnings).toHaveLength(0)
  })

  it("returns an empty section when nothing meaningful remains", () => {
    const r = renderInstructions([file("CLAUDE.md", "   ")], resolveInstructionsConfig())
    expect(r.section).toBe("")
  })

  it("caps the file count by dropping the lowest-precedence files and warns", () => {
    // Load order is lowest precedence first: the global file, the root, then
    // the directory nearest the cwd, whose rules override both.
    const files = [
      { ...file("global.md", "global rule"), source: "global" as const },
      file("CLAUDE.md", "root rule"),
      file("sub/AGENTS.md", "sub overrides root"),
    ]
    const r = renderInstructions(files, resolveInstructionsConfig({ maxFiles: 2 }))
    expect(r.files.map((f) => f.label)).toEqual(["CLAUDE.md", "sub/AGENTS.md"])
    expect(r.section).toContain("## sub/AGENTS.md\n\nsub overrides root")
    expect(r.section).not.toContain("## global.md")
    // The kept files stay in precedence order, nearest last.
    expect(r.section.indexOf("## CLAUDE.md")).toBeLessThan(r.section.indexOf("## sub/AGENTS.md"))
    expect(r.warnings[0]).toMatch(/capped at 2/)
    expect(r.warnings[0]).toMatch(/global\.md/)
  })

  it("truncates oversized files and warns", () => {
    const big = "x".repeat(100)
    const r = renderInstructions(
      [file("big.md", big)],
      resolveInstructionsConfig({ maxFileBytes: 10 })
    )
    expect(r.section).toContain("…[truncated]")
    expect(r.warnings[0]).toMatch(/truncated to 10/)
  })
})
