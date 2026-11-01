import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"

import {
  CHANNEL_MANIFEST_FILE,
  acquireDshProcessLease,
  assertDshWritableRoots,
  defaultDataRoot,
  gatherDshRuntimeFacts,
  DshInstallError,
  RUNTIME_ARTIFACTS,
  computeCompositionDigest,
  doctorInstalledDshRuntime,
  dshHomeFor,
  findStrayPatchLayers,
  installDshRuntime,
  stageDshInstall,
  finalizeDshInstall,
  removeDshRuntime,
  runtimeHomeFor,
} from "./dsh-installer"
import { buildDshChannelManifest } from "@cognia/agent-dsh/install"

let dataRoot: string
let sourceDir: string

/** A fake `npm install`: writes a lockfile and a node_modules marker. */
async function fakeNpmInstall(cwd: string): Promise<void> {
  fs.writeFileSync(path.join(cwd, "package-lock.json"), JSON.stringify({ name: "x", version: "0" }))
  fs.mkdirSync(path.join(cwd, "node_modules"), { recursive: true })
}

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-data-"))
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-src-"))
  for (const artifact of RUNTIME_ARTIFACTS) {
    fs.writeFileSync(path.join(sourceDir, artifact), `# ${artifact}\n`)
  }
})

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
  fs.rmSync(sourceDir, { recursive: true, force: true })
})

function install(overrides: Partial<Parameters<typeof installDshRuntime>[0]> = {}) {
  return installDshRuntime({
    dataRoot,
    sourceDir,
    runNpmInstall: fakeNpmInstall,
    ...overrides,
  })
}

describe("computeCompositionDigest", () => {
  it("is stable for identical content", () => {
    expect(computeCompositionDigest(sourceDir)).toBe(computeCompositionDigest(sourceDir))
  })

  it("changes when a composition changes", () => {
    const before = computeCompositionDigest(sourceDir)
    fs.writeFileSync(path.join(sourceDir, "host.sdk-readonly.yml"), "# tampered\n")
    expect(computeCompositionDigest(sourceDir)).not.toBe(before)
  })

  it("distinguishes content moved between files", () => {
    // Length and name are folded in, so a byte swap cannot collide.
    const before = computeCompositionDigest(sourceDir)
    fs.writeFileSync(path.join(sourceDir, "host.sdk-readonly.yml"), "AB")
    fs.writeFileSync(path.join(sourceDir, "host.sdk-workspace.yml"), "")
    const first = computeCompositionDigest(sourceDir)
    fs.writeFileSync(path.join(sourceDir, "host.sdk-readonly.yml"), "")
    fs.writeFileSync(path.join(sourceDir, "host.sdk-workspace.yml"), "AB")
    expect(computeCompositionDigest(sourceDir)).not.toBe(first)
    expect(first).not.toBe(before)
  })
})

