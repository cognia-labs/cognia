import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"

import { createBgShellRegistry, MAX_RING_BYTES } from "./background-shells.ts"
import type {
  BackgroundJobSettlement,
  BgShellRegistry,
  ReadResult,
  SpawnBackgroundOptions,
} from "./background-shells.ts"

const isWin = process.platform === "win32"

function fixtureRegistry(t: TestContext, options?: Parameters<typeof createBgShellRegistry>[0]) {
  const registry = createBgShellRegistry(options)
  const children: ReturnType<BgShellRegistry["spawnBackground"]>[] = []
  const spawn = registry.spawnBackground.bind(registry)
  registry.spawnBackground = (options) => {
    const entry = spawn(options)
    children.push(entry)
    return entry
  }
  t.after(async () => {
    for (const { child, pid } of children) {
      // Only a still-owned leader authorizes the fixture group signal.
      if (pid && child.exitCode === null && child.signalCode === null && !isWin) {
        try {
          process.kill(-pid, "SIGKILL")
        } catch {
          /* already gone */
        }
      }
      child.kill("SIGKILL")
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
    await registry.killAll().catch(() => {})
  })
  return registry
}

test(
  "background leader exit loses signal authority and retains unconfirmed owner state",
  { skip: isWin },
  async (t) => {
    const registry = fixtureRegistry(t)
    const entry = registry.spawnBackground(inv("sleep 20 </dev/null >/dev/null 2>&1 & echo $!"))
    try {
      await waitExit(registry, entry.id)
      assert.equal(entry.status, "exited")
      assert.equal(registry.list()[0]?.status, "exited")
      assert.equal(registry.hasLiveProcesses?.(), true)
      await assert.rejects(registry.killAll(), /cleanup failed/)
      assert.deepEqual(registry.list(), [], "process-level entries retire")
      assert.equal(registry.hasLiveProcesses?.(), true, "owner retains unconfirmed result")
    } finally {
      const descendant = Number(entry.buffer.trim())
      if (descendant > 0) {
        try {
          process.kill(descendant, "SIGKILL")
        } catch {
          /* exited */
        }
      }
      await registry.killAll().catch(() => {})
    }
  }
)

type ReadOk = Extract<ReadResult, { ok: true }>

/** Narrow a read to its success branch. */
function expectOk(result: ReadResult): ReadOk {
  assert.ok(result.ok, "expected a successful read")
  return result
}

/** Build a shell invocation the same way bash.ts does. */
function inv(command: string): SpawnBackgroundOptions {
  const shell = isWin ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh"
  const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command]
  return { command, shell, shellArgs, cwd: os.tmpdir(), isWin }
}

/** Poll read() until the shell exits or the deadline passes. */
async function waitExit(reg: BgShellRegistry, id: string, timeoutMs = 10_000): Promise<ReadOk> {
  const deadline = Date.now() + timeoutMs
  let last: ReadOk = { ok: true, data: "", status: "running", exitCode: null }
  let acc = ""
  while (Date.now() < deadline) {
    const r = reg.read(id)
    if (r.ok) {
      acc += r.data
      last = r
      if (r.status === "exited") return { ...r, data: acc }
    }
    await new Promise((res) => setTimeout(res, 25))
  }
  return { ...last, data: acc }
}

async function waitStatusExit(reg: BgShellRegistry, id: string) {
  const deadline = Date.now() + 10_000
  while (reg.list().find((shell) => shell.id === id)?.status !== "exited" && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(reg.list().find((shell) => shell.id === id)?.status, "exited")
}

test("spawnBackground captures output and reports exit", async (t) => {
  const reg = fixtureRegistry(t)
  const entry = reg.spawnBackground(inv("echo bg-shell-ok"))
  assert.ok(entry.id)
  assert.equal(entry.pid, entry.child.pid)
  assert.equal(typeof entry.pid, "number")
  assert.equal(reg.killByPid(2147483647).matched, false)
  assert.equal(entry.status, "running")
  const r = await waitExit(reg, entry.id)
  assert.equal(r.status, "exited")
  assert.equal(r.exitCode, 0)
  assert.match(r.data, /bg-shell-ok/)
})

async function settlementOf(
  settled: BackgroundJobSettlement[],
  id: string,
  timeoutMs = 10_000
): Promise<BackgroundJobSettlement> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = settled.find((settlement) => settlement.jobId === id)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`shell ${id} never settled`)
}

