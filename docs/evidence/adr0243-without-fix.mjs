/** Reversible, hash-checked behavioral mutations for the fix5/fix7 real-reader pins. */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"

const root = process.cwd()
const [name, runner] = process.argv.slice(2)
const cases = {
  R11projection: {
    source: "lib/plugin/core/personal-read-projection.ts",
    test: "lib/plugin/core/personal-read-projection.test.ts",
    pin: "R11 every ctx.agent runner member",
    mutate: (source) =>
      replace(
        source,
        '(namespace !== "agent" && !reads[namespace]?.includes(String(key)))',
        "!reads[namespace]?.includes(String(key))"
      ),
  },
  R11close: {
    source: "lib/terminal/headless-session-registry.ts",
    test: "lib/terminal/workflow-nodes/session.test.ts",
    pin: "R11 clean workflow close",
    mutate: (source) =>
      replace(
        source,
        'if (proof?.status === "exited") confirmHeadlessPersonalEgressExit(sessionId)',
        'if (proof?.status !== "exited") throw new Error("No child-wait proof")\n    confirmHeadlessPersonalEgressExit(sessionId)'
      ),
  },
  R11controller: {
    source: "hooks/chat/agent-chat-external-turn.ts",
    test: "hooks/chat/use-agent-chat.test.ts",
    pin: "R11 controller external entry",
    mutate: (source) =>
      replace(
        source,
        ": await executePersonalExternalTurn(",
        ": await ((execute, prompt, options) => execute(prompt, options))("
      ),
  },
  R11sticky: {
    source: "lib/sandbox/session-runtime.ts",
    test: "lib/sandbox/session-runtime.test.ts",
    pin: "R11 unknown refusal",
    mutate: (source) =>
      replace(
        source,
        "if (exposed) this.rememberNetworkOff(record)",
        "if (fenced) this.rememberNetworkOff(record)"
      ),
  },
  R11history: {
    source: "lib/execution/personal-egress.ts",
    test: "lib/execution/personal-egress.test.ts",
    pin: "R11 deleted branch parents",
    mutate: (source) =>
      replace(
        source,
        "((identified || derived) && !taint.verified)",
        "(identified && !taint.verified)"
      ),
  },
  R11synchronous: {
    source: "lib/plugin/core/invocation-identity.ts",
    test: "lib/plugin/core/invocation-identity.test.ts",
    pin: "R11 sync cold composite guard",
    mutate: (source) =>
      replace(source, "if (snapshot === undefined && synchronous)", "if (false && synchronous)"),
  },
  R10composite: {
    source: "lib/plugin/core/invocation-identity.ts",
    test: "lib/plugin/core/invocation-identity.test.ts",
    pin: "R10 cold composites",
    mutate: (source) =>
      replace(source, "if (composite) return proof.then(deliver)", "void composite"),
  },
  R10exposure: {
    source: "lib/execution/personal-egress.ts",
    test: "lib/execution/personal-egress.test.ts",
    pin: "R10 dispatch snapshots",
    mutate: (source) =>
      replace(
        source,
        "cachedContentExposure(context as PersonalEgressContext)",
        "personalEgressCachedFenced(context as PersonalEgressContext)"
      ),
  },
  R10race: {
    source: "lib/execution/personal-egress.ts",
    test: "lib/execution/personal-egress.test.ts",
    pin: "R10 composite exposure rereads",
    mutate: (source) =>
      replace(
        source,
        "scope === current.scope &&\n      ![...dependencies].some((id) => (cache.changedAt.get(id) ?? 0) > revision)",
        "true"
      ),
  },
  R10facade: {
    source: "hooks/agent/use-external-agent.ts",
    test: "hooks/agent/use-external-agent.test.ts",
    pin: "R10 production getter",
    mutate: (source) =>
      replace(
        source,
        "getAgentTools(targetAgentId, undefined, personalSource)",
        "getAgentTools(targetAgentId)"
      ),
  },
  R10runner: {
    source: "lib/headless/person-agent/runner.ts",
    test: "lib/headless/person-agent/runner.test.ts",
    pin: "R10 .*runner",
    mutate: (source) =>
      replace(
        source,
        "executionRunId: hostStateRunId(request.actionId)",
        "executionRunId: undefined"
      ),
  },
  R10chat: {
    source: "hooks/chat/agent-chat-turn-helpers.ts",
    test: "hooks/chat/agent-chat-turn-helpers.test.ts",
    pin: "R10 external chat dispatch",
    mutate: (source) =>
      replace(
        source,
        "return execute(prompt, bindPersonalEgressOptions(options, source))",
        "return execute(prompt, options)"
      ),
  },
  R10candidate: {
    source: "lib/best-of-n/external.ts",
    test: "lib/best-of-n/external.test.ts",
    pin: "R10 binds the candidate",
    mutate: (source) => replace(source, "input.personalContext ?? {}", "{}"),
  },
  R10runtime: {
    source: "lib/best-of-n/runtime.ts",
    test: "lib/best-of-n/runtime.test.ts",
    pin: "runs an external candidate in its own workspace root",
    mutate: (source) =>
      replace(
        source,
        "personalContext: { executionRunId: candidateRunId }",
        "personalContext: { executionRunId: undefined }"
      ),
  },
  Q1: {
    source: "lib/plugin/core/personal-read-projection.ts",
    test: "lib/plugin/core/personal-read-projection.test.ts",
    pin: "Q1 clean metadata",
    mutate: (source) =>
      replace(source, "if (!runId) return value", "if (!runId) return withheld(value)"),
  },
  Q2: {
    source: "lib/sandbox/session-runtime.ts",
    test: "lib/sandbox/session-runtime.test.ts",
    pin: "Q2 clean consecutive turns",
    mutate: (source) =>
      replace(
        source,
        "return JSON.stringify({\n    binding: input.binding,",
        "return JSON.stringify({\n    executionRunId: input.executionRunId,\n    binding: input.binding,"
      ),
  },
  Q3: {
    source: "lib/headless/person-agent/runner.ts",
    test: "lib/ai/agent/external/manager.test.ts",
    pin: "Q3 person-agent replay",
    mutate: (source) =>
      replace(
        source,
        "executionRunId: hostStateRunId(request.actionId)",
        "executionRunId: undefined"
      ),
  },
  Q4: {
    source: "lib/plugin/core/invocation-identity.ts",
    test: "lib/plugin/core/invocation-identity.test.ts",
    pin: "Q4 cold clean dispatch",
    mutate: (source) => replace(source, "if (snapshot === true)", "if (snapshot !== false)"),
  },
  Q5: {
    source: "lib/terminal/headless-exec.ts",
    test: "lib/terminal/headless-exec.test.ts",
    pin: "Q5 timeout or abnormal",
    mutate: (source) =>
      replace(
        source,
        "retainHeadlessPersonalEgress(input.credentialContext ?? {}, result.pendingSessionId)",
        "void result.pendingSessionId"
      ),
  },
  P1: {
    source: "lib/plugin/core/personal-read-projection.ts",
    test: "lib/plugin/core/personal-read-projection.test.ts",
    pin: "P1 session reads and subscriptions",
    mutate: (source) =>
      replace(
        source,
        "  const wrap = (target: object, namespace: string): object =>",
        "  return context;\n  const wrap = (target: object, namespace: string): object =>"
      ),
  },
  P2: {
    source: "lib/execution/personal-egress.ts",
    test: "lib/execution/personal-egress.test.ts",
    pin: "P2 run-less operations and sessions",
    mutate: (source) => replace(source, "if (!id) return false", "if (!id) return true"),
  },
  P3: {
    source: "lib/plugin/core/invocation-identity.ts",
    test: "lib/plugin/core/invocation-identity.test.ts",
    pin: "P3 a clean delivery",
    mutate: (source) =>
      replace(
        source,
        "const instance = pluginExposure(pluginId)\n  const dispatch =",
        "const instance = pluginExposure(pluginId)\n  instance.sources.add(context)\n  const dispatch ="
      ),
  },
  P4: {
    source: "lib/terminal/personal-egress.ts",
    test: "lib/terminal/headless-session-registry.test.ts",
    pin: "F5 persistent headless lease survives",
    mutate: (source) =>
      replace(source, 'await closeRunSession(sessionId, "headless")', "void closeRunSession"),
  },
  P6: {
    source: "lib/terminal/headless-exec.ts",
    test: "lib/terminal/headless-exec.test.ts",
    pin: "P6 one-shot completion",
    mutate: (source) =>
      replace(
        source,
        'invoke<RustHeadlessResult>("terminal_headless_exec",',
        'invoke<RustHeadlessResult>("terminal_headless_run",'
      ),
  },
  P7: {
    source: "lib/sandbox/session-runtime.ts",
    test: "lib/sandbox/session-runtime.test.ts",
    pin: "P7 a tainted shared record",
    mutate: (source) =>
      replace(
        source,
        "this.personalNetworkOff.get(record.sessionId)?.has(this.networkBindingKey(record)) === true ||",
        "false ||"
      ),
  },
  P8a: {
    source: "sidecar/src/hooks/handlers/index.ts",
    test: "sidecar/src/hooks/handlers/index.test.ts",
    sidecar: true,
    mutate: (source) =>
      replace(
        source,
        'handlerPolicyClass(handler) !== "managed"',
        'outcome.personalEgressSkipped || handlerPolicyClass(handler) !== "managed"'
      ),
  },
  P8b: {
    source: "lib/execution/personal-egress.ts",
    test: "lib/execution/personal-egress.test.ts",
    pin: "P8b transient database",
    mutate: (source) =>
      replace(
        source,
        "  const scope = db ?? unavailableDatabase",
        "  if (!db) { sessions.clear(); activeOperations.clear(); unprovenProcessSources.clear() }\n  const scope = db ?? unavailableDatabase"
      ),
  },
  F7pythonReply: {
    source: "lib/plugin/core/manager.ts",
    test: "lib/plugin/core/manager.test.ts",
    pin: "F7 Python Host replies withhold content",
    mutate: (source) =>
      replace(
        source,
        "await runPersonalEgressOperation(source, async () => send(false))",
        "await send(false)"
      ),
  },
  F7vscodeReply: {
    source: "lib/plugin/vscode-shim/rpc-dispatcher.ts",
    test: "lib/plugin/vscode-shim/rpc-dispatcher.test.ts",
    pin: "F7 VSCode replies withhold newly admitted",
    mutate: (source) =>
      replace(
        source,
        "await runPersonalEgressOperation(source, async () =>\n      send(pluginId, generation, JSON.stringify(frame))\n    )",
        "await send(pluginId, generation, JSON.stringify(frame))"
      ),
  },
  F7headless: {
    source: "lib/terminal/headless-session-registry.ts",
    test: "lib/terminal/headless-session-registry.test.ts",
    pin: "F5 persistent headless lease survives a failed close until Host child-wait proves exit",
    mutate: (source) =>
      replace(
        source,
        'if (proof?.status !== "exited") throw new Error("Headless terminal exit is unconfirmed")',
        "void proof"
      ),
  },
  F7late: {
    source: "lib/terminal/headless-session-registry.ts",
    test: "lib/terminal/workflow-nodes/session.test.ts",
    pin: "F7 cancelled late spawn and explicit close retain the lease until child-wait proof",
    mutate: (source) =>
      replace(
        source,
        "  forgetOpen(open)\n  if (context) {",
        "  forgetOpen(open)\n  if (open.released) return false\n  if (context) {"
      ),
  },
  F7guard: {
    source: "lib/plugin/messaging/hooks-system.ts",
    test: "lib/plugin/messaging/hooks-system.test.ts",
    pin: "F7 native dispatch refusal after the hook precheck still denies PreToolUse",
    mutate: (source) =>
      replace(
        source,
        'error.code === "personal-egress-denied"',
        'error.code === "disabled-without-fix"'
      ),
  },
  F2: {
    source: "lib/plugin/core/invocation-identity.ts",
    test: "lib/plugin/core/context.test.ts",
    pin: "F2 deferred network, shell and sandbox retain real taint after hook release",
    mutate(source) {
      const start = source.indexOf("export function pluginEgressContextResolver(")
      const end = source.indexOf("export function pluginEgressContext(", start)
      if (start < 0 || end < 0) throw new Error("F2 mutation anchor missing")
      return (
        source.slice(0, start) +
        "export function pluginEgressContextResolver(pluginId: string): () => PersonalCredentialContext { return () => pluginExecutionContext(pluginId) ?? {} }\n" +
        source.slice(end)
      )
    },
  },
  F7: {
    source: "lib/sandbox/session-runtime.ts",
    test: "lib/sandbox/session-runtime.test.ts",
    pin: "P7 a tainted shared record",
    mutate: (source) =>
      replace(
        source,
        "this.personalNetworkOff.get(record.sessionId)?.has(this.networkBindingKey(record)) === true ||",
        "false ||"
      ),
  },
  F8: {
    source: "lib/plugin/api/browser-api.ts",
    test: "lib/plugin/api/browser-api.test.ts",
    pin: "F8 openPane stays boolean and defers navigation behind a real taint read",
    mutate: (source) => replace(source, "if (\n        url &&", "if (\n        false && url &&"),
  },
  F10: {
    source: "lib/claude/plugin-tool-ipc.ts",
    test: "lib/claude/plugin-tool-ipc.test.ts",
    pin: "F10 marked .* is denied and clean dispatch is unchanged",
    mutate: (source) =>
      replace(
        source,
        'moduleOwns\n        ? declared.declaration.effect === "read"\n        : Boolean(preferredOwner && hostLocalReads.has(request.name)),',
        "true,"
      ),
  },
  F5terminal: {
    source: "lib/terminal/personal-egress.ts",
    test: "lib/terminal/agent-tools.test.ts",
    pin: "F5 .*retains live PTY",
    mutate: (source) =>
      replace(
        source,
        "const release = trackPersonalEgressProcess(context, sessionId, () => {\n    observe()\n    return !confirmed\n  })",
        "const release = () => undefined"
      ),
  },
  F5consent: {
    source: "lib/terminal/personal-egress.ts",
    test: "lib/terminal/headless-exec.test.ts",
    pin: "F5 headless consent keeps a timed-out dock PTY leased until its exit",
    mutate: (source) =>
      replace(
        source,
        "const release = trackPersonalEgressProcess(context, sessionId, () => {\n    observe()\n    return !confirmed\n  })",
        "const release = () => undefined"
      ),
  },
}
function replace(source, before, after) {
  if (!source.includes(before) || source.indexOf(before) !== source.lastIndexOf(before))
    throw new Error("Mutation anchor missing or ambiguous")
  return source.replace(before, after)
}
const spec = cases[name]
if (!spec || !runner)
  throw new Error(
    "Usage: node docs/evidence/adr0243-without-fix.mjs <F2|F7|F8|F10|F5terminal|F5consent|F7headless|F7late|F7guard|F7pythonReply|F7vscodeReply> <jest-force runner>"
  )
