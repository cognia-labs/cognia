import { nodeCmd } from "../../../test-support/hook-command.ts"
import assert from "node:assert/strict"
import { test } from "node:test"

import { fencePersonalEgress, personalEgressState } from "../../policy/personal-egress.ts"
import { applyFailurePolicy, runHandler } from "./index.ts"

test("unknown handlers have no opinion while malformed handlers report a warning", async () => {
  assert.deepEqual(await runHandler({ type: "future" }, "{}", undefined, undefined), {})
  assert.deepEqual(await runHandler(null, "{}", undefined, undefined), {
    warning: "invalid hook handler configuration",
  })
})

test("managed failure policy never replaces an explicit handler block", () => {
  const outcome = { block: "Policy denied", warning: "Transport warning" }
  assert.equal(applyFailurePolicy({ policyClass: "managed" }, outcome), outcome)
  assert.deepEqual(
    applyFailurePolicy({ policyClass: "managed" }, { warning: "Transport warning" }),
    {
      warning: "Transport warning",
      block: "Managed hook failed closed: Transport warning",
    }
  )
})

test("R4: fenced opaque lifecycle hooks are skipped without blocking Read, Stop or prompts", async () => {
  for (const handler of [
    { type: "command", command: "exit 99" },
    { type: "command", command: "exit 99", async: true },
    { type: "webhook", url: "https://example.invalid" },
    { type: "mcp_tool", server: "third", tool: "send" },
  ])
    assert.match(
      (
        await runHandler(handler, "private", undefined, undefined, {
          personalEgressFenced: () => true,
        })
      ).warning ?? "",
      /skipped/
    )
  let called = false
  await runHandler({ type: "agent", prompt: "review" }, "private", undefined, undefined, {
    personalEgressFenced: () => true,
    executeNativeHandler: async () => {
      called = true
      return {}
    },
  })
  assert.equal(called, true)
})

test("F4: matched fenced HTTP guard denies while lifecycle warns", async () => {
  const policy = {}
  fencePersonalEgress(policy)
  assert.equal(personalEgressState(policy).fenced, true)
  const guard = await runHandler(
    { type: "http", url: "https://example.invalid" },
    "{}",
    undefined,
    undefined,
    { eventName: "PreToolUse", personalEgressFenced: () => personalEgressState(policy).fenced }
  )
  assert.match(guard.block ?? "", /guard could not be consulted/)
  const stop = await runHandler(
    { type: "webhook", url: "https://example.invalid", policyClass: "managed" },
    "{}",
    undefined,
    undefined,
    { eventName: "Stop", personalEgressFenced: () => personalEgressState(policy).fenced }
  )
  assert.match(stop.warning ?? "", /skipped/)
  assert.match(applyFailurePolicy({ policyClass: "managed" }, stop).block ?? "", /failed closed/)
  assert.equal(applyFailurePolicy({ policyClass: "user" }, stop).block, undefined)
})

test("F4: command guard denies without the existing network-off launcher", async () => {
  const old = process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
  try {
    const result = await runHandler(
      { type: "command", command: "exit 0" },
      "{}",
      undefined,
      undefined,
      { eventName: "PreToolUse", personalEgressFenced: () => true }
    )
    assert.match(result.block ?? "", /guard could not be consulted/)
  } finally {
    if (old === undefined) delete process.env.COGNIA_CODE_SANDBOX_LAUNCHER
    else process.env.COGNIA_CODE_SANDBOX_LAUNCHER = old
  }
})

test("F5 detached command retains its operation until child exit", async () => {
  let finished!: () => void
  const exited = new Promise<void>((resolve) => {
    finished = resolve
  })
  let releases = 0
  await runHandler(
    { type: "command", command: nodeCmd("setTimeout(()=>{},100)"), async: true },
    "{}",
    undefined,
    undefined,
    {
      beginPersonalEgress: () => () => {
        releases++
        finished()
      },
    }
  )
  assert.equal(releases, 0)
  await exited
  assert.equal(releases, 1)
})
