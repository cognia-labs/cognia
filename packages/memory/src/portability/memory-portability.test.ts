import type { Memory } from "../types/memory"
import {
  exportMemoriesBundle,
  MEMORY_EXPORT_SCHEMA,
  previewMemoryImport,
} from "./memory-portability"

function makeMemory(overrides: Partial<Memory> & { id: string; text: string }): Memory {
  return {
    scope: "global",
    type: "semantic",
    tags: [],
    importance: 7,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    lastAccessedAt: 1_700_000_000_000,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...overrides,
  }
}

describe("memory-portability", () => {
  it("exports active scoped memories as versioned JSON and round-trips via previewMemoryImport", () => {
    const corpus: Memory[] = [
      makeMemory({
        id: "m1",
        scope: "global",
        text: "The user prefers pnpm for workspace scripts.",
        tags: ["tooling", "pnpm"],
        key: "pkg-manager",
      }),
      makeMemory({
        id: "m2",
        scope: "workspace",
        projectId: "proj-1",
        type: "procedural",
        text: "Always run eslint with max-warnings=0 before committing.",
      }),
      makeMemory({
        id: "m3-archived",
        status: "invalidated",
        text: "Archived memory should be omitted by default.",
      }),
      makeMemory({
        id: "m4-revision",
        revisionOf: "m1",
        status: "invalidated",
        text: "Old revision snapshot.",
      }),
    ]

    const json = exportMemoriesBundle(corpus, { format: "json", exportedAt: 123456 })
    const parsed = JSON.parse(json)
    expect(parsed.schema).toBe(MEMORY_EXPORT_SCHEMA)
    expect(parsed.count).toBe(2)

    const preview = previewMemoryImport(json, [])
    expect(preview.ok).toBe(true)
    expect(preview.format).toBe("json")
    expect(preview.counts).toMatchObject({
      total: 2,
      add: 2,
      duplicate: 0,
      conflict: 0,
      blockedPii: 0,
      pendingReview: 2,
    })
    expect(preview.items[1]).toMatchObject({
      trustPosture: "pending_instruction",
      effectiveReviewStatus: "pending_instruction",
      effectiveTrustState: "quarantined",
    })
  })

  it("exports grouped Markdown and imports both Cognia and external bullet lists", () => {
    const md = exportMemoriesBundle(
      [
        makeMemory({
          id: "m1",
          scope: "workspace",
          projectId: "proj-alpha",
          text: "Workspace uses Next.js static export.",
          tags: ["nextjs"],
        }),
      ],
      { format: "markdown" }
    )
    expect(md).toContain("## Workspace (proj-alpha)")

    const roundTrip = previewMemoryImport(md, [])
    expect(roundTrip.ok).toBe(true)
    expect(roundTrip.items[0]?.candidate).toMatchObject({
      scope: "workspace",
      projectId: "proj-alpha",
      text: "Workspace uses Next.js static export.",
      tags: ["nextjs"],
    })

    const externalBullets = [
      "- User prefers concise Chinese answers.",
      "- [procedural] Never run destructive git reset commands.",
    ].join("\n")
    const externalPreview = previewMemoryImport(externalBullets, [], {
      overrideScope: "workspace",
      defaultProjectId: "proj-beta",
    })
    expect(externalPreview.ok).toBe(true)
    expect(externalPreview.counts.add).toBe(2)
    expect(externalPreview.items[0]?.candidate.projectId).toBe("proj-beta")
    expect(externalPreview.items[1]?.effectiveReviewStatus).toBe("pending_instruction")
  })

  it("classifies duplicates, conflicts, PII-blocked entries, and sensitive topics", () => {
    const existing: Memory[] = [
      makeMemory({
        id: "existing-1",
        scope: "global",
        key: "pkg-manager",
        text: "The user prefers pnpm for monorepo packages.",
      }),
      makeMemory({
        id: "existing-2",
        scope: "global",
        text: "User lives in Shanghai.",
      }),
    ]

    const raw = JSON.stringify({
      items: [
        { text: "User lives in Shanghai.", scope: "global" },
        {
          text: "The user prefers yarn for monorepo packages.",
          scope: "global",
          key: "pkg-manager",
        },
        { text: "Contact me at leak@example.com", scope: "global" },
        { text: "User was diagnosed with hypertension.", scope: "global" },
      ],
    })

    const preview = previewMemoryImport(raw, existing, {
      isPiiSafe: (text) => !text.includes("@"),
      allowSensitiveTopics: false,
    })

    expect(preview.ok).toBe(true)
    expect(preview.counts).toMatchObject({
      total: 4,
      add: 1,
      duplicate: 1,
      conflict: 1,
      blockedPii: 1,
      sensitive: 1,
    })
    expect(preview.items[0]?.disposition).toBe("duplicate")
    expect(preview.items[1]?.disposition).toBe("conflict")
    expect(preview.items[1]?.existingId).toBe("existing-1")
    expect(preview.items[2]?.disposition).toBe("blocked_pii")
    expect(preview.items[3]).toMatchObject({
      disposition: "add",
      trustPosture: "quarantined_sensitive",
      effectiveSensitivity: "sensitive",
      effectiveTrustState: "quarantined",
      sensitiveCategories: ["health"],
    })
  })
})
