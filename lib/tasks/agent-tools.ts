/**
 * The `tasks` module's tool family (ADR-0250 §14 amendment): `spawn_task`,
 * which stages a scoped follow-up in a new named sidechat for the user to
 * start. The manifest declares it; the kernel offers it as a plugin-manifest
 * entry and routes its calls here, host-side, where the chat store the
 * sidechat lands in lives.
 */
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type {
  ModuleToolEntry,
  ModuleToolFamily,
  ToolSurfaceContext,
} from "@/lib/modules/manifest-types"
import type { SpawnedTaskBrief } from "./spawn-task-core"
import { SPAWN_TASK_JSON_SCHEMA, SPAWN_TASK_TOOL_NAME, parseSpawnTaskArgs } from "./spawn-task-core"

export function buildSpawnTaskManifestEntries(): ModuleToolEntry[] {
  return [
    {
      name: SPAWN_TASK_TOOL_NAME,
      description:
        "Stage a clearly scoped follow-up task in a new named sidechat for the user to start. Use aside for self-contained work and inherit only when the new task needs this conversation's context. After this succeeds, do not perform the spawned work in the current thread.",
      jsonSchema: SPAWN_TASK_JSON_SCHEMA,
    },
  ]
}

export interface SpawnTaskToolRunDeps {
  gate: (payload: unknown) => boolean
  dispatch: (sessionId: string, brief: SpawnedTaskBrief) => Promise<unknown>
}

export async function runSpawnTaskBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: SpawnTaskToolRunDeps | undefined,
  context: { sessionId: string }
): Promise<unknown> {
  if (name !== SPAWN_TASK_TOOL_NAME) {
    return { ok: false as const, error: `unknown spawn task tool: ${name}` }
  }
  if (!deps) {
    return { ok: false as const, error: "spawn_task host dependencies are unavailable" }
  }
  if (!deps.gate(args)) {
    return { ok: false as const, error: "Spawned task blocked by the PII redaction gate" }
  }
  const brief = parseSpawnTaskArgs(args)
  if ("error" in brief) return { ok: false as const, error: brief.error }
  return deps.dispatch(context.sessionId, brief)
}

let depsOverride: (() => Promise<SpawnTaskToolRunDeps> | SpawnTaskToolRunDeps) | null = null

/** Inject the tool's deps (tests). Pass `null` to restore the default. */
export function __setSpawnTaskToolDepsForTesting(
  fn: (() => Promise<SpawnTaskToolRunDeps> | SpawnTaskToolRunDeps) | null
): void {
  depsOverride = fn
}

async function resolveSpawnTaskToolDeps(): Promise<SpawnTaskToolRunDeps> {
  if (depsOverride) return depsOverride()
  const { dispatchSpawnTask } = await import("./spawn-task-dispatch")
  return { gate: hasNoLeakingPiiDeep, dispatch: dispatchSpawnTask }
}

/**
 * The family the kernel loads. Opt-in through `selfInvokeTools.spawnTask`.
 * The native mobile shell has no sidechat host, so it is not offered there:
 * the call could only create a row nobody can open.
 */
export const toolFamily: ModuleToolFamily = {
  surface(ctx: ToolSurfaceContext) {
    if (ctx.settings?.selfInvokeTools?.spawnTask !== true) return null
    if (ctx.host === "mobile") return null
    return { tools: buildSpawnTaskManifestEntries() }
  },
  async run(name, args, call) {
    return runSpawnTaskBuiltinTool(name, args, await resolveSpawnTaskToolDeps(), {
      sessionId: call.sessionId,
    })
  },
}
