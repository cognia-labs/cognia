// Read-only audit probes. Load the real TypeScript modules with mocked I/O;
// never execute project scripts, access credentials or create provider resources.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const ts = createRequire(path.join(root, "package.json"))("typescript")
class BootstrapAgentValidationError extends Error {}
function harness() {
  const calls = []
  const records = []
  const files = { "pnpm-lock.yaml": "v1" }
  let host = "host-a"
  let stored
  let native = async () => ({ stdout: "", stderr: "", exit_code: 0, timed_out: false })
  const mocks = {
    "@/lib/execution/personal-egress": {
      runPersonalEgressOperation: (_context, operation) => operation(),
      PersonalEgressDeniedError: class extends Error {},
    },
    "./bootstrap-agent": { assertBootstrapEnvironment() {}, BootstrapAgentValidationError },
    "./bootstrap-prompts": {},
    "@/lib/tauri": {
      isTauri: () => true,
      transport: {
        call: async (name, payload) => {
          calls.push({ name, payload, host })
          return native()
        },
      },
    },
    "@/lib/task-workspace/execution-port-lease": { ensureExecutionPortLease: async () => null },
    "@/lib/data/crypto": {
      sha256Hex: async (text) => createHash("sha256").update(text).digest("hex"),
    },
    "@/lib/files/workspace-fs": {
      readWorkspaceFile: async (_root, file) => {
        if (!(file in files)) throw new Error("absent")
        return files[file]
      },
      statWorkspaceFile: async (_root, file) => ({
        exists: file === "node_modules" || file in files,
      }),
    },
    "@/lib/db/project-environments": {
      updateProjectEnvironmentInitialization: async (_id, record) => {
        records.push(record)
      },
      getProjectEnvironment: async () => stored,
    },
    "@/lib/workspace/mise-step": { planMiseStep: async () => ({ step: null, notices: [] }) },
  }
  function load(relative) {
    const file = path.join(root, relative)
    const source = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const moduleRecord = { exports: {} }
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: file })(
      (name) => {
        if (name in mocks) return mocks[name]
        throw new Error(`Unmocked audit dependency: ${name}`)
      },
      moduleRecord,
      moduleRecord.exports
    )
    return moduleRecord.exports
  }
  const reuse = load("lib/project-environment/setup-reuse.ts")
  mocks["./setup-reuse"] = reuse
  const executor = load("lib/project-environment/executor.ts")
  const environment = {
    id: "env",
    projectId: "project",
    name: "Audit",
    isEnabled: true,
    setupScript: { default: "install" },
    actions: [],
    variables: {},
    keyringReferences: [],
    setupReuse: { enabled: true, inputs: ["pnpm-lock.yaml"], outputs: ["node_modules"] },
    runtime: {
      source: { kind: "catalog", catalogEntryId: "python" },
      target: { kind: "provider", providerId: "cloud" },
      updatedAt: 1,
    },
    createdAt: 1,
    updatedAt: 1,
  }
  const input = { environment, executionRoot: "/audit", scope: "local", surface: "interactive" }
  return {
    ...executor,
    reuse,
    environment,
    input,
    calls,
    records,
    files,
    setHost: (next) => {
      host = next
    },
    setNative: (fn) => {
      native = fn
    },
    setStored: (value) => {
      stored = value
    },
  }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Audit probe did not reach its execution boundary")
    await tick()
  }
}