// ADR-0249: an in-process shell (the CLI's) reports its end in the host
// supervisor's `JobExit` shape, with the conversation it reports into.
test("an ended shell is reported once with its exit code, tail and delivery", async (t) => {
  const settled: BackgroundJobSettlement[] = []
  const reg = fixtureRegistry(t, {
    delivery: { sessionId: "chat-1", runId: "execution:agent:r1" },
    onSettled: (settlement) => settled.push(settlement),
  })
  const entry = reg.spawnBackground({
    ...inv(isWin ? "echo settled-tail & exit 4" : "echo settled-tail; exit 4"),
    label: "build",
  })
  const settlement = await settlementOf(settled, entry.id)
  assert.equal(settlement.status, "exited")
  assert.equal(settlement.exitCode, 4)
  assert.equal(settlement.label, "build")
  assert.match(settlement.outputTail ?? "", /settled-tail/)
  assert.deepEqual(settlement.delivery, {
    sessionId: "chat-1",
    runId: "execution:agent:r1",
    notify: "on_exit",
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(settled.filter((candidate) => candidate.jobId === entry.id).length, 1)
})

test("a shell the agent killed reports that it stopped it", async (t) => {
  const settled: BackgroundJobSettlement[] = []
  const reg = fixtureRegistry(t, {
    delivery: { sessionId: "chat-1" },
    onSettled: (settlement) => settled.push(settlement),
  })
  const entry = reg.spawnBackground({
    ...inv(isWin ? "ping -n 30 127.0.0.1" : "sleep 30"),
    notify: "none",
  })
  reg.kill(entry.id)
  const settlement = await settlementOf(settled, entry.id)
  assert.equal(settlement.status, "killed")
  assert.equal(settlement.exitCode, null)
  assert.equal(settlement.delivery?.stoppedBy, "agent")
  assert.equal(settlement.delivery?.notify, "none")
})

test("a registry with no conversation reports nothing", async (t) => {
  const settled: BackgroundJobSettlement[] = []
  const reg = fixtureRegistry(t, { onSettled: (settlement) => settled.push(settlement) })
  const entry = reg.spawnBackground(inv("echo quiet"))
  await waitExit(reg, entry.id)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(settled, [])
})

test("read is a non-destructive incremental delta (cursor advances)", async (t) => {
  const reg = fixtureRegistry(t)
  const entry = reg.spawnBackground(inv("echo first-line"))
  await waitExit(reg, entry.id)
  // Buffer fully drained by waitExit; a fresh read yields no new output.
  const again = expectOk(reg.read(entry.id))
  assert.equal(again.data, "")
  assert.equal(again.status, "exited")
})

test("read supports a regex line filter", async (t) => {
  const reg = fixtureRegistry(t)
  const cmd = isWin ? "echo keep-me && echo drop-this" : "printf 'keep-me\\ndrop-this\\n'"
  const entry = reg.spawnBackground(inv(cmd))
  // Wait for exit WITHOUT reading, so one filtered read sees all the output.
  await waitStatusExit(reg, entry.id)
  const r = expectOk(reg.read(entry.id, { filter: "^keep" }))
  assert.match(r.data, /keep-me/)
  assert.doesNotMatch(r.data, /drop-this/)
})

test("an invalid filter regex is ignored and the raw delta returned", async (t) => {
  const reg = fixtureRegistry(t)
  const entry = reg.spawnBackground(inv("echo raw-output"))
  await waitStatusExit(reg, entry.id)
  assert.match(expectOk(reg.read(entry.id, { filter: "(" })).data, /raw-output/)
})

test("read returns not_found for an unknown id", (t) => {
  const reg = fixtureRegistry(t)
  assert.deepEqual(reg.read("nope"), { ok: false, reason: "not_found" })
})

test("waitForOutput long-polls until new output arrives", async (t) => {
  const reg = fixtureRegistry(t)
  const cmd = isWin ? "ping -n 2 127.0.0.1 >nul && echo later" : "sleep 0.1; echo later"
  const entry = reg.spawnBackground(inv(cmd))
  const started = Date.now()
  const result = expectOk(await reg.waitForOutput(entry.id, { waitMs: 10_000 }))
  assert.match(result.data, /later/)
  assert.ok(Date.now() - started >= 50)
  await reg.killAll()
})

test("waitForOutput returns after its deadline when a process stays quiet", async (t) => {
  const reg = fixtureRegistry(t)
  const cmd = isWin ? "ping -n 3 127.0.0.1 >nul" : "sleep 2"
  const entry = reg.spawnBackground(inv(cmd))
  const started = Date.now()
  const result = expectOk(await reg.waitForOutput(entry.id, { waitMs: 75 }))
  assert.equal(result.data, "")
  assert.equal(result.status, "running")
  assert.ok(Date.now() - started >= 50)
  await reg.killAll()
})

test("read maxChars preserves unread output for the next call", async (t) => {
  const reg = fixtureRegistry(t)
  const entry = reg.spawnBackground(inv(isWin ? "echo 1234567890" : "printf 1234567890"))
  await waitStatusExit(reg, entry.id)
  const first = expectOk(reg.read(entry.id, { maxChars: 4 }))
  const second = expectOk(reg.read(entry.id, { maxChars: 20 }))
  assert.equal(first.data, "1234")
  assert.match(second.data, /^567890/)
})

test("list exposes command lifecycle details for inventory tools", async (t) => {
  const reg = fixtureRegistry(t)
  const entry = reg.spawnBackground(inv(isWin ? "ping -n 3 127.0.0.1 >nul" : "sleep 2"))
  const [listed] = reg.list()
  assert.ok(listed)
  assert.equal(listed.id, entry.id)
  assert.equal(listed.command, entry.command)
  assert.equal(listed.status, "running")
  assert.equal(typeof listed.startedAt, "number")
  assert.equal(typeof listed.cwd, "string")
  await reg.killAll()
})

test("kill terminates a long-running shell; idempotent", async (t) => {
  const reg = fixtureRegistry(t)
  const longCmd = isWin ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
  const entry = reg.spawnBackground(inv(longCmd))
  const k = reg.kill(entry.id)
  assert.equal(k.ok, true)
  // Second kill on the same id is safe.
  const k2 = reg.kill(entry.id)
  assert.equal(k2.ok, true)
  // Give the close event a moment, then confirm it is marked exited.
  await new Promise((res) => setTimeout(res, 200))
  assert.equal(expectOk(reg.read(entry.id)).status, "exited")
})

test("kill returns not_found for an unknown id", (t) => {
  const reg = fixtureRegistry(t)
  assert.equal(reg.kill("nope").ok, false)
})

test("killAll stops survivors and clears the registry", async (t) => {
  const reg = fixtureRegistry(t)
  const longCmd = isWin ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
  reg.spawnBackground(inv(longCmd))
  reg.spawnBackground(inv(longCmd))
  assert.equal(reg.list().length, 2)
  await reg.killAll()
  assert.equal(reg.list().length, 0)
})

test(
  "killAll waits for cooperative cleanup and reaps a SIGTERM-resistant writer",
  { skip: process.platform === "win32" },
  async (t) => {
    for (const cooperative of [true, false]) {
      const reg = fixtureRegistry(t)
      const script = `process.on('SIGTERM',()=>{${cooperative ? "setTimeout(()=>process.exit(0),120)" : ""}});console.log('READY');setInterval(()=>{},100);`
      const command = `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`
      const entry = reg.spawnBackground(inv(command))
      try {
        await reg.waitForOutput(entry.id, { waitMs: 10_000 })
        assert.match(entry.buffer, /READY/)
        const started = Date.now()
        await reg.killAll()
        assert.equal(entry.status, "exited", "cleanup must await actual process closure")
        assert.throws(() => process.kill(entry.pid!, 0), { code: "ESRCH" })
        assert.ok(Date.now() - started >= (cooperative ? 100 : 900))
        await reg.killAll()
      } finally {
        entry.child.kill("SIGKILL")
        entry.child.stdout?.destroy()
        entry.child.stderr?.destroy()
        await reg.killAll().catch(() => {})
      }
    }
  }
)

test("ring buffer is bounded — a single read never exceeds the cap", async (t) => {
  const reg = fixtureRegistry(t)
  // Emit well over the 256 KB cap, then poll status WITHOUT draining so the
  // whole surviving buffer is still present for one bound-checking read.
  const big = isWin
    ? `for /L %i in (1,1,40000) do @echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
    : `yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | head -n 40000`
  const entry = reg.spawnBackground(inv(big))
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (reg.list().find((s) => s.id === entry.id)?.status === "exited") break
    await new Promise((res) => setTimeout(res, 25))
  }
  const r = expectOk(reg.read(entry.id))
  assert.equal(r.status, "exited")
  assert.ok(r.data.length <= MAX_RING_BYTES, `delta ${r.data.length} > cap ${MAX_RING_BYTES}`)
  // It produced far more than the cap, so the buffer must have been trimmed.
  assert.ok(r.data.length >= MAX_RING_BYTES - 1024)
})

test("Windows-shaped background lifecycle exits while proof remains unavailable", async (t) => {
  const registry = fixtureRegistry(t, { groupProofSupported: false })
  for (let i = 0; i < 3; i++) {
    const entry = registry.spawnBackground(inv("exit 0"))
    assert.equal((await waitExit(registry, entry.id)).status, "exited")
    assert.equal(registry.list().find((row) => row.id === entry.id)?.status, "exited")
  }
  assert.equal(registry.hasLiveProcesses?.(), true)
  await registry.killAll()
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.hasLiveProcesses?.(), true)
})
