jest.mock("./load", () => ({
  clearInstructionCache: jest.fn(),
  discoverProjectInstructionFiles: jest.fn(async () => []),
}))

import { WorkspaceFileConflictError } from "@/lib/files/workspace-fs"
import type { DiscoveredPath } from "./discover"
import { clearInstructionCache } from "./load"
import {
  appendInstructionMemory,
  InstructionMemoryError,
  type AppendInstructionMemoryDeps,
} from "./append-memory"

type Disk = Map<string, string>

/** A disk keyed by `root|relPath`, with the checked-write semantics of the host. */
function fakeHost(disk: Disk, found: DiscoveredPath[] = []) {
  const sha = (text: string) => `sha:${text.length}:${text}`
  const read = jest.fn(async (root: string, relPath: string) => {
    const content = disk.get(`${root}|${relPath}`)
    if (content === undefined) throw new Error(`read ${relPath}: No such file`)
    return { content, sha256: sha(content), size: content.length, mtimeMs: null }
  })
  const write = jest.fn(
    async (
      root: string,
      relPath: string,
      content: string,
      pre: { expectedSha256?: string; expectAbsent?: true }
    ) => {
      const key = `${root}|${relPath}`
      const current = disk.get(key)
      const ok = pre.expectAbsent
        ? current === undefined
        : current && sha(current) === pre.expectedSha256
      if (!ok) throw new WorkspaceFileConflictError(current === undefined ? null : sha(current))
      disk.set(key, content)
      return { sha256: sha(content), size: content.length, mtimeMs: null }
    }
  )
  const deps: AppendInstructionMemoryDeps = {
    discover: jest.fn(async () => found),
    read,
    write,
    homeDir: async () => "/Users/me",
  }
  return { deps, read, write }
}

const project = (absPath: string): DiscoveredPath => ({
  absPath,
  label: absPath,
  source: "project",
})

beforeEach(() => jest.mocked(clearInstructionCache).mockClear())

describe("appendInstructionMemory: project scope", () => {
  it("appends to the project file nearest the working directory", async () => {
    const disk: Disk = new Map([
      ["/repo|AGENTS.md", "# Repo"],
      ["/repo/pkg|CLAUDE.md", "# Pkg\n"],
    ])
    const { deps } = fakeHost(disk, [project("/repo/AGENTS.md"), project("/repo/pkg/CLAUDE.md")])

    const path = await appendInstructionMemory(
      { scope: "project", text: "  use pnpm  ", cwd: "/repo/pkg", roots: ["/repo"] },
      deps
    )

    expect(path).toBe("/repo/pkg/CLAUDE.md")
    expect(disk.get("/repo/pkg|CLAUDE.md")).toBe("# Pkg\n- use pnpm\n")
    expect(disk.get("/repo|AGENTS.md")).toBe("# Repo")
    // The next turn must not serve the memoized section without the new line.
    expect(clearInstructionCache).toHaveBeenCalledTimes(1)
  })

  it("separates the bullet from a file that does not end in a newline", async () => {
    const disk: Disk = new Map([["/repo|AGENTS.md", "# Repo"]])
    const { deps } = fakeHost(disk, [project("/repo/AGENTS.md")])
    await appendInstructionMemory(
      { scope: "project", text: "a", cwd: "/repo", roots: ["/repo"] },
      deps
    )
    expect(disk.get("/repo|AGENTS.md")).toBe("# Repo\n- a\n")
  })

  it("creates the first configured name in the working directory when there is none", async () => {
    const disk: Disk = new Map()
    const { deps, write } = fakeHost(disk)

    const path = await appendInstructionMemory(
      {
        scope: "project",
        text: "a",
        cwd: "/repo",
        roots: ["/repo"],
        config: { fileNames: ["CLAUDE.md", "AGENTS.md"] },
      },
      deps
    )

    expect(path).toBe("/repo/CLAUDE.md")
    expect(disk.get("/repo|CLAUDE.md")).toBe("- a\n")
    expect(write).toHaveBeenCalledWith("/repo", "CLAUDE.md", "- a\n", { expectAbsent: true })
  })

  it("retries on the fresh text when the file changed under the write", async () => {
    const disk: Disk = new Map([["/repo|AGENTS.md", "one\n"]])
    const { deps, read } = fakeHost(disk, [project("/repo/AGENTS.md")])
    // Another writer lands between the first read and its write.
    read.mockImplementationOnce(async (root, relPath) => {
      const content = disk.get(`${root}|${relPath}`)!
      disk.set(`${root}|${relPath}`, `${content}two\n`)
      return { content, sha256: `sha:${content.length}:${content}`, size: 0, mtimeMs: null }
    })

    await appendInstructionMemory(
      { scope: "project", text: "three", cwd: "/repo", roots: ["/repo"] },
      deps
    )

    expect(disk.get("/repo|AGENTS.md")).toBe("one\ntwo\n- three\n")
  })

  it("gives up with a conflict refusal when the file never settles", async () => {
    const { deps, write } = fakeHost(new Map([["/repo|AGENTS.md", "x"]]), [
      project("/repo/AGENTS.md"),
    ])
    write.mockRejectedValue(new WorkspaceFileConflictError("other"))
    await expect(
      appendInstructionMemory({ scope: "project", text: "a", cwd: "/repo", roots: ["/repo"] }, deps)
    ).rejects.toEqual(new InstructionMemoryError("conflict"))
    expect(write).toHaveBeenCalledTimes(3)
  })

  it("does not create over a discovered file it cannot read", async () => {
    const { deps, read, write } = fakeHost(new Map(), [project("/repo/AGENTS.md")])
    read.mockRejectedValue(new Error("EACCES"))
    await expect(
      appendInstructionMemory({ scope: "project", text: "a", cwd: "/repo", roots: ["/repo"] }, deps)
    ).rejects.toThrow("EACCES")
    expect(write).not.toHaveBeenCalled()
  })

  it("passes any other host error through", async () => {
    const { deps, write } = fakeHost(new Map(), [])
    write.mockRejectedValue(new Error("disk full"))
    await expect(
      appendInstructionMemory({ scope: "project", text: "a", cwd: "/repo", roots: [] }, deps)
    ).rejects.toThrow("disk full")
  })
})

