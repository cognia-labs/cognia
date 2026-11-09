import { discoverCodex } from "./codex"
import type { DiscoverCtx, ExternalFs } from "../types"

function makeFs(files: Record<string, number>, dirs: Record<string, string[]> = {}): ExternalFs {
  return {
    async exists(p) {
      return p in files || p in dirs
    },
    async readDir(p) {
      if (!(p in dirs)) throw new Error(`ENOENT: ${p}`)
      return dirs[p]
    },
    async stat(p) {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return { size: files[p], isFile: true }
    },
  }
}

const HOME = "/Users/x"

function ctx(over: Partial<DiscoverCtx> & { fs: ExternalFs }): DiscoverCtx {
  return { home: HOME, roots: [], cwd: undefined, platform: "macos", ...over }
}

describe("discoverCodex", () => {
  it("always surfaces the global AGENTS.md slot, even when absent", async () => {
    const files = await discoverCodex(ctx({ fs: makeFs({}) }))
    const global = files.filter((f) => f.scope === "global")
    expect(global.map((f) => f.absPath)).toEqual(["/Users/x/.codex/AGENTS.md"])
    expect(global[0].exists).toBe(false)
    expect(global[0].editable).toBe(true)
  })

  it("surfaces the override file when present", async () => {
    const fs = makeFs({
      "/Users/x/.codex/AGENTS.override.md": 3,
      "/Users/x/.codex/AGENTS.md": 9,
    })
    const files = await discoverCodex(ctx({ fs }))
    const global = files.filter((f) => f.scope === "global").map((f) => f.absPath)
    expect(global).toEqual(["/Users/x/.codex/AGENTS.override.md", "/Users/x/.codex/AGENTS.md"])
  })

  it("walks project AGENTS files root→cwd", async () => {
    const fs = makeFs({ "/proj/AGENTS.md": 1, "/proj/svc/AGENTS.md": 2 })
    const files = await discoverCodex(ctx({ fs, roots: ["/proj"], cwd: "/proj/svc" }))
    const project = files.filter((f) => f.scope === "project").map((f) => f.absPath)
    expect(project).toEqual(["/proj/AGENTS.md", "/proj/svc/AGENTS.md"])
  })

  it("lists Codex-managed memories as read-only", async () => {
    const dir = "/Users/x/.codex/memories"
    const fs = makeFs(
      { [`${dir}/summary.md`]: 4, [`${dir}/durable.md`]: 5 },
      { [dir]: ["summary.md", "durable.md"] }
    )
    const files = await discoverCodex(ctx({ fs }))
    const memories = files.filter((f) => f.scope === "memories")
    expect(memories).toHaveLength(2)
    expect(memories.every((f) => f.editable === false)).toBe(true)
  })

  it("walks both memory roots for Markdown, skipping dot dirs and non-memory files", async () => {
    const v2 = "/Users/x/.codex/memories_v2"
    const v1 = "/Users/x/.codex/memories"
    const fs = makeFs(
      {
        [`${v2}/MEMORY.md`]: 1,
        [`${v2}/rollout_summaries/2026-11-08-a.md`]: 2,
        [`${v2}/extensions/ad_hoc/instructions.md`]: 3,
        [`${v2}/extensions/ad_hoc/notes/n.md`]: 4,
        [`${v2}/extensions/ad_hoc/resources/blob.sample`]: 5,
        [`${v2}/.codex-baseline/x.md`]: 6,
        [`${v1}/raw_memories.md`]: 7,
      },
      {
        [v2]: ["MEMORY.md", "rollout_summaries", "extensions", ".codex-baseline"],
        [`${v2}/rollout_summaries`]: ["2026-11-08-a.md"],
        [`${v2}/extensions`]: ["ad_hoc"],
        [`${v2}/extensions/ad_hoc`]: ["instructions.md", "notes", "resources"],
        [`${v2}/extensions/ad_hoc/notes`]: ["n.md"],
        [`${v2}/extensions/ad_hoc/resources`]: ["blob.sample"],
        [`${v2}/.codex-baseline`]: ["x.md"],
        [v1]: ["raw_memories.md"],
      }
    )
    const memories = (await discoverCodex(ctx({ fs }))).filter((f) => f.scope === "memories")
    expect(memories.map((f) => f.label)).toEqual([
      "memories_v2/MEMORY.md",
      "memories_v2/extensions/ad_hoc/instructions.md",
      "memories_v2/extensions/ad_hoc/notes/n.md",
      "memories_v2/rollout_summaries/2026-11-08-a.md",
      "memories/raw_memories.md",
    ])
    expect(memories.every((f) => !f.editable && f.exists)).toBe(true)
    expect(
      memories.find((f) => f.label === "memories_v2/extensions/ad_hoc/notes/n.md")?.bytes
    ).toBe(4)
  })

  it("stops walking at the depth bound", async () => {
    const root = "/Users/x/.codex/memories"
    const dirs: Record<string, string[]> = { [root]: ["d"] }
    let dir = root
    for (let i = 0; i < 10; i += 1) {
      dirs[`${dir}/d`] = ["d", "m.md"]
      dir = `${dir}/d`
    }
    const files: Record<string, number> = {}
    let at = root
    for (let i = 0; i < 10; i += 1) {
      at = `${at}/d`
      files[`${at}/m.md`] = 1
    }
    const memories = (await discoverCodex(ctx({ fs: makeFs(files, dirs) }))).filter(
      (f) => f.scope === "memories"
    )
    // Root (depth 0) plus six nested levels may be listed; deeper ones are not.
    expect(memories).toHaveLength(6)
  })

  it("tolerates a missing memories directory", async () => {
    const files = await discoverCodex(ctx({ fs: makeFs({}) }))
    expect(files.some((f) => f.scope === "memories")).toBe(false)
  })

  it("falls back to the root when the cwd is outside it", async () => {
    const fs = makeFs({ "/proj/AGENTS.md": 1 })
    const files = await discoverCodex(ctx({ fs, roots: ["/proj"], cwd: "/elsewhere" }))
    expect(files.find((f) => f.scope === "project")?.absPath).toBe("/proj/AGENTS.md")
  })

  it("leaves bytes undefined when stat fails on an existing file", async () => {
    const fs: ExternalFs = {
      async exists(p) {
        return p === "/Users/x/.codex/AGENTS.md"
      },
      async readDir() {
        throw new Error("no")
      },
      async stat() {
        throw new Error("stat failed")
      },
    }
    const files = await discoverCodex(ctx({ fs }))
    const global = files.find((f) => f.scope === "global")
    expect(global?.exists).toBe(true)
    expect(global?.bytes).toBeUndefined()
  })
})
