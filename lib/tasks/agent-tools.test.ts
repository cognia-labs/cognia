import type { AppSettings } from "@cognia/agent-config-types"
import type { ToolCallContext, ToolSurfaceContext } from "@/lib/modules/manifest-types"
import {
  __setSpawnTaskToolDepsForTesting,
  buildSpawnTaskManifestEntries,
  runSpawnTaskBuiltinTool,
  toolFamily,
  type SpawnTaskToolRunDeps,
} from "./agent-tools"

const args = {
  title: "Fix retry cleanup",
  tldr: "Handle the cleanup separately.",
  situation: "A completed request retains its abort controller.",
  code_locations: ["hooks/chat/use-stream.ts:42"],
  solution: "Clear it on the terminal event.",
  caveats: ["Preserve retries."],
  mode: "inherit",
}

function deps(overrides: Partial<SpawnTaskToolRunDeps> = {}): SpawnTaskToolRunDeps {
  return {
    gate: jest.fn(() => true),
    dispatch: jest.fn(async (_sessionId, brief) => ({
      ok: true,
      taskSessionId: "task-1",
      ...brief,
    })),
    ...overrides,
  }
}

describe("the spawn_task tool", () => {
  it("exposes one strict spawn_task manifest entry", () => {
    const entries = buildSpawnTaskManifestEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: "spawn_task",
      jsonSchema: expect.objectContaining({ additionalProperties: false }),
    })
  })

  it("validates and dispatches against the calling session", async () => {
    const d = deps()
    await expect(
      runSpawnTaskBuiltinTool("spawn_task", args, d, { sessionId: "parent-1" })
    ).resolves.toMatchObject({ ok: true, taskSessionId: "task-1", mode: "inherit" })
    expect(d.dispatch).toHaveBeenCalledWith(
      "parent-1",
      expect.objectContaining({ title: args.title, codeLocations: args.code_locations })
    )
  })

  it("runs the PII gate before any dispatch", async () => {
    const d = deps({ gate: jest.fn(() => false) })
    await expect(
      runSpawnTaskBuiltinTool("spawn_task", { ...args, tldr: "email me@example.com" }, d, {
        sessionId: "parent-1",
      })
    ).resolves.toEqual({ ok: false, error: "Spawned task blocked by the PII redaction gate" })
    expect(d.dispatch).not.toHaveBeenCalled()
  })

  it("returns structured errors for invalid input, unknown names, and missing dependencies", async () => {
    await expect(
      runSpawnTaskBuiltinTool("spawn_task", { ...args, title: "" }, deps(), {
        sessionId: "parent-1",
      })
    ).resolves.toEqual({ ok: false, error: "title must be a non-empty string" })
    await expect(
      runSpawnTaskBuiltinTool("unknown", args, deps(), { sessionId: "parent-1" })
    ).resolves.toEqual({ ok: false, error: "unknown spawn task tool: unknown" })
    await expect(
      runSpawnTaskBuiltinTool("spawn_task", args, undefined, { sessionId: "parent-1" })
    ).resolves.toEqual({ ok: false, error: "spawn_task host dependencies are unavailable" })
  })
})

describe("toolFamily", () => {
  const optedIn = { selfInvokeTools: { spawnTask: true } } as unknown as AppSettings
  const ctx = (overrides: Partial<ToolSurfaceContext> = {}): ToolSurfaceContext => ({
    session: null,
    agent: null,
    settings: optedIn,
    activeGoal: null,
    prompts: { snapshot: null, context: {} },
    host: "desktop",
    activeProject: null,
    ...overrides,
  })

  it("offers spawn_task once opted in, everywhere but the native mobile shell", async () => {
    for (const host of ["desktop", "web", "cli", "brain"] as const) {
      const surface = await toolFamily.surface(ctx({ host }))
      expect(surface?.tools.map((tool) => tool.name)).toEqual(["spawn_task"])
    }
    expect(await toolFamily.surface(ctx({ host: "mobile" }))).toBeNull()
    expect(await toolFamily.surface(ctx({ settings: null }))).toBeNull()
  })

  it("dispatches against the calling session", async () => {
    const d = deps()
    __setSpawnTaskToolDepsForTesting(() => d)
    try {
      const call: ToolCallContext = {
        sessionId: "parent-9",
        toolUseId: "u1",
        executionRunId: "run-1",
        outboundAuthorization: { kind: "tool-call", sessionId: "parent-9", toolUseId: "u1" },
      }
      await expect(toolFamily.run("spawn_task", args, call)).resolves.toMatchObject({ ok: true })
      expect(d.dispatch).toHaveBeenCalledWith("parent-9", expect.anything())
    } finally {
      __setSpawnTaskToolDepsForTesting(null)
    }
  })
})
