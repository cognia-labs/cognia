import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import type { FilesEntry } from "./types"
import {
  documentTextContentKey,
  extractMatchSnippet,
  FILES_TEXT_SEGMENT_CHARS,
  searchFilesBodies,
  splitIntoTextSegments,
  syncFilesTextIndex,
  uploadTextContentKey,
} from "./text-index"

function entry(overrides: Partial<FilesEntry> & { key: string }): FilesEntry {
  return {
    kind: "artifact",
    sourceId: overrides.key.split(":")[1] ?? overrides.key,
    title: "Spec.md",
    sourceTitle: "Spec.md",
    projectIds: [],
    sessionIds: [],
    sharedWithMe: false,
    creator: "user",
    originAlive: true,
    createdAt: 1,
    updatedAt: 10,
    ownedByFiles: false,
    hidden: false,
    searchText: "spec.md",
    ...overrides,
  }
}

const fixture = createDbTestFixture()
beforeAll(fixture.initialize)
beforeEach(fixture.restore)
afterAll(fixture.dispose)

describe("splitIntoTextSegments & extractMatchSnippet", () => {
  it("chunks bodies larger than 6 KiB with boundary overlap so multi-word phrases stay searchable", () => {
    const prefix = "a".repeat(FILES_TEXT_SEGMENT_CHARS - 10)
    const boundaryPhrase = "quantum annealing checkpoint"
    const suffix = "b".repeat(FILES_TEXT_SEGMENT_CHARS)
    const full = `${prefix} ${boundaryPhrase} ${suffix}`
    const segments = splitIntoTextSegments(full)
    expect(segments.length).toBeGreaterThanOrEqual(3)
    expect(segments.some((seg) => seg.includes(boundaryPhrase))).toBe(true)
  })

  it("extracts a single-line snippet centered around the matched term with ellipses", () => {
    const body = `${"intro words ".repeat(20)}CRITICAL_MARKER_TOKEN appears right here ${"outro words ".repeat(20)}`
    const snippet = extractMatchSnippet(body, "critical_marker_token", 80)
    expect(snippet).toBeDefined()
    expect(snippet).toContain("CRITICAL_MARKER_TOKEN")
    expect(snippet!.startsWith("…")).toBe(true)
    expect(snippet!.endsWith("…")).toBe(true)
  })
})

describe("syncFilesTextIndex & searchFilesBodies", () => {
  it("indexes >20k-char documents and deduplicated uploads in Dexie, prunes stale keys, and returns snippets", async () => {
    const docBody = `${"header padding ".repeat(2000)}\nDeep tailneedle_42 inside 30k doc.`
    expect(docBody.length).toBeGreaterThan(25_000)
    const docKey = documentTextContentKey("canvas", "c1", 100, docBody.length)
    const uploadKey = uploadTextContentKey("sha256_shared")

    await syncFilesTextIndex(
      new Map([
        [docKey, docBody],
        [uploadKey, "Quarterly revenue forecast: $12.4M ARR milestone."],
      ])
    )
    expect(await getDb().libraryTextSegments.count()).toBeGreaterThan(4)

    const entries = [
      entry({ key: "canvas:c1", kind: "canvas", sourceId: "c1", title: "Long doc" }),
      entry({
        key: "upload:u1",
        kind: "upload",
        sourceId: "u1",
        contentHash: "sha256_shared",
        title: "Q4.pdf",
      }),
      entry({
        key: "session-upload:sha256_shared",
        kind: "session-upload",
        sourceId: "sha256_shared",
        contentHash: "sha256_shared",
        title: "Q4-chat.pdf",
      }),
    ]
    const contentKeys = new Map([
      ["canvas:c1", docKey],
      ["upload:u1", uploadKey],
      ["session-upload:sha256_shared", uploadKey],
    ])

    const tailRes = await searchFilesBodies({
      query: "tailneedle_42",
      entries,
      entryContentKeys: contentKeys,
    })
    expect([...tailRes.matchedKeys]).toEqual(["canvas:c1"])
    expect(tailRes.snippets.get("canvas:c1")).toContain("tailneedle_42")

    // Both upload and session-upload share one deduplicated segment set by contentHash.
    const uploadRes = await searchFilesBodies({
      query: "forecast milestone",
      entries,
      entryContentKeys: contentKeys,
    })
    expect([...uploadRes.matchedKeys].sort()).toEqual(["session-upload:sha256_shared", "upload:u1"])
    expect(uploadRes.snippets.get("upload:u1")).toContain("$12.4M ARR")

    // Pruning stale content keys removes old document segments.
    await syncFilesTextIndex(
      new Map([[uploadKey, "Quarterly revenue forecast: $12.4M ARR milestone."]])
    )
    expect(await getDb().libraryTextSegments.where("contentKey").equals(docKey).count()).toBe(0)
  })

  it("fuses on-demand native workspace content search for workspace-file entries without indexing disk", async () => {
    const wsEntry = entry({
      key: "workspace-file:wf1",
      kind: "workspace-file",
      sourceId: "wf1",
      title: "router.rs",
      searchText: "router.rs\nsrc/router.rs",
      workspace: {
        sessionId: "s1",
        workspaceRoot: "/repo",
        executionRoot: "/repo",
        relPath: "src/router.rs",
        adoption: "applied",
      },
    })
    const searchWorkspace = jest.fn(async () => [
      {
        relPath: "src/router.rs",
        lineNumber: 42,
        column: 5,
        lineText: "    pub fn dispatch_companion_route() -> Result<(), Error> {",
      },
    ])

    const res = await searchFilesBodies({
      query: "router dispatch_companion_route",
      entries: [wsEntry],
      searchWorkspace,
    })
    expect(searchWorkspace).toHaveBeenCalledWith("/repo", "dispatch_companion_route", {
      maxResults: 200,
    })
    expect([...res.matchedKeys]).toEqual(["workspace-file:wf1"])
    expect(res.snippets.get("workspace-file:wf1")).toContain("dispatch_companion_route")
  })
})
