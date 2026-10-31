/** @jest-environment node */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { buildSync } from "esbuild"
import {
  createCliFileLock,
  fileLockPath,
  FileLockLostError,
  FileLockTimeoutError,
  withCliFileLockSync,
} from "./file-lock"

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-file-lock-"))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

it("serializes independent instances and releases on failure", async () => {
  const first = createCliFileLock(home)
  const second = createCliFileLock(home, { waitMs: 25, retryMs: 2 })
  let outside!: () => void
  await expect(
    first(
      "refresh",
      async (assertHeld) => {
        outside = assertHeld
        assertHeld()
        await expect(second("refresh", async () => "unexpected", "lineage")).rejects.toBeInstanceOf(
          FileLockTimeoutError
        )
        expect(() =>
          withCliFileLockSync(home, "refresh", () => {}, "lineage", { waitMs: 10, retryMs: 2 })
        ).toThrow(FileLockTimeoutError)
        throw new Error("provider failed")
      },
      "lineage"
    )
  ).rejects.toThrow("provider failed")
  expect(outside).toThrow(FileLockLostError)
  await expect(second("refresh", async () => "released", "lineage")).resolves.toBe("released")
})

it.each(["dead", "old", "partial"])("takes over a %s holder", async (kind) => {
  const file = fileLockPath(home, "refresh", "lineage")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    kind === "partial"
      ? "{"
      : JSON.stringify({
          pid: kind === "dead" ? 2147483647 : process.pid,
          timestamp: kind === "old" ? Date.now() - 700_000 : Date.now(),
          token: "previous",
        })
  )
  if (kind === "partial") fs.utimesSync(file, 0, 0)
  await expect(
    createCliFileLock(home)(
      "refresh",
      async (assertHeld) => {
        assertHeld()
        return "taken"
      },
      "lineage"
    )
  ).resolves.toBe("taken")
  expect(fs.existsSync(file)).toBe(false)
})

it("does not steal a fresh partially written lock", async () => {
  const file = fileLockPath(home, "refresh", "lineage")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "")
  await expect(
    createCliFileLock(home, { waitMs: 10, retryMs: 2 })("refresh", async () => {}, "lineage")
  ).rejects.toBeInstanceOf(FileLockTimeoutError)
})

it("fences a replaced holder and never removes its successor", async () => {
  const file = fileLockPath(home, "refresh", "lineage")
  await expect(
    createCliFileLock(home)(
      "refresh",
      async (assertHeld) => {
        fs.writeFileSync(
          file,
          JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "successor" })
        )
        expect(assertHeld).toThrow(FileLockLostError)
      },
      "lineage"
    )
  ).rejects.toBeInstanceOf(FileLockLostError)
  expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe("successor")
})

it("separates names and categories without path traversal or sanitization collisions", () => {
  const a = fileLockPath(home, "../../a:b", "lineage")
  expect(path.dirname(a)).toBe(path.join(home, "auth", "locks"))
  expect(a).not.toBe(fileLockPath(home, "../../a?b", "lineage"))
  expect(a).not.toBe(fileLockPath(home, "../../a:b", "connection"))
})

it("fences a synchronous task that loses its lease", () => {
  const file = fileLockPath(home, "state", "plugin-state")
  expect(() =>
    withCliFileLockSync(
      home,
      "state",
      () => {
        fs.writeFileSync(
          file,
          JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "replacement" })
        )
      },
      "plugin-state"
    )
  ).toThrow(FileLockLostError)
  expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe("replacement")
})

it("keeps a live storage transaction fenced even beyond the stale age", async () => {
  const lock = createCliFileLock(home, { staleMs: 1, retryMs: 1, waitMs: 15 })
  await lock(
    "cas",
    async (assertHeld) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      await expect(lock("cas", async () => {}, "credentials")).rejects.toBeInstanceOf(
        FileLockTimeoutError
      )
      assertHeld()
    },
    "credentials"
  )
})

it("preserves a successor inode when the initial lockfile write fails", async () => {
  const file = fileLockPath(home, "refresh", "lineage")
  const original = fs.writeFileSync
  const failure = new Error("lock initialization failed")
  const write = jest.spyOn(fs, "writeFileSync").mockImplementation((target, ...args) => {
    if (typeof target === "number") {
      fs.unlinkSync(file)
      original(
        file,
        JSON.stringify({ pid: process.pid, timestamp: Date.now(), token: "successor" })
      )
      throw failure
    }
    Reflect.apply(original, fs, [target, ...args])
  })
  try {
    await expect(createCliFileLock(home)("refresh", async () => {}, "lineage")).rejects.toThrow(
      failure
    )
    expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe("successor")
  } finally {
    write.mockRestore()
  }
})

it("recovers a crashed reaper without deleting the successor of concurrent processes", async () => {
  const file = fileLockPath(home, "refresh", "lineage")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, timestamp: Date.now(), token: "dead" }))
  fs.writeFileSync(`${file}.guard`, JSON.stringify({ pid: 2147483647, token: "dead-reaper" }))
  const counter = path.join(home, "counter")
  fs.writeFileSync(counter, "0")
  const { outputFiles } = buildSync({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
      import fs from "node:fs"
      import path from "node:path"
      import { createCliFileLock } from "./cli/src/plugin/file-lock"
      const [home] = process.argv.slice(2)
      createCliFileLock(home, { retryMs: 2 })("refresh", async (assertHeld) => {
        const file = path.join(home, "counter")
        const before = Number(fs.readFileSync(file, "utf8"))
        await new Promise(resolve => setTimeout(resolve, 15))
        assertHeld()
        fs.writeFileSync(file, String(before + 1))
      }, "lineage").catch(error => { console.error(error); process.exitCode = 1 })
    `,
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
  })
  const script = path.join(home, "lock-child.cjs")
  fs.writeFileSync(script, outputFiles![0].text)
  const children = Array.from({ length: 6 }, () =>
    spawn(process.execPath, [script, home], { stdio: ["ignore", "ignore", "pipe"] })
  )
  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            let stderr = ""
            child.stderr!.on("data", (chunk) => {
              stderr += String(chunk)
            })
            child.once("error", reject)
            child.once("exit", (code) => {
              if (code === 0) resolve()
              else reject(new Error(`Lock child failed (${code}): ${stderr}`))
            })
          })
      )
    )
    expect(fs.readFileSync(counter, "utf8")).toBe("6")
    expect(fs.existsSync(file)).toBe(false)
  } finally {
    children.forEach((child) => child.kill())
  }
})