describe("appendInstructionMemory: user scope", () => {
  it("appends to the global file the turn loads", async () => {
    const disk: Disk = new Map([["/Users/me/.cognia|AGENTS.md", "g\n"]])
    const { deps } = fakeHost(disk, [
      { absPath: "/Users/me/.cognia/AGENTS.md", label: "AGENTS.md", source: "global" },
      project("/repo/AGENTS.md"),
    ])
    const path = await appendInstructionMemory(
      { scope: "user", text: "a", cwd: "/repo", roots: ["/repo"] },
      deps
    )
    expect(path).toBe("/Users/me/.cognia/AGENTS.md")
    expect(disk.get("/Users/me/.cognia|AGENTS.md")).toBe("g\n- a\n")
  })

  it("creates ~/.cognia/<first name> from the home directory when there is none", async () => {
    const disk: Disk = new Map()
    const { deps } = fakeHost(disk)
    const path = await appendInstructionMemory({ scope: "user", text: "a", roots: [] }, deps)
    expect(path).toBe("/Users/me/.cognia/AGENTS.md")
    expect(disk.get("/Users/me|.cognia/AGENTS.md")).toBe("- a\n")
  })

  it("writes the configured global path", async () => {
    const disk: Disk = new Map()
    const { deps } = fakeHost(disk)
    await appendInstructionMemory(
      { scope: "user", text: "a", roots: [], config: { globalPath: "/etc/cognia/RULES.md" } },
      deps
    )
    expect(disk.get("/etc/cognia|RULES.md")).toBe("- a\n")
  })
})

describe("appendInstructionMemory: refusals", () => {
  const cases: Array<[string, Parameters<typeof appendInstructionMemory>[0], string]> = [
    ["an empty line", { scope: "project", text: "   ", cwd: "/repo", roots: [] }, "empty"],
    [
      "instruction loading turned off",
      { scope: "project", text: "a", cwd: "/repo", roots: [], config: { enabled: false } },
      "instructions-off",
    ],
    [
      "the global file excluded from loading",
      { scope: "user", text: "a", roots: [], config: { includeGlobal: false } },
      "global-off",
    ],
    ["no working directory", { scope: "project", text: "a", roots: [] }, "no-workspace"],
  ]
  it.each(cases)("refuses %s without writing", async (_label, input, reason) => {
    const { deps, write } = fakeHost(new Map())
    await expect(appendInstructionMemory(input, deps)).rejects.toEqual(
      new InstructionMemoryError(reason as never)
    )
    expect(write).not.toHaveBeenCalled()
  })

  it("refuses the user scope without a home directory", async () => {
    const { deps } = fakeHost(new Map())
    await expect(
      appendInstructionMemory(
        { scope: "user", text: "a", roots: [] },
        { ...deps, homeDir: async () => null }
      )
    ).rejects.toEqual(new InstructionMemoryError("no-home"))
  })
})
