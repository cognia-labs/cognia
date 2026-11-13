import test from "node:test"
import assert from "node:assert/strict"
import { fencePersonalEgress, personalEgressState, personalToolDenied } from "./personal-egress.ts"

test("a Host fence reaches routed-agent overlays and cannot be cleared", () => {
  const canonical = { personalEgressFenced: false }
  personalEgressState(canonical)
  const routed = { ...canonical, allowedTools: ["Bash"] }
  assert.equal(personalToolDenied("Bash", routed), false)
  fencePersonalEgress(canonical)
  for (const name of [
    "Bash",
    "WebFetch",
    "mcp__third__read",
    "mcp__third__web_search",
    "start_process",
    "shell_execute_advanced",
    "terminal_dock_write",
  ])
    assert.equal(personalToolDenied(name, routed), true, name)
  canonical.personalEgressFenced = false
  assert.equal(personalToolDenied("Bash", canonical), true)
  assert.equal(personalToolDenied("WebSearch", routed, ["WebSearch"]), false)
  assert.equal(personalToolDenied("mcp__cognia-plugin-tools__web_search", routed), false)
})

test("a tainted start is fenced and only explicit Host read declarations are allowed", () => {
  const policy = {
    personalEgressFenced: true,
    personalEgressReadTools: ["mcp__cognia-tools__read"],
  }
  assert.equal(personalToolDenied("Bash", policy), true)
  assert.equal(personalToolDenied("mcp__cognia-tools__read", policy), false)
  assert.equal(personalToolDenied("mcp__third__read", policy), true)
})

test("G3: fence quiescence waits for active egress and refuses unproved processes", async () => {
  const { beginPersonalEgressOperation, quiescePersonalEgress } =
    await import("./personal-egress.ts")
  const policy = { personalEgressFenced: false }
  const finish = beginPersonalEgressOperation(policy)
  fencePersonalEgress(policy)
  let settled = false
  const waiting = quiescePersonalEgress(policy).then(() => {
    settled = true
  })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.throws(() => beginPersonalEgressOperation(policy), /fenced/)
  finish()
  await waiting
  assert.equal(settled, true)
  const processPolicy = { personalEgressFenced: false }
  const finishProcess = beginPersonalEgressOperation(processPolicy, true)
  fencePersonalEgress(processPolicy)
  await assert.rejects(quiescePersonalEgress(processPolicy), /did not settle/)
  finishProcess()
  await quiescePersonalEgress(processPolicy)
})

test("G3: a timeout does not count as completion", async () => {
  const { beginPersonalEgressOperation, quiescePersonalEgress } =
    await import("./personal-egress.ts")
  const policy = {}
  const finish = beginPersonalEgressOperation(policy)
  fencePersonalEgress(policy)
  try {
    await assert.rejects(quiescePersonalEgress(policy), /did not settle/)
  } finally {
    finish()
  }
  await quiescePersonalEgress(policy)
})

test("H3: self tool is excluded while a sibling operation still blocks the ACK", async () => {
  const { beginPersonalEgressOperation, quiescePersonalEgress } =
    await import("./personal-egress.ts")
  const policy = {}
  const self = beginPersonalEgressOperation(policy, false, "marking-tool")
  const sibling = beginPersonalEgressOperation(policy, false, "sibling-shell")
  fencePersonalEgress(policy)
  let admitted = false
  const pending = quiescePersonalEgress(policy, ["marking-tool"]).then(() => {
    admitted = true
  })
  await Promise.resolve()
  assert.equal(admitted, false)
  sibling()
  await pending
  assert.equal(admitted, true)
  self()
})

test("H1: a user-shadowed Host namespace cannot inherit search or read ownership", async () => {
  const { bindPersonalEgressHostTools } = await import("./personal-egress.ts")
  const policy = {
    personalEgressFenced: true,
    personalEgressReadTools: ["mcp__cognia-tools__read"],
    mcpServers: { "cognia-tools": {}, "cognia-plugin-tools": {} },
  }
  assert.equal(personalToolDenied("mcp__cognia-plugin-tools__web_search", policy), true)
  assert.equal(personalToolDenied("mcp__cognia-tools__read", policy), true)
  bindPersonalEgressHostTools(policy, [])
  assert.equal(personalToolDenied("mcp__cognia-plugin-tools__web_search", policy), true)
  bindPersonalEgressHostTools(policy, ["mcp__cognia-tools__read"])
  assert.equal(personalToolDenied("mcp__cognia-tools__read", policy), false)
})

test("R6: a finished native command does not leave permanent unproven state", async () => {
  const { beginPersonalEgressOperation, quiescePersonalEgress, releasePersonalEgressOperations } =
    await import("./personal-egress.ts")
  const policy = {}
  const finish = beginPersonalEgressOperation(policy, true, "finished-bash")
  finish()
  fencePersonalEgress(policy)
  await quiescePersonalEgress(policy)
  const another = {}
  beginPersonalEgressOperation(another, true, "denied")
  releasePersonalEgressOperations(another, "denied")
  fencePersonalEgress(another)
  await quiescePersonalEgress(another)
})