describe("installDshRuntime", () => {
  it("preserves native sessions and attachments across reinstall", async () => {
    await install()
    const home = runtimeHomeFor(dataRoot)
    fs.mkdirSync(path.join(home, "sessions"))
    fs.mkdirSync(path.join(home, "dsh-home", "attachments"))
    fs.writeFileSync(path.join(home, "sessions", "native.jsonl"), "durable session")
    fs.writeFileSync(path.join(home, "dsh-home", "attachments", "image.png"), "attachment")
    await install()
    expect(fs.readFileSync(path.join(home, "sessions", "native.jsonl"), "utf8")).toBe(
      "durable session"
    )
    expect(fs.readFileSync(path.join(home, "dsh-home", "attachments", "image.png"), "utf8")).toBe(
      "attachment"
    )
  })

  it("refuses maintenance when another host has a live process lease", async () => {
    await install()
    const leases = path.join(dataRoot, ".deepseek-harness-control", "processes")
    fs.mkdirSync(leases, { recursive: true })
    fs.writeFileSync(
      path.join(leases, "host.json"),
      JSON.stringify({ schemaVersion: 1, pid: process.pid, processId: "another-host" })
    )
    await expect(install()).rejects.toThrow(/process|using|lease/i)
    expect(() => removeDshRuntime({ dataRoot, activeSessionCount: 0 })).toThrow(
      /process|using|lease/i
    )
  })

  it("does not let a concurrent stage erase another install", async () => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = stageDshInstall({
      dataRoot,
      sourceDir,
      runNpmInstall: async (cwd) => {
        await pending
        await fakeNpmInstall(cwd)
      },
    })
    try {
      await expect(
        stageDshInstall({ dataRoot, sourceDir, runNpmInstall: fakeNpmInstall })
      ).rejects.toThrow(/maintenance|install/i)
    } finally {
      release()
    }
    const staged = await first
    expect(staged).toHaveProperty("installId", expect.any(String))
  })

  it("keeps completed stages separate and validates their certified bytes", async () => {
    const first = await stageDshInstall({ dataRoot, sourceDir, runNpmInstall: fakeNpmInstall })
    const second = await stageDshInstall({ dataRoot, sourceDir, runNpmInstall: fakeNpmInstall })
    const a = first
    const b = second
    expect(a.installId).toEqual(expect.any(String))
    expect(a.installId).not.toBe(b.installId)
    const stage = `${runtimeHomeFor(dataRoot)}.staging-${a.installId}`
    expect(fs.existsSync(stage)).toBe(true)
    fs.writeFileSync(path.join(stage, "launcher.mjs"), "tampered")
    const manifest = JSON.stringify({
      lockfileDigest: a.lockfileDigest,
      compositionDigest: a.compositionDigest,
    })
    expect(() => finalizeDshInstall(dataRoot, manifest, a.installId)).toThrow(
      /digest|changed|match/i
    )
  })

  it("rechecks process ownership at finalize and activates only the named ready stage", async () => {
    const first = await stageDshInstall({ dataRoot, sourceDir, runNpmInstall: fakeNpmInstall })
    fs.writeFileSync(path.join(sourceDir, "launcher.mjs"), "second-launcher")
    const second = await stageDshInstall({ dataRoot, sourceDir, runNpmInstall: fakeNpmInstall })
    const lease = acquireDshProcessLease(dataRoot, "started-after-staging")
    const manifest = JSON.stringify(buildDshChannelManifest(first))
    try {
      expect(() => finalizeDshInstall(dataRoot, manifest, first.installId)).toThrow(
        /process leases/
      )
      expect(fs.existsSync(`${runtimeHomeFor(dataRoot)}.staging-${first.installId}`)).toBe(true)
    } finally {
      lease.release()
    }
    finalizeDshInstall(dataRoot, manifest, first.installId)
    expect(fs.readFileSync(path.join(runtimeHomeFor(dataRoot), "launcher.mjs"), "utf8")).toBe(
      "# launcher.mjs\n"
    )
    expect(fs.existsSync(`${runtimeHomeFor(dataRoot)}.staging-${second.installId}`)).toBe(true)
    finalizeDshInstall(dataRoot, JSON.stringify(buildDshChannelManifest(second)), second.installId)
    expect(fs.readFileSync(path.join(runtimeHomeFor(dataRoot), "launcher.mjs"), "utf8")).toBe(
      "second-launcher"
    )
  })

  it.each(["incomplete", "stale-conformance", "changed-profile"])(
    "rejects a %s channel manifest before replacing live data",
    async (kind) => {
      await install()
      const home = runtimeHomeFor(dataRoot)
      fs.writeFileSync(path.join(home, "keep.txt"), "live-runtime")
      const staged = await stageDshInstall({ dataRoot, sourceDir, runNpmInstall: fakeNpmInstall })
      const manifest = buildDshChannelManifest(staged)
      let candidate: unknown = manifest
      if (kind === "incomplete")
        candidate = {
          lockfileDigest: staged.lockfileDigest,
          compositionDigest: staged.compositionDigest,
        }
      else if (kind === "stale-conformance") manifest.conformanceSuiteVersion = "4"
      else manifest.profiles[0].compositionFile = "dsh-home/evil.yml"

      expect(() =>
        finalizeDshInstall(dataRoot, JSON.stringify(candidate), staged.installId)
      ).toThrow(/channel manifest/i)
      expect(fs.readFileSync(path.join(home, "keep.txt"), "utf8")).toBe("live-runtime")
      expect(fs.existsSync(`${home}.staging-${staged.installId}`)).toBe(true)
    }
  )

  it("rolls back activation failure and preserves durable state through retry", async () => {
    await install()
    const home = runtimeHomeFor(dataRoot)
    fs.mkdirSync(path.join(home, "sessions"))
    fs.writeFileSync(path.join(home, "sessions", "native.jsonl"), "resume me")
    const rename = fs.renameSync.bind(fs)
    let fail = true
    const spy = jest.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (fail && String(from).startsWith(`${home}.staging-`) && to === home) {
        fail = false
        throw new Error("activation denied")
      }
      rename(from, to)
    })
    try {
      await expect(install()).rejects.toThrow("activation denied")
      expect(fs.readFileSync(path.join(home, "sessions", "native.jsonl"), "utf8")).toBe("resume me")
      await install()
      expect(fs.readFileSync(path.join(home, "sessions", "native.jsonl"), "utf8")).toBe("resume me")
    } finally {
      spy.mockRestore()
    }
  })

  it("recovers the sole previous tree before reinstall without deleting its sessions", async () => {
    await install()
    const home = runtimeHomeFor(dataRoot)
    fs.mkdirSync(path.join(home, "sessions"))
    fs.writeFileSync(path.join(home, "sessions", "native.jsonl"), "recover me")
    fs.renameSync(home, `${home}.previous`)
    await install()
    expect(fs.readFileSync(path.join(home, "sessions", "native.jsonl"), "utf8")).toBe("recover me")
  })

  it("keeps both recovery trees when their durable ownership is ambiguous", async () => {
    await install()
    const home = runtimeHomeFor(dataRoot)
    fs.mkdirSync(`${home}.previous`)
    fs.writeFileSync(path.join(`${home}.previous`, "only-copy"), "retain me")
    await expect(install()).rejects.toThrow(/recovery|neither was deleted/)
    expect(fs.readFileSync(path.join(`${home}.previous`, "only-copy"), "utf8")).toBe("retain me")
    expect(fs.existsSync(path.join(home, CHANNEL_MANIFEST_FILE))).toBe(true)
  })

  it("preserves managed internal module links and refuses sibling-tree authority", async () => {
    await install()
    const home = runtimeHomeFor(dataRoot)
    const profile = path.join(home, "dsh-home", "profiles", "cognia-acp")
    fs.mkdirSync(profile, { recursive: true })
    fs.symlinkSync(path.join(home, "node_modules"), path.join(profile, "node_modules"), "dir")
    await install()
    expect(fs.realpathSync(path.join(profile, "node_modules"))).toBe(
      fs.realpathSync(path.join(home, "node_modules"))
    )
    fs.symlinkSync(sourceDir, path.join(profile, "sibling-authority"), "dir")
    await expect(install()).rejects.toThrow(/link escapes/)
    expect(fs.existsSync(path.join(home, CHANNEL_MANIFEST_FILE))).toBe(true)
  })

  it("rejects unfinished stages and mismatched manifests without replacing live files", async () => {
    await install()
    const first = fs.readFileSync(
      path.join(runtimeHomeFor(dataRoot), CHANNEL_MANIFEST_FILE),
      "utf8"
    )
    const installId = randomUUID()
    fs.mkdirSync(`${runtimeHomeFor(dataRoot)}.staging-${installId}`)
    expect(() => finalizeDshInstall(dataRoot, "{}", installId)).toThrow(/activate|ready|install/i)
    expect(() => finalizeDshInstall(dataRoot, "{}", "../previous")).toThrow(/identifier/)
    const staged = await stageDshInstall({ dataRoot, sourceDir, runNpmInstall: fakeNpmInstall })
    expect(() =>
      finalizeDshInstall(
        dataRoot,
        JSON.stringify({ ...buildDshChannelManifest(staged), lockfileDigest: "wrong" }),
        staged.installId
      )
    ).toThrow(/digests/)
    expect(
      fs.readFileSync(path.join(runtimeHomeFor(dataRoot), CHANNEL_MANIFEST_FILE), "utf8")
    ).toBe(first)
  })

  it("installs the artifacts and writes a channel manifest", async () => {
    const channel = await install()
    const home = runtimeHomeFor(dataRoot)
    for (const artifact of RUNTIME_ARTIFACTS) {
      expect(fs.existsSync(path.join(home, artifact))).toBe(true)
    }
    expect(fs.existsSync(path.join(home, CHANNEL_MANIFEST_FILE))).toBe(true)
    expect(channel.schemaVersion).toBe(1)
    expect(channel.experimental).toBe(true)
  })

  it("creates the pinned DSH_HOME inside the runtime home", async () => {
    // The launcher refuses to boot unless DSH_HOME canonicalizes inside here.
    await install()
    expect(fs.existsSync(dshHomeFor(dataRoot))).toBe(true)
  })

  it("records digests that match what is on disk", async () => {
    const channel = await install()
    expect(channel.compositionDigest).toBe(computeCompositionDigest(runtimeHomeFor(dataRoot)))
    expect(channel.lockfileDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("derives the channel id from the composition digest", async () => {
    const channel = await install()
    expect(channel.channelId).toContain(channel.compositionDigest.slice(0, 8))
  })

  it("refuses to install when a source artifact is missing", async () => {
    fs.rmSync(path.join(sourceDir, "launcher.mjs"))
    await expect(install()).rejects.toThrow(DshInstallError)
  })

  it("leaves the previous runtime intact when npm fails", async () => {
    // A failed upgrade must not strand the user with no runtime at all.
    const first = await install()
    await expect(
      install({
        runNpmInstall: async () => {
          throw new Error("network down")
        },
      })
    ).rejects.toThrow(/previous runtime was left in place/)

    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeHomeFor(dataRoot), CHANNEL_MANIFEST_FILE), "utf8")
    )
    expect(manifest.channelId).toBe(first.channelId)
  })

  it.each(["one-phase", "two-phase"])(
    "cleans only its failed %s stage and preserves another ready install",
    async (mode) => {
      const ready = await stageDshInstall({ dataRoot, sourceDir, runNpmInstall: fakeNpmInstall })
      const runNpmInstall = async () => {
        throw new Error("boom")
      }
      await expect(
        mode === "one-phase"
          ? install({ runNpmInstall })
          : stageDshInstall({ dataRoot, sourceDir, runNpmInstall })
      ).rejects.toThrow(DshInstallError)
      expect(
        fs.readdirSync(dataRoot).filter((name) => name.startsWith("deepseek-harness.staging"))
      ).toEqual([`deepseek-harness.staging-${ready.installId}`])
    }
  )

  it("refuses to certify an install that produced no lockfile", async () => {
    // The lockfile digest is the dependency identity; without it nothing is pinned.
    await expect(install({ runNpmInstall: async () => {} })).rejects.toThrow(/no package-lock/)
  })

  it("replaces an existing install and leaves no .previous directory", async () => {
    await install()
    fs.writeFileSync(path.join(sourceDir, "host.sdk-readonly.yml"), "# v2\n")
    const second = await install()
    const manifest = JSON.parse(
      fs.readFileSync(path.join(runtimeHomeFor(dataRoot), CHANNEL_MANIFEST_FILE), "utf8")
    )
    expect(manifest.channelId).toBe(second.channelId)
    expect(fs.existsSync(`${runtimeHomeFor(dataRoot)}.previous`)).toBe(false)
  })

  it("reports progress without echoing credentials", async () => {
    const lines: string[] = []
    await install({ onProgress: (line) => lines.push(line) })
    expect(lines.join("\n")).toContain("Installed channel")
    expect(lines.join("\n")).not.toMatch(/sk-/)
  })
})

