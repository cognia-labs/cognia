import { createHash } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { NativeConnectorBridge, nativeReadyIdentity } from "./connector-native"

test("Tauri lane rejects stdio-only readiness and a different process identity", () => {
  expect(() => nativeReadyIdentity({}, 123, true)).toThrow("identity")
  expect(() =>
    nativeReadyIdentity({ runtime: "wry", ipc: "webview-invoke", pid: 456 }, 123, true)
  ).toThrow("identity")
  expect(
    nativeReadyIdentity({ runtime: "wry", ipc: "webview-invoke", pid: 123 }, 123, true)
  ).toEqual({ runtime: "wry", ipc: "webview-invoke", pid: 123 })
  expect(nativeReadyIdentity({}, 123, false)).toBeUndefined()
})

it("refuses missing native identity rather than substituting JS", async () => {
  const binary = process.env.COGNIA_IM_NATIVE_BINARY
  delete process.env.COGNIA_IM_NATIVE_BINARY
  try {
    const bridge = new NativeConnectorBridge("http://127.0.0.1:1", () => {})
    await expect(bridge.start()).rejects.toThrow("identity missing or stale")
    expect(bridge.starts).toBe(0)
  } finally {
    if (binary === undefined) delete process.env.COGNIA_IM_NATIVE_BINARY
    else process.env.COGNIA_IM_NATIVE_BINARY = binary
  }
})

;(process.platform === "win32" ? it.skip : it)(
  "reports event-handler failure delivered during clean process shutdown",
  async () => {
    const directory = path.resolve(".cache/test-results/im-native")
    await mkdir(directory, { recursive: true })
    const temporary = await mkdtemp(path.join(directory, "late-event-"))
    const artifact = path.join(temporary, "fixture")
    // A real subprocess emits an event only after receiving the shutdown line.
    const body = `#!/bin/sh\nprintf '%s\\n' '{"ready":true,"origin":"http://127.0.0.1:1"}'\nIFS= read -r line\nprintf '%s\\n' '{"event":"teardown","payload":{}}'\n`
    await writeFile(artifact, body, { mode: 0o700 })
    const previous = {
      binary: process.env.COGNIA_IM_NATIVE_BINARY,
      digest: process.env.COGNIA_IM_NATIVE_DIGEST,
    }
    process.env.COGNIA_IM_NATIVE_BINARY = artifact
    process.env.COGNIA_IM_NATIVE_DIGEST = createHash("sha256").update(body).digest("hex")
    const bridge = new NativeConnectorBridge("http://127.0.0.1:1", () => {
      throw new Error("Synthetic late handler failure")
    })
    try {
      await bridge.start()
      await expect(bridge.dispose()).rejects.toThrow("Invalid native bridge frame or event handler")
      const receipt = JSON.parse(
        await readFile(path.join(directory, `process-${bridge.profileId}.json`), "utf8")
      )
      expect(receipt).toMatchObject({
        starts: 1,
        readyStarts: 1,
        exit: { code: 0, signal: null },
        lifecycle: "failed",
        cleanupError: "Native process lifecycle failed",
      })
    } finally {
      for (const [key, value] of Object.entries({
        COGNIA_IM_NATIVE_BINARY: previous.binary,
        COGNIA_IM_NATIVE_DIGEST: previous.digest,
      })) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

// Windows does not implement Unix executable permissions; this is a spawn
// failure regression on the macOS/Linux native lane, not a GUI requirement.
;(process.platform === "win32" ? it.skip : it)(
  "settles a real spawn failure and labels its receipt as failed",
  async () => {
    const directory = path.resolve(".cache/test-results/im-native")
    await mkdir(directory, { recursive: true })
    const temporary = await mkdtemp(path.join(directory, "non-executable-"))
    const artifact = path.join(temporary, "fixture")
    const body = "This file is intentionally not executable."
    await writeFile(artifact, body)
    await chmod(artifact, 0o600)
    const previous = {
      binary: process.env.COGNIA_IM_NATIVE_BINARY,
      digest: process.env.COGNIA_IM_NATIVE_DIGEST,
    }
    process.env.COGNIA_IM_NATIVE_BINARY = artifact
    process.env.COGNIA_IM_NATIVE_DIGEST = createHash("sha256").update(body).digest("hex")
    const bridge = new NativeConnectorBridge("http://127.0.0.1:1", () => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // An exit-only listener hangs forever for EACCES (error + close, no exit).
      await expect(
        Promise.race([
          bridge.start(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("spawn cleanup hung")), 1000)
          }),
        ])
      ).rejects.not.toThrow("spawn cleanup hung")
      const receipt = JSON.parse(
        await readFile(path.join(directory, `process-${bridge.profileId}.json`), "utf8")
      )
      expect(receipt).toMatchObject({
        starts: 1,
        readyStarts: 0,
        cleanupError: "Native process lifecycle failed",
        profileRemoved: true,
      })
      expect(receipt.exit.code).not.toBe(0)
      expect(receipt.pendingAfterCleanup).toBe(0)
      expect(receipt.socketsAfterCleanup).toBe(0)
    } finally {
      clearTimeout(timer)
      for (const [key, value] of Object.entries({
        COGNIA_IM_NATIVE_BINARY: previous.binary,
        COGNIA_IM_NATIVE_DIGEST: previous.digest,
      })) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(temporary, { recursive: true, force: true })
    }
  }
)