async function main() {
  const results = []
  {
    const h = harness()
    await h.executeProjectEnvironment(h.input)
    assert.equal(h.calls[0].name, "project_environment_execute")
    assert.equal(h.calls[0].payload.runtime, undefined)
    assert.equal(h.calls[0].payload.sandbox, undefined)
    results.push({
      case: "setup-does-not-carry-selected-runtime",
      reproduced: true,
      command: h.calls[0].name,
    })
  }
  {
    const h = harness()
    let finish
    h.setNative(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const first = h.executeProjectEnvironment(h.input)
    await until(() => finish)
    h.files["pnpm-lock.yaml"] = "v2"
    const second = h.executeProjectEnvironment(h.input)
    await tick()
    finish({ stdout: "", stderr: "", exit_code: 0, timed_out: false })
    await first
    const outcome = await second
    assert.equal(outcome.joined, true)
    assert.equal(h.calls.length, 1)
    results.push({
      case: "changed-lockfile-joins-old-setup",
      reproduced: true,
      transportCalls: h.calls.length,
      secondOutcome: outcome,
    })
    const previous = h.records.find((record) => record.status === "succeeded")
    h.setStored({ ...h.environment, initializationHistory: [previous] })
    h.setNative(async () => ({ stdout: "", stderr: "", exit_code: 0, timed_out: false }))
    const third = await h.executeProjectEnvironment(h.input)
    assert.equal(third.reused, undefined)
    assert.equal(h.calls.length, 2)
    results.push({
      case: "later-request-detects-new-lockfile",
      protectiveBehavior: true,
      transportCalls: h.calls.length,
    })
  }
  {
    const h = harness()
    const finishes = []
    h.setNative(() => new Promise((resolve) => finishes.push(resolve)))
    const first = h.executeProjectEnvironment(h.input)
    await until(() => finishes.length > 0)
    const second = h.executeProjectEnvironment({
      ...h.input,
      environment: { ...h.environment, id: "other" },
    })
    await tick()
    assert.equal(finishes.length, 2)
    for (const finish of finishes)
      finish({ stdout: "", stderr: "", exit_code: 0, timed_out: false })
    await Promise.all([first, second])
    results.push({
      case: "same-root-different-profile-runs-concurrently",
      reproduced: true,
      concurrentTransportCalls: finishes.length,
    })
  }
  {
    const h = harness()
    await h.executeProjectEnvironment(h.input)
    const success = h.records.find((record) => record.status === "succeeded")
    const stored = {
      ...h.environment,
      initializationHistory: [success],
      lastInitialization: {
        status: "running",
        scope: "local",
        executionRoot: "/audit",
        startedAt: success.completedAt + 1,
      },
    }
    h.setStored(stored)
    const outcome = await h.executeProjectEnvironment(h.input)
    assert.equal(outcome.reused, true)
    assert.equal(h.calls.length, 1)
    results.push({
      case: "unfinished-setup-does-not-invalidate-older-success",
      reproduced: true,
      nextOutcome: outcome,
    })
  }
  {
    const h = harness()
    const finishes = []
    h.setNative(() => new Promise((resolve) => finishes.push(resolve)))
    const first = h.executeProjectEnvironment(h.input)
    await until(() => finishes.length === 1)
    h.files["pnpm-lock.yaml"] = "v2"
    const second = h.executeProjectEnvironment({ ...h.input, force: true })
    await tick()
    assert.equal(finishes.length, 1)
    finishes[0]({ stdout: "", stderr: "", exit_code: 0, timed_out: false })
    await first
    await until(() => finishes.length === 2)
    finishes[1]({ stdout: "", stderr: "", exit_code: 0, timed_out: false })
    const outcome = await second
    assert.equal(outcome.joined, undefined)
    const successes = h.records.filter((record) => record.status === "succeeded")
    assert.notEqual(successes[0].fingerprint, successes[1].fingerprint)
    results.push({
      case: "forced-request-waits-then-runs-fresh",
      protectiveBehavior: true,
      transportCalls: h.calls.length,
    })
  }
  {
    const h = harness()
    await h.executeProjectEnvironment(h.input)
    const previous = h.records.find((record) => record.status === "succeeded")
    h.setStored({ ...h.environment, initializationHistory: [previous] })
    h.setHost("host-b")
    const outcome = await h.executeProjectEnvironment(h.input)
    assert.equal(outcome.reused, true)
    assert.equal(h.calls.filter((call) => call.host === "host-b").length, 0)
    results.push({
      case: "host-a-history-reused-under-host-b-context",
      reproduced: true,
      scope: "simulated Host routing context, identical synthetic input/output paths",
      nextOutcome: outcome,
    })
  }
  console.log(
    JSON.stringify(
      { scope: "real executor/setup-reuse with mocked I/O; no real provider", results },
      null,
      2
    )
  )
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
