#!/usr/bin/env node
// Exercise the shipped non-TUI CLI against an isolated, real loopback Host.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const USAGE = `usage: pnpm cli:test:api:host -- [--server <binary>] [--cli <bundle>] [--timeout <seconds>]

Starts a real Host on loopback with private temporary data and synthetic keys.
Requires existing cognia-server and JavaScript CLI builds; no model or relay service is contacted.
Defaults: target/debug/cognia-server, cli/dist/cognia-agent.mjs, 60 seconds per process.`

export function parseArgs(argv) {
  const options = {
    server: path.join(ROOT, "target/debug/cognia-server"),
    cli: path.join(ROOT, "cli/dist/cognia-agent.mjs"),
    timeout: 60,
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === "--") continue
    if (flag === "--help" || flag === "-h") return { help: true }
    if (!["--server", "--cli", "--timeout"].includes(flag))
      throw new Error("unknown option; see --help")
    const value = argv[++index]
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`)
    options[flag.slice(2)] = flag === "--timeout" ? Number(value) : path.resolve(value)
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 1 || options.timeout > 300)
    throw new Error("--timeout must be 1..300 seconds")
  return options
}

/** Do not forward provider credentials, user config, proxies or real Host profiles. */
export function isolatedEnvironment(directory, inherited = process.env) {
  return {
    ...(inherited.PATH ? { PATH: inherited.PATH } : {}),
    ...(process.platform === "win32" && inherited.SystemRoot
      ? { SystemRoot: inherited.SystemRoot }
      : {}),
    NODE_ENV: "production",
    COGNIA_HOME: path.join(directory, "cli-home"),
    COGNIA_DATA_DIR: path.join(directory, "host-data"),
    COGNIA_MASTER_KEY: randomBytes(32).toString("hex"),
    COGNIA_EXECUTION: "disabled",
    COGNIA_SIGNALING_URL: "ws://127.0.0.1:1/signaling",
    COGNIA_SIDECAR_SCRIPT: path.join(directory, "no-model-sidecar.mjs"),
  }
}

/** Capture privately; even failure messages must not print tokens/invitations. */
export function managedProcess(command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = "",
    timedOut = false
  const signal = (name) => {
    try {
      if (process.platform === "win32") child.kill(name)
      else if (child.pid) process.kill(-child.pid, name)
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }
  const result = new Promise((resolve) => {
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-1024 * 1024)
    })
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-1024 * 1024)
    })
    child.once("error", () => resolve({ code: null, stdout, stderr, spawnError: true, timedOut }))
    child.once("close", (code) => resolve({ code, stdout, stderr, timedOut }))
  })
  const stop = async () => {
    signal("SIGTERM")
    await Promise.race([result, delay(options.stopGraceMs ?? 2000)])
    signal("SIGKILL")
    await result
  }
  const timer = setTimeout(() => {
    timedOut = true
    void stop()
  }, options.timeoutMs)
  void result.then(() => clearTimeout(timer))
  return { result, stop, exited: () => child.exitCode !== null || child.signalCode !== null }
}

async function unusedPort() {
  const listener = net.createServer()
  await new Promise((resolve, reject) => {
    listener.once("error", reject)
    listener.listen(0, "127.0.0.1", resolve)
  })
  const port = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  return port
}

async function healthy(port) {
  return new Promise((resolve) => {
    // Only the initial loopback liveness probe accepts the self-signed cert.
    // All CLI API/event traffic below must use the invitation's TLS pin.
    const request = https.get(
      { hostname: "127.0.0.1", port, path: "/healthz", rejectUnauthorized: false, timeout: 500 },
      (response) => {
        response.resume()
        resolve(response.statusCode === 200)
      }
    )
    request.once("error", () => resolve(false))
    request.once("timeout", () => {
      request.destroy()
      resolve(false)
    })
  })
}

