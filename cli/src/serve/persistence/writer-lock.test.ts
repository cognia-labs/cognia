import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { acquireWriterLease, hasLiveWriter } from "./writer-lock"

describe("writer leases", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-lease-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("excludes a second owner until the writer releases the lease", () => {
    const release = acquireWriterLease(root, "journal")
    expect(hasLiveWriter(root, "journal")).toBe(true)
    expect(() => acquireWriterLease(root, "journal")).toThrow(/live writer/)
    release()
    release()
    expect(hasLiveWriter(root, "journal")).toBe(false)
    acquireWriterLease(root, "journal")()
  })

  it("keeps an operator excluded until every local SQLite connection closes", () => {
    const first = acquireWriterLease(root, "sqlite", { shared: true })
    const second = acquireWriterLease(root, "sqlite", { shared: true })
    first()
    expect(() => acquireWriterLease(root, "sqlite")).toThrow(/live writer/)
    second()
    acquireWriterLease(root, "sqlite")()
  })

  it("never reuses a cached shared holder after a failed close", () => {
    const release = acquireWriterLease(root, "sqlite", { shared: true })
    const close = DatabaseSync.prototype.close
    const failure = jest.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (
      this: DatabaseSync
    ) {
      close.call(this)
      throw new Error("injected close failure")
    })
    try {
      expect(release).toThrow("injected close failure")
    } finally {
      failure.mockRestore()
    }
    const next = acquireWriterLease(root, "sqlite", { shared: true })
    try {
      expect(() => acquireWriterLease(root, "sqlite")).toThrow(/live writer/)
    } finally {
      next()
    }
  })

  it("cannot steal a replacement owner at the old stale compare/unlink boundary", () => {
    const legacy = path.join(root, ".journal-writer.lock")
    fs.writeFileSync(legacy, JSON.stringify({ pid: process.pid }))
    const dead = jest.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("dead fixture owner"), { code: "ESRCH" })
    })
    const unlink = fs.unlinkSync.bind(fs)
    let reentered = false
    let replacement: (() => void) | undefined
    let release: (() => void) | undefined
    const race = jest.spyOn(fs, "unlinkSync").mockImplementation((file) => {
      if (String(file) === legacy && !reentered) {
        reentered = true
        replacement = acquireWriterLease(root, "journal")
      }
      unlink(file)
    })
    try {
      release = acquireWriterLease(root, "journal")
      expect(() => acquireWriterLease(root, "journal")).toThrow(/live writer/)
      expect(replacement).toBeUndefined()
    } finally {
      release?.()
      replacement?.()
      race.mockRestore()
      dead.mockRestore()
    }
  })

  it.each(["", "{", JSON.stringify({ pid: process.pid })])(
    "ignores crash-left PID metadata %j",
    (payload) => {
      fs.writeFileSync(path.join(root, ".journal-writer.lock"), payload)
      acquireWriterLease(root, "journal")()
    }
  )

  it("releases a real child process's lock after SIGKILL", async () => {
    const child = startOwner(root, "journal")
    try {
      expect(await nextLine(child)).toBe("ready")
      child.stdin!.write("go\n")
      expect(await nextLine(child)).toBe("held")
      expect(() => acquireWriterLease(root, "journal")).toThrow(/live writer/)
      await killOwner(child)
      acquireWriterLease(root, "journal")()
    } finally {
      await killOwner(child)
    }
  })

  it("allows only one of two concurrent child acquirers", async () => {
    const children = [startOwner(root, "journal"), startOwner(root, "journal")]
    try {
      expect(await Promise.all(children.map(nextLine))).toEqual(["ready", "ready"])
      const outcomes = children.map(nextLine)
      for (const child of children) child.stdin!.write("go\n")
      expect((await Promise.all(outcomes)).sort()).toEqual(["busy", "held"])
    } finally {
      await Promise.all(children.map(killOwner))
    }
  })

  it.each(["journal", "sqlite"] as const)(
    "a live child %s lease blocks destructive tooling",
    async (store) => {
      const { writeCheckpoint } = await import("./checkpoint")
      const { finalizeDurability } = await import("./operations")
      const { openSqliteBackend, compactSqlite } = await import("./sqlite")
      if (store === "journal") writeCheckpoint(root, "gen-0001", { sequence: 0, dbs: {} })
      else await openSqliteBackend({ root }).close()
      const child = startOwner(root, store)
      try {
        expect(await nextLine(child)).toBe("ready")
        child.stdin!.write("go\n")
        expect(await nextLine(child)).toBe("held")
        expect(() =>
          store === "journal"
            ? finalizeDurability(root, "gen-0001", { confirm: true })
            : compactSqlite(root)
        ).toThrow(/live writer/)
      } finally {
        await killOwner(child)
      }
    }
  )
})

function startOwner(root: string, store: "journal" | "sqlite"): ChildProcess {
  const moduleUrl = pathToFileURL(path.join(__dirname, "writer-lock.ts")).href
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    const { acquireWriterLease } = (await import(${JSON.stringify(moduleUrl)})).default ?? await import(${JSON.stringify(moduleUrl)});
    process.stdin.once("data", () => {
      try { globalThis.release = acquireWriterLease(${JSON.stringify(root)}, ${JSON.stringify(store)}); console.log("held") }
      catch (error) { if (error.code !== "writer-busy") throw error; console.log("busy") }
    });
    process.stdin.resume();
    console.log("ready");
  `,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  )
}

function nextLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const onExit = () =>
      reject(new Error(`lease child exited: ${child.stderr?.read()?.toString() ?? ""}`))
    child.once("exit", onExit)
    child.stdout!.once("data", (chunk) => {
      child.off("exit", onExit)
      resolve(String(chunk).trim())
    })
    child.once("error", reject)
  })
}

async function killOwner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, "exit")
  child.kill("SIGKILL")
  await exited
}