describe("host-owned runtime leases", () => {
  const bootId = () =>
    process.platform === "linux"
      ? fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim().toLowerCase()
      : execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { encoding: "utf8" })
          .trim()
          .toLowerCase()
  function writeOwner(kind: "processes" | "maintenance", record: Record<string, unknown>) {
    const dir = path.join(dataRoot, ".deepseek-harness-control", kind)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${randomUUID()}.json`)
    fs.writeFileSync(file, JSON.stringify(record))
    return file
  }

  it("keeps maintenance blocked after a started owner exits without retirement proof", () => {
    const lease = acquireDshProcessLease(dataRoot, "crashed-runtime")
    lease.updateChildPid(2147483647)
    lease.release()
    expect(() => removeDshRuntime({ dataRoot })).toThrow(/retirement|process leases/)
  })

  it("ignores an unsettled owner only after a verified different boot epoch", () => {
    const currentBoot = bootId()
    let previousBoot = randomUUID()
    while (previousBoot === currentBoot) previousBoot = randomUUID()
    writeOwner("processes", {
      schemaVersion: 2,
      pid: 2147483647,
      childPid: 2147483646,
      bootId: previousBoot,
      retirementRequired: true,
      retired: false,
    })
    expect(() => removeDshRuntime({ dataRoot })).not.toThrow()
  })

  it("does not mistake uppercase current-boot identity for a different boot", () => {
    writeOwner("processes", {
      schemaVersion: 2,
      pid: 2147483647,
      childPid: 2147483646,
      bootId: bootId().toUpperCase(),
      retirementRequired: true,
      retired: false,
    })
    expect(() => removeDshRuntime({ dataRoot })).toThrow(/ownership|retirement|process leases/)
  })

  it.each(["mismatched", "missing"])("refuses a %s legacy-shadow filename binding", (kind) => {
    const directory = path.join(dataRoot, ".deepseek-harness-control", "processes")
    fs.mkdirSync(directory, { recursive: true })
    const source = "original.json"
    const filename = `legacy-${createHash("sha256").update(source).digest("hex")}.json`
    fs.writeFileSync(
      path.join(directory, filename),
      JSON.stringify({
        schemaVersion: 2,
        pid: 2147483647,
        bootId: randomUUID(),
        retirementRequired: true,
        retired: false,
        ...(kind === "mismatched" ? { legacyRecord: "different.json" } : {}),
      })
    )
    const home = runtimeHomeFor(dataRoot)
    fs.mkdirSync(home)
    fs.writeFileSync(path.join(home, "preserved"), "native data")
    expect(() => removeDshRuntime({ dataRoot })).toThrow(/ownership|retirement/)
    expect(fs.readFileSync(path.join(home, "preserved"), "utf8")).toBe("native data")
  })

  it("quarantines legacy ownership separately so an old host cannot erase the guard", () => {
    const original = writeOwner("processes", {
      schemaVersion: 1,
      pid: 2147483647,
      childPid: 2147483646,
    })
    expect(() => removeDshRuntime({ dataRoot })).toThrow(/retirement|process leases/)
    fs.rmSync(original)
    expect(() => removeDshRuntime({ dataRoot })).toThrow(/retirement|process leases/)
  })

  it("retains a quarantine if an observed process record disappears during its read", () => {
    const original = writeOwner("processes", { schemaVersion: 1, pid: 2147483647 })
    const readFile = fs.readFileSync
    const read = jest
      .spyOn(fs, "readFileSync")
      .mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]) === original) {
          fs.rmSync(original)
          throw Object.assign(new Error("record disappeared"), { code: "ENOENT" })
        }
        return readFile(...args)
      })
    try {
      expect(() => removeDshRuntime({ dataRoot })).toThrow(/ownership|retirement/)
    } finally {
      read.mockRestore()
    }
    expect(() => removeDshRuntime({ dataRoot })).toThrow(/process leases/)
  })

  it("publishes boot-scoped ownership and never drops a started unproved lease", () => {
    const stale = writeOwner("processes", { schemaVersion: 1, pid: 2147483647 })
    const lease = acquireDshProcessLease(dataRoot, "pending-session")
    lease.updateChildPid(process.pid)
    const dir = path.dirname(stale)
    const files = fs.readdirSync(dir).filter((name) => path.join(dir, name) !== stale)
    expect(files).toHaveLength(1)
    expect(fs.readFileSync(path.join(dir, files[0]), "utf8")).not.toContain(lease.nonce)
    expect(JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"))).toEqual({
      schemaVersion: 2,
      pid: process.pid,
      processId: "pending-session",
      childPid: process.pid,
      nonceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      bootId: bootId(),
      retirementRequired: true,
      retired: false,
    })
    expect(() => removeDshRuntime({ dataRoot })).toThrow(/process leases/)
    lease.release()
    lease.release()
    expect(fs.existsSync(stale)).toBe(true)
    expect(fs.existsSync(path.join(dir, files[0]))).toBe(true)
    expect(() => removeDshRuntime({ dataRoot })).toThrow(/process leases/)
  })

  it("never grants workspace writes to staged or recovery runtime code", async () => {
    await install()
    const staged = await stageDshInstall({ dataRoot, sourceDir, runNpmInstall: fakeNpmInstall })
    const home = runtimeHomeFor(dataRoot)
    const staging = `${home}.staging-${staged.installId}`
    const previous = `${home}.previous`
    fs.mkdirSync(previous)
    for (const root of [staging, path.join(staging, "node_modules"), previous]) {
      expect(() => assertDshWritableRoots(dataRoot, [root])).toThrow(/runtime code/i)
    }
    const alias = path.join(dataRoot, "stage-alias")
    fs.symlinkSync(staging, alias, "dir")
    expect(() => assertDshWritableRoots(dataRoot, [alias])).toThrow(/runtime code/i)
    expect(() => assertDshWritableRoots(dataRoot, [path.join(home, "dsh-home")])).not.toThrow()
  })

  it("never infers retirement from a dead owner while a child survives", async () => {
    writeOwner("processes", {
      schemaVersion: 2,
      pid: 2147483647,
      childPid: process.pid,
      bootId: bootId(),
      retirementRequired: true,
      retired: false,
    })
    await expect(install()).rejects.toThrow(/process leases/)
  })

  it("honors independent process ownership even after the owner is killed", async () => {
    const dir = path.join(dataRoot, ".deepseek-harness-control", "processes")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${randomUUID()}.json`)
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      const file = process.argv[1];
      fs.writeFileSync(file + '.tmp', JSON.stringify({schemaVersion:1,pid:process.pid,processId:'independent-host'}));
      fs.renameSync(file + '.tmp', file);
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `,
        file,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    )
    const exited = once(child, "exit")
    try {
      await once(child.stdout!, "data")
      await expect(install()).rejects.toThrow(/process leases/)
      expect(() => removeDshRuntime({ dataRoot, activeSessionCount: 0 })).toThrow(/process leases/)
    } finally {
      child.kill("SIGKILL")
      await exited
    }
    await expect(install()).rejects.toThrow(/process leases/)
    const pending = acquireDshProcessLease(dataRoot, "another-session-is-allowed")
    pending.release()
  })

  it("fails closed for malformed ownership and unknown maintenance liveness", async () => {
    writeOwner("processes", { schemaVersion: 2, pid: process.pid })
    await expect(install()).rejects.toThrow(/ownership/)
    writeOwner("maintenance", { schemaVersion: 1, pid: 2147483647, operationId: randomUUID() })
    const kill = jest.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" })
    })
    try {
      await expect(install()).rejects.toThrow(/maintenance/)
      expect(kill).toHaveBeenCalledWith(2147483647, 0)
    } finally {
      kill.mockRestore()
    }
  })

  it("refuses process start during another live maintenance operation", () => {
    writeOwner("maintenance", { schemaVersion: 1, pid: process.pid, operationId: randomUUID() })
    expect(() => acquireDshProcessLease(dataRoot, "blocked-start")).toThrow(/maintenance/)
    expect(fs.readdirSync(path.join(dataRoot, ".deepseek-harness-control", "processes"))).toEqual(
      []
    )
  })

  it("honors the documented relocated runtime data root", () => {
    const before = process.env.COGNIA_DATA_DIR
    try {
      process.env.COGNIA_DATA_DIR = dataRoot
      expect(defaultDataRoot()).toBe(dataRoot)
    } finally {
      if (before === undefined) delete process.env.COGNIA_DATA_DIR
      else process.env.COGNIA_DATA_DIR = before
    }
  })
})

describe("findStrayPatchLayers", () => {
  it("finds nothing in a clean home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"))
    expect(findStrayPatchLayers(home)).toEqual([])
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("finds a home-level patch file", async () => {
    await install()
    const home = dshHomeFor(dataRoot)
    const patch = path.join(home, "cordis.patch.yml")
    fs.writeFileSync(patch, "- id: evil\n")
    expect(findStrayPatchLayers(home)).toEqual([patch])
  })

  it("finds per-profile patch files and out-of-tree plugin manifests", async () => {
    // A profile package.json declares out-of-tree plugin dependencies, which is
    // just as much a hole in the certification as a patch file.
    await install()
    const home = dshHomeFor(dataRoot)
    const profile = path.join(home, "profiles", "sneaky")
    fs.mkdirSync(profile, { recursive: true })
    fs.writeFileSync(path.join(profile, "cordis.patch.yml"), "")
    fs.writeFileSync(path.join(profile, "package.json"), "{}")
    expect(findStrayPatchLayers(home)).toHaveLength(2)
  })

  it("ignores files that are not patch layers", async () => {
    await install()
    const home = dshHomeFor(dataRoot)
    fs.writeFileSync(path.join(home, "notes.txt"), "hello")
    expect(findStrayPatchLayers(home)).toEqual([])
  })
})

describe("doctorInstalledDshRuntime", () => {
  it("reports an uninstalled runtime rather than throwing", () => {
    const report = doctorInstalledDshRuntime({ dataRoot, profileId: "cognia-sdk-readonly" })
    expect(report.healthy).toBe(false)
    expect(report.findings[0].code).toBe("channel-malformed")
  })

  it("reports healthy immediately after install", async () => {
    await install()
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report).toEqual({ healthy: true, findings: [] })
  })

  it("detects a tampered composition", async () => {
    // The composition carries the sandbox and approval wiring, so this is the
    // check that makes the read-only guarantee meaningful.
    await install()
    fs.writeFileSync(path.join(runtimeHomeFor(dataRoot), "host.sdk-readonly.yml"), "# tampered\n")
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report.healthy).toBe(false)
    expect(report.findings.map((f) => f.code)).toContain("composition-digest-mismatch")
  })

  it("detects a tampered lockfile", async () => {
    await install()
    fs.writeFileSync(path.join(runtimeHomeFor(dataRoot), "package-lock.json"), "{}")
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report.findings.map((f) => f.code)).toContain("lockfile-digest-mismatch")
  })

  it("treats a stray patch layer as fatal on the read-only profile", async () => {
    await install()
    fs.writeFileSync(path.join(dshHomeFor(dataRoot), "cordis.patch.yml"), "- id: evil\n")
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report.healthy).toBe(false)
    expect(report.findings.map((f) => f.code)).toContain("stray-patch-layer")
  })

  it("reports a malformed manifest instead of crashing", async () => {
    await install()
    fs.writeFileSync(path.join(runtimeHomeFor(dataRoot), CHANNEL_MANIFEST_FILE), "{not json")
    const report = doctorInstalledDshRuntime({ dataRoot, profileId: "cognia-sdk-readonly" })
    expect(report.healthy).toBe(false)
    expect(report.findings[0].code).toBe("channel-malformed")
  })

  it("reports an unreadable digest as a mismatch rather than throwing", async () => {
    await install()
    fs.rmSync(path.join(runtimeHomeFor(dataRoot), "package-lock.json"))
    const report = doctorInstalledDshRuntime({
      dataRoot,
      profileId: "cognia-sdk-readonly",
      nodeVersion: "v26.0.0",
      platform: "darwin-arm64",
    })
    expect(report.findings.map((f) => f.code)).toContain("lockfile-digest-mismatch")
  })
})

describe("removeDshRuntime", () => {
  it("removes the runtime home", async () => {
    await install()
    removeDshRuntime({ dataRoot })
    expect(fs.existsSync(runtimeHomeFor(dataRoot))).toBe(false)
  })

  it("refuses while sessions are still using it", async () => {
    // Removing under a live session would strand a running subprocess whose
    // composition had just been deleted.
    await install()
    expect(() => removeDshRuntime({ dataRoot, activeSessionCount: 2 })).toThrow(DshInstallError)
    expect(fs.existsSync(runtimeHomeFor(dataRoot))).toBe(true)
  })

  it("is idempotent when nothing is installed", () => {
    expect(() => removeDshRuntime({ dataRoot })).not.toThrow()
  })
})

it("reports exact launch paths and only allowlisted host environment", () => {
  const facts = gatherDshRuntimeFacts(dataRoot)
  expect(facts.runtimeHome).toBe(runtimeHomeFor(dataRoot))
  expect(facts.nodePath).toBe(process.execPath)
  expect(facts.defaultWorkspace).toBe(process.cwd())
  expect(
    Object.keys(facts.parentEnv).every((key) =>
      ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"].includes(key)
    )
  ).toBe(true)
})

describe("managed profile patch-layer verification", () => {
  function manifest(profile: string) {
    return {
      name: profile,
      private: true,
      type: "module",
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-sdk-minimal"], patchReload: "startup" } },
    }
  }
  it("allows only exact generated manifests across all profiles after first launch", () => {
    const home = dshHomeFor(dataRoot)
    for (const profile of ["cognia-sdk-readonly", "cognia-sdk-workspace", "cognia-acp"]) {
      const dir = path.join(home, "profiles", profile)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest(profile)))
    }
    expect(findStrayPatchLayers(home)).toEqual([])
    const modified = path.join(home, "profiles", "cognia-sdk-readonly", "package.json")
    fs.writeFileSync(
      modified,
      JSON.stringify({ ...manifest("cognia-sdk-readonly"), dependencies: { malicious: "*" } })
    )
    expect(findStrayPatchLayers(home)).toEqual([modified])
  })
  it("rejects symlinked profile manifests even with approved content", () => {
    const home = dshHomeFor(dataRoot)
    const dir = path.join(home, "profiles", "cognia-acp")
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dataRoot, "approved.json")
    fs.writeFileSync(target, JSON.stringify(manifest("cognia-acp")))
    const link = path.join(dir, "package.json")
    fs.symlinkSync(target, link)
    expect(findStrayPatchLayers(home)).toEqual([link])
  })
  it("rejects symlinked profile directories and home .env", () => {
    const home = dshHomeFor(dataRoot)
    const profiles = path.join(home, "profiles")
    fs.mkdirSync(profiles, { recursive: true })
    const linked = path.join(profiles, "cognia-acp")
    fs.symlinkSync(sourceDir, linked)
    fs.writeFileSync(path.join(home, ".env"), "NODE_OPTIONS=bad")
    expect(findStrayPatchLayers(home)).toEqual([path.join(home, ".env"), linked].sort())
  })
})
