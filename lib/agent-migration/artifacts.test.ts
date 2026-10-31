jest.mock("@/lib/claude/sync", () => ({
  previewAgentImport: jest.fn(async () => ({ drafts: [], parseError: undefined })),
  importFromAgent: jest.fn(async () => ({ created: 1, updated: 0, skipped: 0 })),
}))

jest.mock("@/lib/session-import", () => ({
  importSessions: jest.fn(),
  resolveScanInput: jest.fn(async () => ({ homeDir: "/home" })),
}))

import { previewAgentImport, importFromAgent } from "@/lib/claude/sync"
import { importSessions, resolveScanInput } from "@/lib/session-import"
import { applyMigrationArtifact, previewMigrationArtifact } from "./artifacts"
import type { MigrationPlan, MigrationPreviewCell } from "./types"

describe("migration artifact delegation", () => {
  it("surfaces every session import failure alongside the successful import count", async () => {
    const refs = [
      { sourceId: "codex", originalSessionId: "bad", locator: "bad.jsonl" },
      { sourceId: "codex", originalSessionId: "missing", locator: "missing.jsonl" },
      { sourceId: "codex", originalSessionId: "good", locator: "good.jsonl" },
    ]
    jest.mocked(importSessions).mockResolvedValueOnce({
      sessions: 1,
      messages: 2,
      lossBySource: {},
      details: [],
      failures: [
        { ref: refs[0], code: "parse-failed", message: "Invalid session JSON" },
        { ref: refs[1], code: "source-unavailable" },
      ],
    })
    const signal = new AbortController().signal
    const result = await applyMigrationArtifact(
      "codex",
      "sessions",
      {
        artifact: "sessions",
        status: "ready",
        count: 3,
        warnings: [],
        items: refs.map((ref) => ({ ref })),
      },
      { vendor: "codex", strategy: "overwrite", projectId: "project" } as MigrationPlan,
      signal
    )
    expect(importSessions).toHaveBeenCalledWith(refs, await resolveScanInput(), "project", {
      signal,
    })
    expect(result).toEqual({
      imported: 1,
      warnings: ["codex:bad: Invalid session JSON", "codex:missing: source-unavailable"],
    })
  })

  it("keeps session imports without failures warning-free", async () => {
    const ref = { sourceId: "codex", originalSessionId: "good", locator: "good.jsonl" }
    jest.mocked(importSessions).mockResolvedValueOnce({
      sessions: 1,
      messages: 2,
      lossBySource: {},
      details: [],
    })
    await expect(
      applyMigrationArtifact(
        "codex",
        "sessions",
        { artifact: "sessions", status: "ready", count: 1, warnings: [], items: [{ ref }] },
        { vendor: "codex", strategy: "overwrite" } as MigrationPlan
      )
    ).resolves.toEqual({ imported: 1, warnings: [] })
  })

  it("previews settings and sessions through their existing subsystems", async () => {
    const deps = {
      previewSettings: jest.fn(async () => [{ id: "setting" }]),
      previewCommands: jest.fn(),
      previewSessions: jest.fn(async () => [
        { ref: { sourceId: "codex", originalSessionId: "s", locator: "x" } },
      ]),
      previewMcp: jest.fn(),
      previewSubagents: jest.fn(),
      previewSkills: jest.fn(),
      previewMemory: jest.fn(),
    }
    await expect(
      previewMigrationArtifact("codex", "settings", undefined, deps as never)
    ).resolves.toMatchObject({ items: [{ id: "setting" }] })
    await expect(
      previewMigrationArtifact("codex", "sessions", undefined, deps as never)
    ).resolves.toMatchObject({ items: [expect.anything()] })
  })

  it("applies project MCP together with Claude user MCP", async () => {
    const applyMcp = jest.fn(async () => ({ imported: 2, skipped: 0, warnings: [] }))
    const applyProjectMcp = jest.fn(async () => ({ imported: 1, skipped: 0, warnings: [] }))
    const cell: MigrationPreviewCell = {
      artifact: "mcp",
      status: "ready",
      count: 3,
      warnings: [],
      items: [],
    }
    const plan = { vendor: "claude-code", cwd: "/repo", strategy: "overwrite" } as MigrationPlan
    const result = await applyMigrationArtifact("claude-code", "mcp", cell, plan, undefined, {
      applySettings: jest.fn(),
      applyCommands: jest.fn(),
      applySessions: jest.fn(),
      applyMcp,
      applyProjectMcp,
      applySubagents: jest.fn(),
      applySkills: jest.fn(),
    } as never)
    expect(applyMcp).toHaveBeenCalledWith("claude-code", "overwrite")
    expect(applyProjectMcp).toHaveBeenCalledWith("/repo", "overwrite")
    expect(result.imported).toBe(3)
  })
})

it("routes Pi MCP preview and import to mcp.json, never settings.json", async () => {
  await previewMigrationArtifact("pi", "mcp")
  expect(previewAgentImport).toHaveBeenCalledWith("pi-mcp-adapter")
  const result = await applyMigrationArtifact(
    "pi",
    "mcp",
    {
      artifact: "mcp",
      status: "ready",
      count: 1,
      warnings: [],
      items: [],
    },
    { vendor: "pi", strategy: "overwrite" } as MigrationPlan
  )
  expect(importFromAgent).toHaveBeenCalledWith("pi-mcp-adapter", "overwrite")
  expect(result.imported).toBe(1)
})
