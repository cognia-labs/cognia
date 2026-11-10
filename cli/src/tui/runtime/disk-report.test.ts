/**
 * @jest-environment node
 */
import { buildDiskReport, diskReportTargets, formatDiskReport } from "./disk-report"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

const HOME = "/home/u/.cognia"

/**
 * A filesystem facade that records reads and throws on any mutation. The
 * report only receives the read-only interface, but the facade carries the
 * mutating methods too, so if the report ever reached one through a cast the
 * throw would fail the test.
 */
function guardedFs(files: Record<string, number>) {
  const dirs = new Set<string>()
  for (const file of Object.keys(files)) {
    const parts = file.split("/")
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"))
  }
  const mutations: string[] = []
  const refuse = (name: string) => async () => {
    mutations.push(name)
    throw new Error(`${name} must never be called by the disk report`)
  }
  return {
    mutations,
    facade: {
      async readdir(path: string) {
        if (!dirs.has(path)) throw new Error(`ENOENT ${path}`)
        const names = new Set<string>()
        for (const candidate of [...dirs, ...Object.keys(files)]) {
          if (candidate.startsWith(`${path}/`)) {
            names.add(candidate.slice(path.length + 1).split("/")[0]!)
          }
        }
        return [...names].map((name) => ({
          name,
          isDirectory: () => dirs.has(`${path}/${name}`),
          isFile: () => `${path}/${name}` in files,
        }))
      },
      async stat(path: string) {
        if (!(path in files)) throw new Error(`ENOENT ${path}`)
        return { size: files[path]! }
      },
      unlink: refuse("unlink"),
      rm: refuse("rm"),
      rmdir: refuse("rmdir"),
      writeFile: refuse("writeFile"),
      rename: refuse("rename"),
    },
  }
}

describe("diskReportTargets", () => {
  it("lists the three config-home directories, plus the build dirs inside a checkout", () => {
    expect(diskReportTargets(HOME).map((t) => t.label)).toEqual(["Sessions", "Logs", "Checkpoints"])
    expect(diskReportTargets(HOME, process.cwd()).map((t) => t.path)).toEqual([
      `${HOME}/sessions`,
      `${HOME}/logs`,
      `${HOME}/checkpoints`,
      path.join(process.cwd(), "cli/dist"),
      path.join(process.cwd(), "target"),
    ])
  })

  it("omits build advice for an unrelated checkout even when its build directories exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-unrelated-"))
    try {
      fs.mkdirSync(path.join(root, "cli/dist"), { recursive: true })
      fs.mkdirSync(path.join(root, "target"))
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"another-project"}')
      expect(diskReportTargets(HOME, root).map((t) => t.label)).toEqual([
        "Sessions",
        "Logs",
        "Checkpoints",
      ])
      fs.writeFileSync(path.join(root, "package.json"), "{broken")
      expect(diskReportTargets(HOME, root)).toHaveLength(3)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("passes shell metacharacters literally in every printed path", () => {
    const home = '/tmp/doctor $HOME `echo injected` $(echo injected) \' "quoted"'
    for (const entry of diskReportTargets(home).filter((entry) => entry.label !== "Sessions")) {
      const command = entry.reclaim!.replace(/^rm -rf(?: --)? /, "printf '%s' ")
      expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe(entry.path)
    }
  })

  it("quotes checkout paths in executable build advice, including line breaks", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-checkout-"))
    const root = path.join(parent, '$HOME `echo injected` \' "quoted"\n$(echo injected)')
    try {
      fs.mkdirSync(root)
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"cognia-next"}')
      const entries = diskReportTargets(HOME, root)
      const dist = entries.find((entry) => entry.label === "CLI build")!
      const cargo = entries.find((entry) => entry.label === "Cargo target")!
      const literal = (command: string) =>
        execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })
      expect(literal(dist.reclaim!.replace(/^rm -rf -- /, "printf '%s' "))).toBe(dist.path)
      expect(literal(cargo.reclaim!.replace(/^cargo clean --manifest-path /, "printf '%s' "))).toBe(
        path.join(root, "Cargo.toml")
      )
    } finally {
      fs.rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe("buildDiskReport", () => {
  it("measures each directory, reports absent ones, and never mutates", async () => {
    const { facade, mutations } = guardedFs({
      [`${HOME}/sessions/s1/manifest.json`]: 100,
      [`${HOME}/sessions/s1/events.jsonl`]: 900,
      [`${HOME}/logs/cli.log`]: 5000,
      [path.join(process.cwd(), "target/debug/app")]: 4_000_000,
    })
    const report = await buildDiskReport({
      home: HOME,
      repoRoot: process.cwd(),
      fsx: facade,
      statfs: async () => ({ bavail: BigInt(1000), bsize: BigInt(4096) }),
      now: () => 42,
    })
    expect(mutations).toEqual([])
    expect(report.checkedAt).toBe(42)
    expect(report.freeBytes).toBe(4_096_000)
    expect(report.entries.map((e) => [e.label, e.bytes])).toEqual([
      ["Sessions", 1000],
      ["Logs", 5000],
      ["Checkpoints", undefined],
      ["CLI build", undefined],
      ["Cargo target", 4_000_000],
    ])
    // An absent directory has nothing to reclaim, so it carries no command.
    expect(report.entries[2]!.reclaim).toBeUndefined()
    expect(report.entries[4]!.reclaim).toBe(
      `cargo clean --manifest-path '${path.join(process.cwd(), "Cargo.toml")}'`
    )
  })

  it("survives a failing statfs", async () => {
    const { facade } = guardedFs({})
    const report = await buildDiskReport({
      home: HOME,
      fsx: facade,
      statfs: async () => {
        throw new Error("EACCES")
      },
    })
    expect(report.freeBytes).toBeUndefined()
    expect(report.entries.every((e) => e.bytes === undefined)).toBe(true)
  })
})

describe("formatDiskReport", () => {
  it("prints sizes, marks absent directories, and lists only reclaimable commands", () => {
    const text = formatDiskReport({
      checkedAt: 0,
      freeBytes: 4_096_000,
      entries: [
        {
          label: "Sessions",
          path: `${HOME}/sessions`,
          bytes: 1000,
          reclaim: "cognia-agent sdk sessions",
        },
        { label: "Logs", path: `${HOME}/logs`, bytes: 0, reclaim: `rm -rf "${HOME}/logs"` },
        { label: "Checkpoints", path: `${HOME}/checkpoints` },
      ],
    })
    expect(text).toContain("Free space:   3.9 MB")
    expect(text).toContain(`Sessions         1000 B  ${HOME}/sessions`)
    expect(text).toContain(`Checkpoints      absent  ${HOME}/checkpoints`)
    expect(text).toContain("To reclaim (nothing is deleted by this report):")
    expect(text).toContain("  cognia-agent sdk sessions")
    expect(text).not.toContain("rm -rf")
  })
})
