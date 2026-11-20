// Fake process-group RSS for tests that run real `run_code` children.
//
// The supervisor samples the sandbox process group with `ps` (asynchronously,
// through `execFile`). Broker and adapter tests exercise dispatch, not OS
// memory accounting, which the supervisor's own tests cover; they keep the
// real child and answer every `ps` with 1 KiB per group they spawned.

import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { after, mock } from "node:test"

/** Install the fake for the calling test file; returns the spawned group ids. */
export function fakeSandboxRss(): ReadonlySet<number> {
  const groups = new Set<number>()
  const spawn = childProcess.spawn
  const execFile = childProcess.execFile as (...args: unknown[]) => unknown
  mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args)
    if (child.pid) groups.add(child.pid)
    return child
  })
  mock.method(childProcess, "execFile", (...args: unknown[]) => {
    if (args[0] !== "ps") return execFile(...args)
    const callback = args[args.length - 1] as (error: null, stdout: string) => void
    queueMicrotask(() => callback(null, [...groups].map((pid) => `${pid} ${pid} 1`).join("\n")))
    return undefined
  })
  syncBuiltinESMExports()
  after(() => {
    mock.restoreAll()
    syncBuiltinESMExports()
  })
  return groups
}