export async function runHostSmoke(options, signal) {
  for (const file of [options.server, options.cli])
    if (!fs.existsSync(file)) throw new Error("build the Host and JavaScript CLI first; see --help")
  const parent = path.join(ROOT, ".cache/diagnostics/cli-api-host")
  fs.mkdirSync(parent, { recursive: true })
  const directory = fs.mkdtempSync(path.join(parent, "run-"))
  const children = new Set()
  const aborted = () => {
    for (const child of children) void child.stop()
  }
  try {
    fs.chmodSync(directory, 0o700)
    const env = isolatedEnvironment(directory)
    const signalingDirectory = path.join(env.COGNIA_DATA_DIR, "cognia")
    fs.mkdirSync(signalingDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(signalingDirectory, "signaling.json"),
      JSON.stringify({
        enabled: false,
        signalingUrl: env.COGNIA_SIGNALING_URL,
        iceServers: [],
        turnServers: [],
      }),
      { mode: 0o600 }
    )
    const start = (command, args) => {
      signal?.throwIfAborted()
      const child = managedProcess(command, args, {
        cwd: directory,
        env,
        timeoutMs: options.timeout * 1000,
      })
      children.add(child)
      return child
    }
    const checked = async (command, args, label) => {
      const child = start(command, args)
      const result = await child.result
      if (result.code !== 0 || result.timedOut) {
        let diagnosis = ""
        try {
          const failure = JSON.parse(result.stderr.trim().split("\n").at(-1))
          const fields = [failure.cause, failure.diagnostics?.code].filter(
            (value) => typeof value === "string" && /^[a-z0-9_ .:-]{1,160}$/i.test(value)
          )
          diagnosis = fields.length ? ` (${fields.join(", ")})` : ""
        } catch {
          /* Child output can be text; never echo it wholesale. */
        }
        throw new Error(
          `${label} failed (exit ${result.code}, timeout ${result.timedOut})${diagnosis}; raw output withheld because it can contain credentials`
        )
      }
      return result.stdout
    }
    const cli = async (args, label) =>
      JSON.parse(await checked(process.execPath, [options.cli, ...args, "--json"], label))
    signal?.addEventListener("abort", aborted, { once: true })
    const port = await unusedPort()
    const endpoint = `https://127.0.0.1:${port}`
    const server = start(options.server, [
      "serve",
      "--port",
      String(port),
      "--bind-loopback",
      "--no-mdns",
    ])
    const deadline = Date.now() + Math.min(options.timeout * 1000, 20000)
    while (!(await healthy(port))) {
      signal?.throwIfAborted()
      if (server.exited() || Date.now() >= deadline)
        throw new Error(
          "isolated Host did not become healthy; build current sources and check local prerequisites"
        )
      await delay(100)
    }
    const invitationOutput = await checked(
      options.server,
      ["pair", "--port", String(port), "--direct", "--json"],
      "pair invitation"
    )
    const invitation = JSON.parse(invitationOutput).invitation
    assert.match(
      invitation,
      /^cgnp3\|[A-Za-z0-9_-]+$/,
      "loopback Host must issue a direct invitation"
    )
    const payload = JSON.parse(Buffer.from(invitation.split("|")[1], "base64url").toString("utf8"))
    assert.equal(payload.base, endpoint)
    assert.match(payload.fp, /^[a-f0-9]{64}$/i)
    await cli(["host", "login", "paired", "--invitation", invitation, "--use"], "device login")
    const token = (await checked(options.server, ["issue-service-token"], "service token")).trim()
    await cli(
      [
        "host",
        "add",
        "service",
        "--endpoint",
        endpoint,
        "--kind",
        "headless",
        "--token",
        token,
        "--fingerprint",
        payload.fp,
      ],
      "service profile"
    )
    const capabilities = await cli(
      [
        "api",
        "call",
        "companion_server_status",
        "--profile",
        "paired",
        "--live",
        "--strict-output",
      ],
      "paired DPoP RPC"
    )
    assert.ok(capabilities && typeof capabilities === "object")
    const catalog = await cli(
      ["api", "list", "--live", "--wire", "http", "--profile", "paired"],
      "authenticated discovery"
    )
    assert.ok(
      Array.isArray(catalog) &&
        catalog.some((command) => command.command === "companion_server_status"),
      "authenticated catalog must include the paired native RPC"
    )
    const cursorFile = path.join(directory, "cursor.json")
    const publish = () =>
      cli(
        ["api", "call", "fleet_project_worker_load", "--loads", "[]", "--profile", "service"],
        "event projection"
      )
    const consume = async (extra) =>
      JSON.parse(
        (
          await checked(
            process.execPath,
            [
              options.cli,
              "api",
              "events",
              "--profile",
              "paired",
              "--channels",
              "fleet://update",
              "--max-events",
              "1",
              "--cursor-file",
              cursorFile,
              ...extra,
            ],
            "device event replay"
          )
        ).trim()
      )
    await publish()
    const first = await consume(["--since", "0"])
    assert.equal(first.type, "fleet://update")
    await publish()
    const second = await consume([])
    assert.ok(second.seq > first.seq, "cursor persistence must skip previously delivered events")
    assert.equal(JSON.parse(fs.readFileSync(cursorFile, "utf8")).seq, second.seq)
    const file = path.join(directory, "health.bin")
    await checked(
      process.execPath,
      [
        options.cli,
        "api",
        "request",
        "GET",
        "/healthz",
        "--profile",
        "service",
        "--response",
        "stream",
        "--save",
        file,
      ],
      "pinned stream save"
    )
    assert.ok(JSON.parse(fs.readFileSync(file, "utf8")))
    const watch = start(process.execPath, [
      options.cli,
      "api",
      "events",
      "--profile",
      "paired",
      "--channels",
      "fleet://update",
      "--total-timeout",
      "100ms",
      "--json",
    ])
    const cancelled = await watch.result
    assert.notEqual(cancelled.code, 0)
    assert.equal(JSON.parse(cancelled.stderr.trim().split("\n").at(-1)).cause, "timeout")
    return {
      passed: 6,
      cases: [
        "paired DPoP RPC",
        "authenticated live catalog",
        "replay",
        "persisted cursor",
        "pinned stream save",
        "event total cancellation",
      ],
    }
  } finally {
    signal?.removeEventListener("abort", aborted)
    await Promise.allSettled([...children].map((child) => child.stop()))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController()
  let interrupted
  const interrupt = (name) => {
    interrupted = name
    controller.abort(new Error("Host smoke interrupted"))
  }
  const onInt = () => interrupt("SIGINT")
  const onTerm = () => interrupt("SIGTERM")
  process.once("SIGINT", onInt)
  process.once("SIGTERM", onTerm)
  try {
    const options = parseArgs(process.argv.slice(2))
    console.log(
      options.help ? USAGE : JSON.stringify(await runHostSmoke(options, controller.signal))
    )
  } catch (error) {
    console.error(error.message)
    process.exitCode = interrupted === "SIGINT" ? 130 : interrupted === "SIGTERM" ? 143 : 1
  } finally {
    process.removeListener("SIGINT", onInt)
    process.removeListener("SIGTERM", onTerm)
  }
}
