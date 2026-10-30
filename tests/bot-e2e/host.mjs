import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { pathToFileURL } from "node:url"
import { DatabaseSync } from "node:sqlite"

import { isolatedEnvironment } from "../../scripts/smoke/cli-api-host.mjs"
import { fixtureManifest } from "./fixtures/manifest.mjs"
import { validateBuild } from "./prepare.mjs"

const exec = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function until(read, accepts, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  do {
    try {
      last = await read()
      if (accepts(last)) return last
    } catch (error) {
      last = { error: error.message }
    }
    await pause(100)
  } while (Date.now() < deadline)
  throw new Error(`${label} did not settle: ${JSON.stringify(last).slice(0, 1500)}`)
}

// Negative contracts need the whole observation window. A failed read must
// fail the check rather than being interpreted as absence of an effect.
export async function remains(read, accepts, label, durationMs = 750) {
  const deadline = Date.now() + durationMs
  for (;;) {
    const value = await read()
    if (!accepts(value))
      throw new Error(`${label} changed: ${JSON.stringify(value).slice(0, 1500)}`)
    const remaining = deadline - Date.now()
    if (remaining <= 0) return
    await pause(Math.min(100, remaining))
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

export class BotHost {
  // A resumed TLS session may omit getPeerCertificate() details. Keep the
  // pin check strict and require full handshakes for this isolated client.
  agent = new https.Agent({ keepAlive: true, maxCachedSessions: 0 })
  effects = []
  barriers = new Map()
  released = new Set()
  returned = new Set()
  processes = []
  calls = []

  async open() {
    this.serverPath = path.resolve(
      process.env.COGNIA_BOT_E2E_SERVER ?? "target/debug/cognia-server"
    )
    this.brainPath = path.resolve(
      process.env.COGNIA_BOT_E2E_BRAIN ?? ".cache/bot-e2e/brain/cognia-agent.mjs"
    )
    for (const file of [this.serverPath, this.brainPath]) {
      await fs.access(file).catch(() => {
        throw new Error(`Missing Bot E2E artifact ${file}; run pnpm test:e2e:bots:prepare`)
      })
    }
    // Global setup verifies source freshness once for the prepared snapshot.
    // Each profile still verifies every executable byte before launching.
    this.build = await validateBuild(this.serverPath, this.brainPath, undefined, false)
    if (process.env.COGNIA_BOT_E2E_BUILD_ID !== this.build.inputDigest)
      throw new Error("Bot E2E global setup did not select this prepared build")
    const parent = path.join(ROOT, ".cache/test-results/bot-hosts")
    await fs.mkdir(parent, { recursive: true })
    this.directory = await fs.mkdtemp(path.join(parent, "run-"))
    await fs.chmod(this.directory, 0o700)
    this.env = isolatedEnvironment(this.directory)
    const brainEntry = path.join(this.directory, "brain-entry.mjs")
    // Explicit test-profile configuration: trust this workload alone. The
    // production policy reader and all plugin lifecycle gates remain active.
    await fs.writeFile(
      brainEntry,
      `
const values = new Map([["cognia.plugins.policy", ${JSON.stringify(JSON.stringify({ signatureRequired: false, autoUpdate: false, trustedFrontendPlugins: ["bot-e2e"] }))}]]);
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key), clear: () => values.clear(),
  key: index => [...values.keys()][index] ?? null, get length() { return values.size }
}});
await import(${JSON.stringify(pathToFileURL(this.brainPath).href)});
`
    )
    delete this.env.COGNIA_EXECUTION
    Object.assign(this.env, {
      COGNIA_BRAIN_ENTRY: brainEntry,
      COGNIA_SIDECAR_SCRIPT: path.join(ROOT, "sidecar/claude-host.mjs"),
      COGNIA_MCP_SIDECAR_PATH: path.join(ROOT, "sidecar/cognia-mcp.mjs"),
      COGNIA_EXEC_BACKEND: "local-process",
      COGNIA_PLUGIN_NODE_PATH: process.execPath,
      COGNIA_WORKSPACES_DIR: path.join(this.directory, "workspaces"),
    })
    const signaling = path.join(this.env.COGNIA_DATA_DIR, "cognia")
    await fs.mkdir(signaling, { recursive: true })
    await fs.writeFile(
      path.join(signaling, "signaling.json"),
      JSON.stringify({
        enabled: false,
        signalingUrl: this.env.COGNIA_SIGNALING_URL,
        iceServers: [],
        turnServers: [],
      })
    )
    const fixtureRoot = path.join(this.env.COGNIA_DATA_DIR, ".cognia/plugins/bot-e2e")
    await fs.mkdir(fixtureRoot, { recursive: true })
    await fs.copyFile(
      new URL("./fixtures/plugin.mjs", import.meta.url),
      path.join(fixtureRoot, "plugin.mjs")
    )
    await fs.writeFile(path.join(fixtureRoot, "plugin.json"), JSON.stringify(fixtureManifest()))
    this.recorder = http.createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/returned") {
        let runId = ""
        for await (const chunk of request) runId += chunk
        this.returned.add(runId)
        response.end("observed")
        return
      }
      if (request.url.startsWith("/barrier/")) {
        const runId = decodeURIComponent(request.url.slice("/barrier/".length))
        if (this.released.has(runId)) response.end("released")
        else {
          const waiting = this.barriers.get(runId) ?? new Set()
          waiting.add(response)
          this.barriers.set(runId, waiting)
          response.once("close", () => waiting.delete(response))
        }
        return
      }
      if (request.method !== "POST" || request.url !== "/effect") {
        response.writeHead(404).end()
        return
      }
      try {
        let body = ""
        for await (const chunk of request) {
          body += chunk
          if (body.length > 16_384) throw new Error("oversized recorder payload")
        }
        const effect = { ...JSON.parse(body), at: Date.now() }
        this.effects.push(effect)
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify({ receipt: this.effects.length }))
      } catch {
        response.writeHead(400).end()
      }
    })
    this.recorderUrl = `http://127.0.0.1:${await listen(this.recorder)}`
    const reservation = net.createServer()
    this.port = await listen(reservation)
    await new Promise((resolve) => reservation.close(resolve))
    this.hashes = Object.fromEntries(
      await Promise.all(
        [
          ["host", this.serverPath],
          ["brain", this.brainPath],
        ].map(async ([name, file]) => [
          name,
          createHash("sha256")
            .update(await fs.readFile(file))
            .digest("hex"),
        ])
      )
    )
    await this.start()
    return this
  }

  async start() {
    const child = spawn(
      this.serverPath,
      ["serve", "--port", String(this.port), "--bind-loopback", "--no-mdns"],
      {
        cwd: this.directory,
        env: this.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    const entry = { child, log: "", exited: false }
    this.processes.push(entry)
    this.current = entry
    const capture = (chunk) => {
      entry.log = (entry.log + chunk).slice(-512_000)
    }
    child.stdout.on("data", capture)
    child.stderr.on("data", capture)
    entry.done = new Promise((resolve) => {
      child.once("error", (error) => {
        capture(error.message)
        entry.exited = true
        resolve()
      })
      child.once("close", () => {
        entry.exited = true
        resolve()
      })
    })
    await until(
      async () => {
        if (entry.exited) throw new Error("Host exited before readiness")
        return this.request("GET", "/healthz")
      },
      (value) => value.status === 200,
      "Host health",
      20_000
    )
    const issued = await exec(this.serverPath, ["issue-service-token"], {
      env: this.env,
      cwd: this.directory,
      timeout: 10_000,
    })
    this.token = issued.stdout.trim()
    await until(
      () => entry.log,
      (log) =>
        /serve: runtimes up/.test(log) && /headless runtime started: bot-delivery-runner/.test(log),
      "required Brain runtimes",
      60_000
    )
    await until(
      () => this.rpc("bot_console_read", { view: "catalog" }),
      (value) => value.entries?.some((entry) => entry.definitionId === "bot-e2e:handler"),
      "production Bot plugin discovery and Brain bridge",
      60_000
    )
    assert.match(entry.log, /sqlite-v5/, "Brain must attach real SQLite durability")
  }

  request(method, pathname, payload) {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload)
      const request = https.request(
        {
          hostname: "127.0.0.1",
          port: this.port,
          path: pathname,
          method,
          agent: this.agent,
          rejectUnauthorized: false,
          headers: {
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...(method === "POST" ? { "idempotency-key": randomUUID() } : {}),
            ...(body
              ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
              : {}),
          },
        },
        (response) => {
          const fingerprint = response.socket.getPeerCertificate().fingerprint256
          if (!fingerprint || (this.fingerprint && fingerprint !== this.fingerprint)) {
            response.destroy()
            reject(
              new Error(
                `isolated Host TLS identity changed (expected ${this.fingerprint ?? "first peer"}, observed ${fingerprint ?? "missing peer certificate"})`
              )
            )
            return
          }
          this.fingerprint ??= fingerprint
          let text = ""
          response.on("data", (chunk) => {
            text += chunk
          })
          response.on("end", () => {
            try {
              resolve({ status: response.statusCode, body: JSON.parse(text) })
            } catch {
              reject(new Error(`non-JSON Host response (${response.statusCode})`))
            }
          })
          response.once("error", reject)
        }
      )
      request.setTimeout(10_000, () => request.destroy(new Error("Host request timeout")))
      request.once("error", reject)
      request.end(body)
    })
  }

  async rpc(command, payload = {}) {
    const response = await this.request("POST", `/internal/_rpc/${command}`, payload)
    this.calls.push({ command, at: Date.now(), status: response.status })
    if (response.status !== 200 || response.body.error) {
      throw new Error(`${command}: ${JSON.stringify(response.body).slice(0, 1200)}`)
    }
    Object.assign(this.calls.at(-1), {
      installationId:
        payload.installationId ??
        (command === "bot_installation_mutate" ? response.body.id : undefined),
      runId: payload.runId,
      operation: payload.operation,
      ...(response.body.deliveryId
        ? { deliveryId: response.body.deliveryId, created: response.body.created }
        : {}),
      ...(command === "execution_run_detail"
        ? {
            runStatus: response.body.run?.status,
            revision: response.body.run?.currentRevision,
            interrupts: response.body.interrupts?.map(({ id, status, expiresAt }) => ({
              id,
              status,
              expiresAt,
            })),
          }
        : {}),
    })
    return response.body
  }

  mutate(input) {
    return this.rpc("bot_installation_mutate", { operationId: randomUUID(), ...input })
  }

  install(extra = {}) {
    return this.mutate({
      operation: "install",
      definitionId: "bot-e2e:handler",
      version: "1.0.0",
      scope: { kind: "account" },
      config: { recorder: this.recorderUrl },
      enabled: true,
      ...extra,
    })
  }

  async run(installationId, input = {}, triggerId = "first", idempotencyKey = randomUUID()) {
    const delivery = await this.rpc("bot_run_manual", {
      installationId,
      triggerId,
      idempotencyKey,
      input,
    })
    return { ...delivery, runId: `run_bot_${delivery.deliveryId}` }
  }

  async detail(runId) {
    return this.rpc("execution_run_detail", { runId })
  }

  async deliveries(installationId) {
    const delta = await this.rpc("sync_pull", { table: "botEventDeliveries", since: 0 })
    return delta.rows.filter((row) => row.installationId === installationId)
  }

  // Independent, read-only evidence from this test profile's actual durable
  // store. No private row is exported through a production control command.
  async storedRows(table) {
    const stores = []
    const visit = async (directory) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name)
        if (entry.isDirectory()) await visit(file)
        else if (entry.isFile() && entry.name === "store.sqlite") stores.push(file)
      }
    }
    // The native Host chooses its Brain home. Stay in this owned profile and
    // never follow symlinks into workspace or user directories.
    await visit(this.directory)
    assert.equal(stores.length, 1, "private profile must have one SQLite durability store")
    const db = new DatabaseSync(stores[0], { readOnly: true })
    try {
      return db
        .prepare("SELECT value FROM durability_rows WHERE table_name = ?")
        .all(table)
        .map((row) => JSON.parse(row.value))
    } finally {
      db.close()
    }
  }

  async settled(runId, status = "completed") {
    return until(
      () => this.detail(runId),
      (value) => value.run?.status === status,
      `run ${status}`
    )
  }

  release(runId) {
    this.released.add(runId)
    for (const response of this.barriers.get(runId) ?? []) response.end("released")
  }

  async stop(signal = "SIGTERM") {
    const entry = this.current
    if (!entry || entry.exited || !Number.isInteger(entry.child.pid)) return
    try {
      if (process.platform === "win32") entry.child.kill(signal)
      else process.kill(-entry.child.pid, signal)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
    await Promise.race([entry.done, pause(2000)])
    if (!entry.exited) {
      if (process.platform === "win32") entry.child.kill("SIGKILL")
      else {
        try {
          process.kill(-entry.child.pid, "SIGKILL")
        } catch (error) {
          if (error.code !== "ESRCH") throw error
        }
      }
    }
    await entry.done
  }

  async restart() {
    await this.stop("SIGKILL")
    await this.start()
  }

  evidence() {
    const redact = (text) =>
      text
        .replaceAll(this.token ?? "__unset__", "[service-token]")
        .replaceAll(this.env?.COGNIA_MASTER_KEY ?? "__unset__", "[master-key]")
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    return {
      boundary: "real Rust Host + production Brain + disk plugin + SQLite; loopback effects",
      artifacts: this.hashes,
      build: this.build
        ? {
            preparedAt: this.build.preparedAt,
            revision: this.build.revision,
            hostBuiltFromSource: this.build.hostBuiltFromSource,
            inputDigest: this.build.inputDigest,
            outputDigest: this.build.outputDigest,
          }
        : undefined,
      processes: this.processes.map((entry) => ({ pid: entry.child.pid, log: redact(entry.log) })),
      pluginDiagnostics: this.pluginDiagnostics,
      calls: this.calls,
      effects: this.effects,
    }
  }

  async close() {
    try {
      await this.stop()
    } finally {
      this.agent.destroy()
      if (this.recorder) {
        this.recorder.closeAllConnections()
        await new Promise((resolve) => this.recorder.close(resolve))
      }
      if (this.directory) await fs.rm(this.directory, { recursive: true, force: true })
    }
  }
}
