/**
 * The scheduled task executors feature modules contribute (ADR-0250 §14
 * `taskExecutors`). A module declares the task types it owns in its
 * manifest, with the file that holds their executors; the generated registry
 * (`lib/modules/generated/task-executors.ts`) lists the types and one lazy
 * import per module, so the scheduler knows every owner without loading any
 * feature code.
 *
 * Each declared type gets a `TaskExecutorOwner` (`./executor-owners.ts`): when
 * a task of that type comes due and nothing registered its executor yet, the
 * scheduler runs the owner, which imports the module's file once and
 * registers every executor it declares. A declared type the file does not
 * provide is logged and left unregistered, so its run fails the way any
 * missing executor does; an executor the file provides for an undeclared type
 * is logged and not registered, because no owner would ever load it. A file
 * that fails to load rejects the owner (the scheduler records why) and is
 * tried again next time. An `experimental` module owns nothing.
 *
 * Pure leaf, like the owner table: the scheduler loads with `import()`.
 */

import { loggers } from "@cognia/logging"
import type { ModuleTaskExecutorsEntry } from "@/lib/modules/manifest-types"
import { MODULE_TASK_EXECUTORS } from "@/lib/modules/generated/task-executors"
import type { ScheduledTaskType } from "@/types/scheduler"
import type { TaskExecutorOwner } from "./executor-owners"

const loads = new Map<string, Promise<void>>()

async function registerEntry(entry: ModuleTaskExecutorsEntry): Promise<void> {
  const [{ taskExecutors }, { registerTaskExecutor }] = await Promise.all([
    entry.load(),
    import("./task-scheduler"),
  ])
  const declared = new Set<string>(entry.types)
  for (const type of entry.types) {
    const executor = taskExecutors[type]
    if (executor) registerTaskExecutor(type, executor)
  }
  const missing = entry.types.filter((type) => !taskExecutors[type])
  if (missing.length > 0)
    loggers.scheduler.error("task executors a module declares were not provided", {
      module: entry.module,
      missing,
    })
  const undeclared = Object.keys(taskExecutors).filter((type) => !declared.has(type))
  if (undeclared.length > 0)
    loggers.scheduler.error("task executors a module provides but does not declare", {
      module: entry.module,
      undeclared,
    })
}

function ownerOf(entry: ModuleTaskExecutorsEntry): TaskExecutorOwner {
  return () => {
    const pending = loads.get(entry.module)
    if (pending) return pending
    const load = registerEntry(entry).catch((error: unknown) => {
      loads.delete(entry.module)
      throw error
    })
    loads.set(entry.module, load)
    return load
  }
}

/** The owner of every task type an active module declares. */
export function moduleTaskExecutorOwners(
  entries: readonly ModuleTaskExecutorsEntry[] = MODULE_TASK_EXECUTORS
): Partial<Record<ScheduledTaskType, TaskExecutorOwner>> {
  const owners: Partial<Record<ScheduledTaskType, TaskExecutorOwner>> = {}
  for (const entry of entries) {
    if (entry.stage === "experimental") continue
    const owner = ownerOf(entry)
    for (const type of entry.types) owners[type] = owner
  }
  return owners
}

/** Forget what was loaded. */
export function __resetModuleTaskExecutorsForTesting(): void {
  loads.clear()
}
