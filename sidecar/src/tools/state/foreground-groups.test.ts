import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"

import {
  disposeForegroundGroups,
  foregroundGroupIsLive,
  hasSessionForegroundGroups,
  hasSessionForegroundProcesses,
  retireForegroundGroups,
  signalForegroundGroup,
  trackForegroundGroup,
} from "./foreground-groups.ts"

const posix = process.platform !== "win32"

/** A detached child that outlives its call unless something stops it. */
function sleeper() {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    detached: posix,
    stdio: "ignore",
  })
}

function session(name: string) {
  return `fg-${name}-${process.pid}-${Date.now()}`
}

test("a tracked group is the session's until its teardown ends it", { skip: !posix }, async () => {
  const owner = session("dispose")
  const other = session("other")
  const child = sleeper()
  trackForegroundGroup(owner, child, true)
  assert.equal(hasSessionForegroundGroups(owner), true)
  assert.equal(hasSessionForegroundProcesses(owner), true)
  assert.equal(hasSessionForegroundGroups(other), false, "another session's groups are not touched")

  await disposeForegroundGroups(owner)
  assert.equal(hasSessionForegroundGroups(owner), false)
  assert.equal(foregroundGroupIsLive(child), false)
  assert.equal(retireForegroundGroups(owner), true, "the stop is proven")
})

test("signalling one group reaches it and nothing else", { skip: !posix }, async () => {
  const owner = session("signal")
  const target = sleeper()
  const bystander = sleeper()
  trackForegroundGroup(owner, target, true)
  trackForegroundGroup(owner, bystander, true)
  const exited = new Promise((resolve) => target.once("exit", resolve))
  signalForegroundGroup(target, "SIGKILL")
  await exited
  assert.equal(bystander.exitCode, null)
  await disposeForegroundGroups(owner)
  retireForegroundGroups(owner)
})

test("signalling an untracked child is a no-op", () => {
  const child = { pid: 1 } as Parameters<typeof signalForegroundGroup>[0]
  assert.doesNotThrow(() => signalForegroundGroup(child, "SIGKILL"))
  assert.equal(foregroundGroupIsLive(child), false)
})

// Windows (no Job Object) cannot prove a reaped leader's tree is empty, so a
// session that ran a group there never reports its stop as proven.
test("a session without group proof stays unconfirmed after retirement", async () => {
  const owner = session("no-proof")
  const child = sleeper()
  trackForegroundGroup(owner, child, false)
  assert.equal(hasSessionForegroundGroups(owner), true)
  await disposeForegroundGroups(owner).catch(() => undefined)
  assert.equal(retireForegroundGroups(owner), false)
  assert.equal(hasSessionForegroundGroups(owner), false)
  try {
    child.kill("SIGKILL")
  } catch {
    // already gone
  }
})
