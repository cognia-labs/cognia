/** Disposable macOS qualification; never drives an existing application. */
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { verifyAgentDesktopReceipt } from "../build/stage-agent-desktop-runtime.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const binary = path.resolve(option("--binary") ?? "")
const source = path.resolve(option("--source") ?? "")
const targetDir = path.resolve(option("--target-dir") ?? "")
assert(
  process.platform === "darwin" && process.arch === "arm64",
  "Only macOS arm64 is qualified here"
)
assert(
  args.includes("--binary") && args.includes("--source") && args.includes("--target-dir"),
  "Explicit candidate, source and target directory required"
)
const cache = path.join(root, ".cache/agent-desktop-p0")
fs.mkdirSync(cache, { recursive: true })
const directory = fs.mkdtempSync(path.join(cache, "native-"))
const fixtures = path.join(root, "integrations/agent-desktop/fixtures")
const environment = { ...process.env, AGENT_DESKTOP_HOME: path.join(directory, "private-state") }
delete environment.COGNIA_AUTOMATION_LEASE_FD
const report = { platform: `${process.platform}-${process.arch}`, candidate: binary, checks: {} }
const run = (program, parameters, options = {}) => {
  const result = spawnSync(program, parameters, {
    encoding: "utf8",
    env: environment,
    timeout: 60_000,
    ...options,
  })
  assert.equal(result.status, 0, `${program}: ${result.stderr || result.error || result.stdout}`)
  return result.stdout
}
const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error("Fixture deadline exceeded")
}
let app, host, executor
try {
  report.receipt = verifyAgentDesktopReceipt(binary, source, root)
  const version = JSON.parse(run(binary, ["version"]))
  assert.equal(version.data.cognia.profile, "cognia-bound-window-v1")
  assert.equal(version.data.cognia.legacyHostCleanup, false)
  report.checks.profile = version.data
  const permission = JSON.parse(run(binary, ["permissions"]))
  report.checks.permissions = permission.data
  assert.equal(
    permission.data.accessibility.state,
    "granted",
    "AX permission unavailable; no permission changes requested"
  )
  const rejected = spawnSync(binary, ["version"], {
    encoding: "utf8",
    env: { ...environment, COGNIA_AUTOMATION_LEASE_FD: "999999" },
  })
  assert.notEqual(rejected.status, 0)
  assert.equal(JSON.parse(rejected.stdout).ok, false)
  report.checks.invalidLeaseRejected = true
  for (const name of ["lease-host", "lease-probe"])
    run("clang", [
      "-Wall",
      "-Werror",
      path.join(fixtures, `${name}.c`),
      "-o",
      path.join(directory, name),
    ])
  const lease = path.join(directory, "executor.lock")
  host = spawn(path.join(directory, "lease-host"), [lease, binary], {
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  })
  let hostOutput = ""
  host.stdout.on("data", (bytes) => {
    hostOutput += bytes
  })
  await waitFor(() => /^\d+\n/.test(hostOutput))
  executor = Number(hostOutput.trim())
  await delay(250)
  process.kill(executor, 0)
  const hostExit = once(host, "exit")
  host.kill("SIGKILL")
  await hostExit
  assert.equal(
    spawnSync(path.join(directory, "lease-probe"), [lease]).status,
    1,
    "Successor acquired lease while orphaned executor was live"
  )
  process.kill(executor, "SIGKILL")
  await waitFor(() => spawnSync(path.join(directory, "lease-probe"), [lease]).status === 0)
  executor = undefined
  report.checks.hostDeathLease = "held after Host SIGKILL; available after executor SIGKILL"
  const bundle = path.join(directory, "CogniaP0Fixture.app/Contents")
  const bundleId = `dev.cognia.p0.${path.basename(directory).toLowerCase()}`
  fs.mkdirSync(path.join(bundle, "MacOS"), { recursive: true })
  fs.writeFileSync(
    path.join(bundle, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>CogniaP0Fixture</string><key>CFBundleExecutable</key><string>window-fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`
  )
  run("swiftc", [
    path.join(fixtures, "window-fixture.swift"),
    "-o",
    path.join(bundle, "MacOS/window-fixture"),
  ])
  app = spawn(path.join(bundle, "MacOS/window-fixture"), [directory], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  })
  await waitFor(() => fs.existsSync(path.join(directory, "state.json")))
  await delay(500)
  const fixtureState = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"))
  const snapshot = JSON.parse(
    run(binary, [
      "snapshot",
      "--app",
      bundleId,
      "--window-id",
      fixtureState.windows[0],
      "--max-depth",
      "6",
    ])
  )
  fs.writeFileSync(path.join(directory, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n")
  assert.equal(snapshot.ok, true)
  const nodes = []
  const collect = (node) => {
    nodes.push(node)
    for (const child of node.children ?? []) collect(child)
  }
  collect(snapshot.data.tree)
  const counter = nodes.find((node) => node.native_id?.value === "cognia-p0-counter")?.ref_id
  const field = nodes.find((node) => node.native_id?.value === "cognia-p0-field")?.ref_id
  assert(counter && field, "Candidate snapshot must publish qualified fixture refs")
  assert.equal(JSON.parse(run(binary, ["click", counter])).ok, true)
  const stateBeforeMove = JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8"))
  assert.deepEqual(stateBeforeMove.counts, [1, 0])
  fs.writeFileSync(
    path.join(directory, "command.json"),
    JSON.stringify({ sequence: stateBeforeMove.sequence + 1, action: "move" })
  )
  await waitFor(
    () => JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")).owner === 1
  )
  for (const parameters of [
    ["click", counter],
    ["set-value", field, "--stdin"],
  ]) {
    const refused = spawnSync(binary, parameters, {
      encoding: "utf8",
      env: environment,
      input: "fixture-stale-write",
      timeout: 10_000,
    })
    assert.notEqual(refused.status, 0)
    const envelope = JSON.parse(refused.stdout)
    assert.equal(envelope.error.disposition.delivery, "not_delivered")
    assert.match(envelope.error.message, /captured window/)
  }
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(directory, "state.json"), "utf8")).counts,
    [1, 0]
  )
  report.checks.candidateRefReparent =
    "CLI snapshot, positive click, reparent, stale click/set-value refused at final window guard"
  const native = spawn(
    "cargo",
    [
      "test",
      "--locked",
      "-p",
      "agent-desktop-macos",
      "--lib",
      "retained_object_reparent_is_rejected_at_each_native_write",
      "--",
      "--ignored",
      "--nocapture",
    ],
    {
      cwd: source,
      env: {
        ...environment,
        CARGO_TARGET_DIR: targetDir,
        CARGO_BUILD_JOBS: "4",
        COGNIA_AX_FIXTURE_DIR: directory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  let log = ""
  native.stdout.on("data", (bytes) => {
    log += bytes
  })
  native.stderr.on("data", (bytes) => {
    log += bytes
  })
  const [code] = await once(native, "exit")
  fs.writeFileSync(path.join(directory, "native-test.log"), log)
  assert.equal(code, 0, log)
  assert.match(log, /1 passed; 0 failed/)
  report.checks.retainedObjectReparent =
    "AXPress and AXValue refused; same-window positive controls delivered"
  report.checks.finalFixture = JSON.parse(
    fs.readFileSync(path.join(directory, "state.json"), "utf8")
  )
} catch (error) {
  report.failure = error.message
  process.exitCode = 1
} finally {
  if (executor) {
    try {
      process.kill(executor, "SIGKILL")
    } catch {}
  }
  if (host?.exitCode === null && host?.signalCode === null) host.kill("SIGKILL")
  if (app && app.exitCode === null && app.signalCode === null) {
    const exit = once(app, "exit")
    app.kill("SIGTERM")
    await Promise.race([exit, delay(2000)])
    if (app.exitCode === null && app.signalCode === null) app.kill("SIGKILL")
  }
  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(JSON.stringify({ directory, ...report }, null, 2))
}
