import { dispatchAround, dispatchGuard, dispatchObserve, dispatchTransform } from "./dispatch"
import { HOST_BACKGROUND, pluginExecutionContext } from "../core/invocation-identity"
import { registerInterceptor, __resetInterceptorRegistryForTesting } from "./registry"
import type { InterceptorRegistration } from "./types"

afterEach(__resetInterceptorRegistryForTesting)

function registration(
  pointId: string,
  semantic: InterceptorRegistration["semantic"],
  handler: unknown,
  timeoutMs = 5000
) {
  return registerInterceptor({
    registrationId: pointId,
    pointId,
    semantic,
    pluginId: "provider",
    pluginInstanceId: "provider#1",
    generation: 1,
    realmId: "global",
    trustTier: "community",
    order: {},
    timeoutMs,
    source: "interceptors",
    runtime: "frontend",
    handler: handler as never,
  })
}

it("binds every interceptor semantic to its registering plugin, without exposing Host proof", async () => {
  const credentialContext = { executionRunId: "exact-attempt" }
  const context = { operationId: "operation", credentialContext }
  const check = (meta: object) => {
    expect(pluginExecutionContext("provider")).toEqual(credentialContext)
    expect(meta).not.toHaveProperty("credentialContext")
  }
  registration("tool.call.prepare", "transform", (value: unknown, meta: object) => {
    check(meta)
    return value
  })
  registration(
    "tool.execute",
    "around",
    async (value: unknown, next: (v: unknown) => Promise<unknown>, meta: object) => {
      check(meta)
      return next(value)
    }
  )
  registration("agent.turn.decide", "guard", (_value: unknown, meta: object) => {
    check(meta)
    return { decision: "pass" }
  })
  let observed!: () => void
  const done = new Promise<void>((resolve) => {
    observed = resolve
  })
  registration("operation.completed", "observe", (_value: unknown, meta: object) => {
    check(meta)
    observed()
  })
  expect((await dispatchTransform("tool.call.prepare", {}, context)).report.failed).toEqual([])
  const guarded = await dispatchGuard("agent.turn.decide", {}, context)
  expect(guarded.report.failed).toEqual([])
  expect(guarded.verdict).toEqual({ decision: "pass" })
  await dispatchAround("tool.execute", {}, async () => "done", context)
  await done
})

it("keeps a timed-out callback bound until actual settlement and backgrounds runless dispatch", async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  let settled!: () => void
  const done = new Promise<void>((resolve) => {
    settled = resolve
  })
  registration(
    "tool.call.prepare",
    "transform",
    async (value: unknown) => {
      try {
        await waiting
        expect(pluginExecutionContext("provider")).toEqual(HOST_BACKGROUND)
        return value
      } finally {
        settled()
      }
    },
    1
  )
  await dispatchTransform("tool.call.prepare", {}, { operationId: "timeout" }).catch(
    () => undefined
  )
  expect(pluginExecutionContext("provider")).toEqual(HOST_BACKGROUND)
  release()
  await done
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(pluginExecutionContext("provider")).toBeUndefined()
  dispatchObserve("operation.completed", {}, { operationId: "runless" })
})