const file = path.join(root, spec.source)
const original = fs.readFileSync(file, "utf8")
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex")
const beforeHash = hash(original)
const mutated = spec.mutate(original)
if (mutated === original) throw new Error("Mutation did not change source")
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adr0243-negative-"))
const list = path.join(dir, "tests.txt")
fs.writeFileSync(list, path.join(root, spec.test) + "\n")
fs.writeFileSync(path.join(dir, "source-backup"), original)
let result
try {
  if (hash(fs.readFileSync(file, "utf8")) !== beforeHash)
    throw new Error("Concurrent source change before mutation")
  fs.writeFileSync(file, mutated)
  result = spawnSync(
    process.execPath,
    spec.sidecar ? ["scripts/test/run-sidecar-tests.mjs", spec.test] : [runner, list, "run"],
    {
      cwd: root,
      env: {
        ...process.env,
        JEST_ROOT: root,
        JEST_NO_CACHE: "1",
        JEST_TNAME: spec.pin,
        SIDECAR_TEST_CONCURRENCY: "1",
      },
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    }
  )
} finally {
  if (fs.readFileSync(file, "utf8") !== mutated)
    throw new Error("Concurrent change: backup retained; refusing to overwrite another edit")
  fs.writeFileSync(file, original)
  if (hash(fs.readFileSync(file, "utf8")) !== beforeHash)
    throw new Error("Source restoration hash mismatch")
}
const output = (result.stdout ?? "") + (result.stderr ?? "")
const assertions =
  output.match(
    /(?:Received promise resolved instead of rejected|Expected[^\n]*|Received[^\n]*|Number of calls[^\n]*|Test Suites:[^\n]*|Tests:[^\n]*|SUITES [^\n]*)/g
  ) ?? []
console.log(
  JSON.stringify(
    { case: name, jestExitCode: result.status, restored: true, sourceHash: beforeHash, assertions },
    null,
    2
  )
)
// A behavioral assertion failure is expected; infrastructure errors are not proof.
const proved =
  result.status === 1 &&
  (spec.sidecar
    ? /AssertionError|ERR_ASSERTION/.test(output)
    : /expect\(received\)|expect\(jest\.fn\(\)\)/.test(output)) &&
  !/Test suite failed to run/.test(output)
if (!proved) {
  console.error(output.slice(-10000))
  process.exitCode = 1
}
fs.rmSync(dir, { recursive: true })
