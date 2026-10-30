import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { isolatedEnvironment, managedProcess, parseArgs, runHostSmoke } from "./cli-api-host.mjs"

test("isolated Host environment excludes real credentials and routing", () => {
  const env = isolatedEnvironment("/private/smoke", {
    PATH: "/bin",
    OPENAI_API_KEY: "canary",
    COGNIA_SERVICE_TOKEN: "canary",
    COGNIA_ENDPOINT: "https://real.example",
    HTTPS_PROXY: "https://proxy.example",
  })
  assert.equal(env.PATH, "/bin")
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.COGNIA_SERVICE_TOKEN, undefined)
  assert.equal(env.COGNIA_ENDPOINT, undefined)
  assert.equal(env.HTTPS_PROXY, undefined)
  assert.equal(env.COGNIA_EXECUTION, "disabled")
  assert.equal(new URL(env.COGNIA_SIGNALING_URL).hostname, "127.0.0.1")
  assert.equal(env.COGNIA_DATA_DIR, path.join("/private/smoke", "host-data"))
})

test("Host smoke rejects unbounded budgets and unknown options", () => {
  for (const args of [
    ["--timeout", "0"],
    ["--timeout", "Infinity"],
    ["--timeout", "301"],
    ["--unknown"],
  ])
    assert.throws(() => parseArgs(args))
  assert.equal(parseArgs(["--timeout", "30"]).timeout, 30)
  assert.deepEqual(parseArgs(["--help"]), { help: true })
})

test(
  "a timed-out child that ignores SIGTERM is killed and reaped",
  { timeout: 5000, skip: process.platform === "win32" },
  async () => {
    const child = managedProcess(
      process.execPath,
      ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      { cwd: process.cwd(), env: { PATH: process.env.PATH }, timeoutMs: 200, stopGraceMs: 50 }
    )
    const result = await child.result
    assert.equal(result.timedOut, true)
    assert.equal(result.code, null)
    assert.equal(child.exited(), true)
    await child.stop()
  }
)

test("setup failure removes its private directory", async () => {
  const write = fs.writeFileSync
  let created
  fs.writeFileSync = (file, ...args) => {
    if (String(file).endsWith(`${path.sep}signaling.json`)) {
      created = path.resolve(path.dirname(String(file)), "../..")
      throw Object.assign(new Error("injected setup failure"), { code: "EIO" })
    }
    return write(file, ...args)
  }
  try {
    await assert.rejects(
      runHostSmoke({ server: process.execPath, cli: process.execPath, timeout: 1 }),
      { code: "EIO" }
    )
    assert.ok(created)
    assert.equal(fs.existsSync(created), false)
  } finally {
    fs.writeFileSync = write
    if (created) fs.rmSync(created, { recursive: true, force: true })
  }
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(
    `interrupting the actual ${signal} harness reaps its Host and removes private data`,
    { timeout: 10000, skip: process.platform === "win32" },
    async () => {
      const root = fileURLToPath(new URL("../../", import.meta.url))
      const parent = path.join(root, ".cache/diagnostics/cli-api-host-tests")
      fs.mkdirSync(parent, { recursive: true })
      const directory = fs.mkdtempSync(path.join(parent, "signal-"))
      const marker = path.join(directory, "host.json")
      const fixture = path.join(directory, "host.mjs")
      fs.writeFileSync(
        fixture,
        `#!/usr/bin/env node\nimport fs from "node:fs"; import path from "node:path";
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid: process.pid, directory: path.dirname(process.env.COGNIA_DATA_DIR)}));
setInterval(() => {}, 1000);\n`,
        { mode: 0o700 }
      )
      const harness = spawn(
        process.execPath,
        [path.join(root, "scripts/smoke/cli-api-host.mjs"), "--server", fixture, "--cli", fixture],
        { env: { PATH: process.env.PATH }, stdio: "ignore" }
      )
      const exited = new Promise((resolve, reject) => {
        harness.once("error", reject)
        harness.once("exit", (code) => resolve(code))
      })
      let host
      try {
        const deadline = Date.now() + 4000
        while (!fs.existsSync(marker) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20))
        assert.ok(fs.existsSync(marker), "owned Host fixture must start")
        host = JSON.parse(fs.readFileSync(marker, "utf8"))
        harness.kill(signal)
        assert.equal(await exited, signal === "SIGINT" ? 130 : 143)
        assert.throws(() => process.kill(host.pid, 0), { code: "ESRCH" })
        assert.equal(fs.existsSync(host.directory), false)
      } finally {
        harness.kill("SIGKILL")
        if (host) {
          try {
            process.kill(-host.pid, "SIGKILL")
          } catch (error) {
            if (error.code !== "ESRCH") throw error
          }
          assert.ok(
            host.directory.startsWith(path.join(root, ".cache/diagnostics/cli-api-host/run-"))
          )
          fs.rmSync(host.directory, { recursive: true, force: true })
        }
        fs.rmSync(directory, { recursive: true, force: true })
      }
    }
  )
}
