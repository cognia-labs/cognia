import path from "node:path"
import os from "node:os"
import nodeFs from "node:fs"
import nodeFsP from "node:fs/promises"
import {
  installFromGithubRef,
  stageFromGithubRef,
  bundleFingerprint,
  type InstallFs,
} from "./install"

const MANIFEST = JSON.stringify({
  id: "demo.plugin",
  name: "Demo",
  version: "1.0.0",
  type: "frontend",
  main: "main.js",
})

/**
 * Fake GitHub contents API. `tree` maps a repo-relative path to either a file's
 * UTF-8 content (string) or a directory listing (array of `{type,path}`). The
 * root listing is keyed by "". Unknown paths 404.
 */
type Node = string | Array<{ type: "file" | "dir"; path: string }>
function installGlobalFetch(tree: Record<string, Node>): jest.Mock {
  const impl = jest.fn(async (url: string) => {
    if (String(url).includes("/commits/")) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ sha: "0123456789abcdef0123456789abcdef01234567" }),
      } as unknown as Response
    }
    const m = String(url).match(/contents\/(.*?)(\?|$)/)
    const p = decodeURIComponent(m ? m[1] : "")
    const node = tree[p]
    if (node === undefined) {
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response
    }
    if (typeof node === "string") {
      return {
        status: 200,
        ok: true,
        json: async () => ({
          type: "file",
          content: Buffer.from(node).toString("base64"),
          encoding: "base64",
        }),
      } as unknown as Response
    }
    return { status: 200, ok: true, json: async () => node } as unknown as Response
  })
  ;(globalThis as { fetch: unknown }).fetch = impl
  return impl
}

const homes: string[] = []
function tempHome(): string {
  const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-install-"))
  homes.push(home)
  return home
}
afterEach(async () => {
  for (const home of homes.splice(0)) await nodeFsP.rm(home, { recursive: true, force: true })
})

/** The real filesystem, with every write recorded and an optional failure hook. */
function recordingFs(
  failWrite?: (p: string) => boolean
): InstallFs & { writes: Map<string, string | Uint8Array> } {
  const writes = new Map<string, string | Uint8Array>()
  return {
    writes,
    mkdir: (p, o) => nodeFsP.mkdir(p, o),
    writeFile: async (p, c) => {
      if (failWrite?.(p)) throw new Error(`disk full writing ${path.basename(p)}`)
      writes.set(p, c)
      await nodeFsP.writeFile(p, c)
    },
    mkdtemp: (prefix) => nodeFsP.mkdtemp(prefix),
    rename: (from, to) => nodeFsP.rename(from, to),
    rm: (p, o) => nodeFsP.rm(p, o),
    exists: async (p) => nodeFs.existsSync(p),
  }
}

/** Every file under `dir`, relative and `/`-separated, sorted. */
function treeOf(dir: string): string[] {
  const out: string[] = []
  const visit = (rel: string) => {
    for (const entry of nodeFs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(child)
      else out.push(child)
    }
  }
  visit("")
  return out.sort()
}

