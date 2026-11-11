import { mkdtemp, readFile, stat, rm, readdir, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import os from "node:os"
import path from "node:path"

import {
  createNodeBackupFilesystem,
  createUnavailableBackupFilesystem,
  getServeInstallationId,
} from "./backup-filesystem"

describe("createNodeBackupFilesystem", () => {
  it("refuses ownership lookup and every filesystem operation when backups are unavailable", async () => {
    const error = new Error("Host backups unavailable: invalid_headless_installation_id")
    const filesystem = createUnavailableBackupFilesystem(error)
    expect(() => filesystem.installationId).toThrow(error)
    let generated = false
    await expect(
      filesystem.writeStream!(
        "target",
        (async function* () {
          generated = true
          yield new Uint8Array([1])
        })()
      )
    ).rejects.toBe(error)
    expect(generated).toBe(false)
    await expect(filesystem.writeTextFile("target", "data")).rejects.toBe(error)
    await expect(filesystem.readDirNames("directory")).rejects.toBe(error)
    await expect(filesystem.remove("target")).rejects.toBe(error)
  })
  it("publishes one private installation UUID for concurrent boots and reuses it after process restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-installation-"))
    const home = path.join(root, "data", "serve")
    try {
      const ids = await Promise.all(Array.from({ length: 8 }, () => getServeInstallationId(home)))
      expect(new Set(ids).size).toBe(1)
      expect(ids[0]).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
      )
      expect((await readFile(path.join(home, "installation-id"), "utf8")).trim()).toBe(ids[0])
      if (process.platform !== "win32")
        expect((await stat(path.join(home, "installation-id"))).mode & 0o777).toBe(0o600)
      expect(await readdir(home)).toEqual(["installation-id"])
      const script = `require(${JSON.stringify(path.resolve(__dirname, "backup-filesystem.ts"))}).getServeInstallationId(process.argv[1]).then(id => process.stdout.write(id))`
      for (let restart = 0; restart < 2; restart++) {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "-e", script, home],
          { env: { ...process.env, TSX_DISABLE_CACHE: "1" }, timeout: 15_000 }
        )
        expect(stdout).toBe(ids[0])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refuses an invalid existing installation identity without replacing it", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "cognia-installation-invalid-"))
    try {
      await writeFile(path.join(home, "installation-id"), "damaged identity", { mode: 0o600 })
      await expect(getServeInstallationId(home)).rejects.toThrow("invalid_headless_installation_id")
      expect(await readFile(path.join(home, "installation-id"), "utf8")).toBe("damaged identity")
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it("atomically writes stream chunks and retains the previous backup when generation fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-backup-stream-"))
    try {
      const fs = createNodeBackupFilesystem()
      const target = path.join(root, "backup.cbk")
      const encoder = new TextEncoder()
      expect(
        await fs.writeStream!(
          target,
          (async function* () {
            yield encoder.encode("one")
            yield encoder.encode("two")
          })()
        )
      ).toBe(6)
      expect(await readFile(target, "utf8")).toBe("onetwo")
      await expect(
        fs.writeStream!(
          target,
          (async function* () {
            yield encoder.encode("broken")
            throw new Error("source read failed")
          })()
        )
      ).rejects.toThrow("source read failed")
      expect(await readFile(target, "utf8")).toBe("onetwo")
      expect(await fs.readDirNames(root)).toEqual(["backup.cbk"])
      let cancelled = false
      await expect(
        fs.writeStream!(
          target,
          (async function* () {
            yield encoder.encode("cancelled")
            cancelled = true
          })(),
          () => {
            if (cancelled) throw new Error("cancelled")
          }
        )
      ).rejects.toThrow("cancelled")
      expect(await readFile(target, "utf8")).toBe("onetwo")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it("writes private files, lists names, and removes retained backups", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cognia-backup-fs-"))
    const target = path.join(root, "nested", "backup.enc.cbk")
    const filesystem = createNodeBackupFilesystem()

    await filesystem.writeTextFile(target, "encrypted")
    expect(await readFile(target, "utf8")).toBe("encrypted")
    expect(await filesystem.readDirNames(path.dirname(target))).toEqual(["backup.enc.cbk"])
    await expect(filesystem.writeTextFile(target, "other owner")).rejects.toMatchObject({
      code: "EEXIST",
    })
    await expect(
      filesystem.writeStream!(
        target,
        (async function* () {
          yield new TextEncoder().encode("other owner")
        })()
      )
    ).rejects.toMatchObject({ code: "EEXIST" })
    expect(await readFile(target, "utf8")).toBe("encrypted")
    expect(await filesystem.readDirNames(path.dirname(target))).toEqual(["backup.enc.cbk"])
    if (process.platform !== "win32") {
      expect((await stat(target)).mode & 0o777).toBe(0o600)
    }

    await filesystem.remove(target)
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" })
    await rm(root, { recursive: true, force: true })
  })
})