describe("installFromGithubRef", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  })

  it("walks the repo dir and writes the plugin tree under ~/.cognia/plugins/<id>", async () => {
    installGlobalFetch({
      "plugin.json": MANIFEST,
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
        { type: "dir", path: "lib" },
      ],
      "main.js": "export default { manifest: {}, activate: () => ({}) }",
      lib: [{ type: "file", path: "lib/util.js" }],
      "lib/util.js": "export const x = 1",
    })
    const home = tempHome()
    const result = await installFromGithubRef("owner/repo", { home, fs: recordingFs() })

    expect(result.id).toBe("demo.plugin")
    expect(result.dir).toBe(path.join(home, ".cognia", "plugins", "demo.plugin"))
    expect(treeOf(result.dir)).toEqual(["lib/util.js", "main.js", "plugin.json"])
    // The staging area is emptied once the tree is live.
    expect(nodeFs.readdirSync(path.join(home, ".cognia", "plugin-staging"))).toEqual([])
  })

  it("returns a stable SHA-256 fingerprint of the installed bundle", async () => {
    installGlobalFetch({
      "plugin.json": MANIFEST,
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
      ],
      "main.js": "export default {}",
    })
    const a = await installFromGithubRef("owner/repo", { home: tempHome() })
    const b = await installFromGithubRef("owner/repo", { home: tempHome() })
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(a.fingerprint).toBe(b.fingerprint)
  })

  it("preserves binary files without UTF-8 decoding", async () => {
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x50, 0x4e, 0x47])
    const impl = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ sha: "0123456789abcdef0123456789abcdef01234567" }),
        } as unknown as Response
      }
      const match = url.match(/contents\/(.*?)(\?|$)/)
      const repoPath = decodeURIComponent(match ? match[1] : "")
      if (repoPath === "plugin.json") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            type: "file",
            content: Buffer.from(MANIFEST).toString("base64"),
            encoding: "base64",
          }),
        } as unknown as Response
      }
      if (repoPath === "") {
        return {
          status: 200,
          ok: true,
          json: async () => [
            { type: "file", path: "plugin.json" },
            { type: "file", path: "asset.bin" },
          ],
        } as unknown as Response
      }
      if (repoPath === "asset.bin") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            type: "file",
            content: binary.toString("base64"),
            encoding: "base64",
          }),
        } as unknown as Response
      }
      return { status: 404, ok: false, json: async () => ({}) } as unknown as Response
    })
    ;(globalThis as { fetch: unknown }).fetch = impl
    const result = await installFromGithubRef("owner/repo", { home: tempHome() })

    expect(nodeFs.readFileSync(path.join(result.dir, "asset.bin"))).toEqual(binary)
  })

  it("writes the generated Cognia overlay for a foreign plugin", async () => {
    installGlobalFetch({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "claude-review",
        version: "1.0.0",
        skills: "./skills",
      }),
      "": [
        { type: "dir", path: ".claude-plugin" },
        { type: "dir", path: "skills" },
      ],
      ".claude-plugin": [{ type: "file", path: ".claude-plugin/plugin.json" }],
      skills: [{ type: "dir", path: "skills/review" }],
      "skills/review": [{ type: "file", path: "skills/review/SKILL.md" }],
      "skills/review/SKILL.md": "---\nname: Review\n---\nReview every changed line.",
    })
    const result = await installFromGithubRef("owner/repo", { home: tempHome() })

    const manifestPath = path.join(result.dir, "plugin.json")
    const distPath = path.join(result.dir, "dist", "index.js")
    expect(nodeFs.readFileSync(manifestPath, "utf8")).toContain('"id": "claude-review"')
    expect(nodeFs.readFileSync(distPath, "utf8")).toContain("claude-review")
  })

  it("bundleFingerprint is order-independent but content-sensitive", () => {
    const f1 = bundleFingerprint([
      { rel: "a.js", content: "1" },
      { rel: "b.js", content: "2" },
    ])
    const f2 = bundleFingerprint([
      { rel: "b.js", content: "2" },
      { rel: "a.js", content: "1" },
    ])
    const f3 = bundleFingerprint([
      { rel: "a.js", content: "1" },
      { rel: "b.js", content: "CHANGED" },
    ])
    expect(f1).toBe(f2)
    expect(f1).not.toBe(f3)
  })

  it("propagates a non-404 GitHub API error while fetching file content", async () => {
    const impl = jest.fn(async (url: string) => {
      if (String(url).includes("/commits/")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ sha: "0123456789abcdef0123456789abcdef01234567" }),
        } as unknown as Response
      }
      const m = String(url).match(/contents\/(.*?)(\?|$)/)
      const p = decodeURIComponent(m ? m[1] : "")
      if (p === "plugin.json") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            type: "file",
            content: Buffer.from(MANIFEST).toString("base64"),
            encoding: "base64",
          }),
        } as unknown as Response
      }
      if (p === "") {
        return {
          status: 200,
          ok: true,
          json: async () => [{ type: "file", path: "main.js" }],
        } as unknown as Response
      }
      // main.js → server error
      return { status: 500, ok: false, json: async () => ({}) } as unknown as Response
    })
    ;(globalThis as { fetch: unknown }).fetch = impl
    await expect(installFromGithubRef("owner/repo", { home: tempHome() })).rejects.toThrow(
      /GitHub API 500/
    )
  })

  it("rejects a listing entry that stops being a file", async () => {
    const impl = jest.fn(async (url: string) => {
      if (url.includes("/commits/")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({ sha: "0123456789abcdef0123456789abcdef01234567" }),
        } as unknown as Response
      }
      const match = url.match(/contents\/(.*?)(\?|$)/)
      const repoPath = decodeURIComponent(match ? match[1] : "")
      if (repoPath === "plugin.json") {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            type: "file",
            content: Buffer.from(MANIFEST).toString("base64"),
            encoding: "base64",
          }),
        } as unknown as Response
      }
      if (repoPath === "") {
        return {
          status: 200,
          ok: true,
          json: async () => [{ type: "file", path: "vanished.js" }],
        } as unknown as Response
      }
      return {
        status: 200,
        ok: true,
        json: async () => ({ type: "dir" }),
      } as unknown as Response
    })
    ;(globalThis as { fetch: unknown }).fetch = impl

    await expect(installFromGithubRef("owner/repo", { home: tempHome() })).rejects.toThrow(
      /could not be read completely: vanished\.js/
    )
  })

  it("rejects a non-frontend plugin as unsupported in CLI", async () => {
    installGlobalFetch({
      "plugin.json": JSON.stringify({
        id: "py.plugin",
        name: "Py",
        version: "1.0.0",
        type: "python",
      }),
      "": [{ type: "file", path: "plugin.json" }],
    })
    await expect(installFromGithubRef("owner/repo", { home: tempHome() })).rejects.toThrow(
      /unsupported in CLI/i
    )
  })

  it("resolves a monorepo subdir + pinned ref and rebases paths", async () => {
    installGlobalFetch({
      "plugins/demo/plugin.json": MANIFEST,
      "plugins/demo": [{ type: "file", path: "plugins/demo/main.js" }],
      "plugins/demo/main.js": "export default {}",
    })
    const home = tempHome()
    const result = await installFromGithubRef("owner/repo@main/plugins/demo", { home })
    expect(result.id).toBe("demo.plugin")
    // The subdir prefix is stripped so files land at the plugin root.
    expect(nodeFs.existsSync(path.join(home, ".cognia", "plugins", "demo.plugin", "main.js"))).toBe(
      true
    )
  })

  it.each([
    { listing: [{ type: "dir", path: "ghost" }], error: /GitHub API 404.*directory ghost/ },
    { listing: [{ type: "file" }], error: /unsupported or invalid entry/ },
  ])(
    "rejects incomplete repository snapshots before writing: $error",
    async ({ listing, error }) => {
      installGlobalFetch({
        "plugin.json": MANIFEST,
        "": listing as Node,
      })
      const fs = recordingFs()
      await expect(installFromGithubRef("owner/repo", { home: tempHome(), fs })).rejects.toThrow(
        error
      )
      expect(fs.writes.size).toBe(0)
    }
  )

  it("writes through the real default fs when none is injected", async () => {
    installGlobalFetch({
      "plugin.json": MANIFEST,
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
      ],
      "main.js": "export default {}",
    })
    const home = nodeFs.mkdtempSync(path.join(os.tmpdir(), "cognia-install-"))
    try {
      const result = await installFromGithubRef("owner/repo", { home })
      expect(nodeFs.existsSync(path.join(result.dir, "main.js"))).toBe(true)
      expect(nodeFs.existsSync(path.join(result.dir, "plugin.json"))).toBe(true)
    } finally {
      await nodeFsP.rm(home, { recursive: true, force: true })
    }
  })
})

describe("staged replacement (PL13, PL15)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    ;(globalThis as { fetch: unknown }).fetch = realFetch
  })

  function v2Tree(): Record<string, Node> {
    return {
      "plugin.json": JSON.stringify({ ...JSON.parse(MANIFEST), version: "2.0.0" }),
      "": [
        { type: "file", path: "plugin.json" },
        { type: "file", path: "main.js" },
      ],
      "main.js": "export const v = 2",
    }
  }

  function installV1(home: string): string {
    const dir = path.join(home, ".cognia", "plugins", "demo.plugin")
    nodeFs.mkdirSync(path.join(dir, "old"), { recursive: true })
    nodeFs.writeFileSync(path.join(dir, "plugin.json"), MANIFEST)
    nodeFs.writeFileSync(path.join(dir, "main.js"), "export const v = 1")
    nodeFs.writeFileSync(path.join(dir, "old", "removed.js"), "gone in v2")
    return dir
  }

  it("leaves v1 untouched when a write fails halfway through v2", async () => {
    installGlobalFetch(v2Tree())
    const home = tempHome()
    const dir = installV1(home)
    const fs = recordingFs((p) => p.endsWith("main.js"))

    await expect(installFromGithubRef("owner/repo", { home, fs })).rejects.toThrow(/disk full/)

    expect(JSON.parse(nodeFs.readFileSync(path.join(dir, "plugin.json"), "utf8")).version).toBe(
      "1.0.0"
    )
    expect(nodeFs.readFileSync(path.join(dir, "main.js"), "utf8")).toBe("export const v = 1")
    expect(nodeFs.readdirSync(path.join(home, ".cognia", "plugin-staging"))).toEqual([])
  })

  it("replaces the whole tree, dropping files the new version no longer ships", async () => {
    installGlobalFetch(v2Tree())
    const home = tempHome()
    const dir = installV1(home)

    const result = await installFromGithubRef("owner/repo", { home })

    expect(treeOf(dir)).toEqual(["main.js", "plugin.json"])
    expect(result.fingerprint).toBe(
      bundleFingerprint(
        treeOf(dir).map((rel) => ({ rel, content: nodeFs.readFileSync(path.join(dir, rel)) }))
      )
    )
  })

  it("restores the old tree when the swap itself fails", async () => {
    installGlobalFetch(v2Tree())
    const home = tempHome()
    const dir = installV1(home)
    const fs = recordingFs()
    const rename = fs.rename
    fs.rename = async (from, to) => {
      if (to === dir && !from.endsWith(".previous")) throw new Error("EXDEV")
      return rename(from, to)
    }

    await expect(installFromGithubRef("owner/repo", { home, fs })).rejects.toThrow("EXDEV")

    expect(treeOf(dir)).toEqual(["main.js", "old/removed.js", "plugin.json"])
  })

  it("refuses a source that now names another plugin before writing anything (PL15)", async () => {
    installGlobalFetch(v2Tree())
    const home = tempHome()
    const fs = recordingFs()

    await expect(
      stageFromGithubRef("owner/repo", { home, fs, expectedId: "other.plugin" })
    ).rejects.toThrow(/provides plugin "demo\.plugin", not "other\.plugin"/)

    expect(fs.writes.size).toBe(0)
    expect(nodeFs.existsSync(path.join(home, ".cognia", "plugins"))).toBe(false)
  })

  it("stops before the swap once cancelled, and stages nothing live", async () => {
    installGlobalFetch(v2Tree())
    const home = tempHome()
    const dir = installV1(home)
    const controller = new AbortController()
    const staged = await stageFromGithubRef("owner/repo", { home, signal: controller.signal })
    controller.abort()

    await expect(
      installFromGithubRef("owner/repo", { home, signal: controller.signal })
    ).rejects.toThrow()
    await staged.discard()

    expect(treeOf(dir)).toEqual(["main.js", "old/removed.js", "plugin.json"])
    expect(nodeFs.readdirSync(path.join(home, ".cognia", "plugin-staging"))).toEqual([])
  })

  it("commits a staged tree only once", async () => {
    installGlobalFetch(v2Tree())
    const staged = await stageFromGithubRef("owner/repo", { home: tempHome() })
    await staged.commit()
    await expect(staged.commit()).rejects.toThrow(/committed/)
    await staged.discard()
    expect(nodeFs.existsSync(path.join(staged.dir, "main.js"))).toBe(true)
  })
})
