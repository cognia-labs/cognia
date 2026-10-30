/**
 * @jest-environment jsdom
 */
/**
 * Reading `activate()`'s return value: the split, and what happens to each
 * contribution that comes out of it.
 */

import {
  registerDeclaredInterceptors as registerContributions,
  splitActivationContributions,
} from "./contributions"
import {
  listInterceptorsForPoint,
  registerInterceptor,
  __resetInterceptorRegistryForTesting,
} from "./registry"
import { __resetInterceptorIdentityForTesting } from "./identity"
import { usePluginStore } from "@/stores/plugin-runtime"
import { dispatchTransform } from "./dispatch"
import type { PluginHooks } from "@/types/plugin"
import type { PluginInterceptorContribution } from "@/types/plugin/plugin-interceptors"

const contribution = (
  overrides: Partial<PluginInterceptorContribution> = {}
): PluginInterceptorContribution => ({
  point: "tool.result.project",
  handler: () => undefined,
  ...overrides,
})

const registerDeclaredInterceptors: typeof registerContributions = (id, entries, options) =>
  registerContributions(id, entries, { hasPermission: () => true, ...options })

beforeEach(() => {
  __resetInterceptorRegistryForTesting()
  __resetInterceptorIdentityForTesting()
  usePluginStore.setState({ plugins: {} } as never)
})

describe("splitActivationContributions", () => {
  it("returns a bare hook bag untouched", () => {
    const hooks = { onEnable: () => {} } as unknown as PluginHooks
    expect(splitActivationContributions(hooks)).toEqual({ interceptors: [], hookBag: hooks })
  })

  it("returns interceptors with no hook bag when only interceptors were declared", () => {
    const entry = contribution()
    const result = splitActivationContributions({
      interceptors: [entry],
    } as unknown as PluginHooks)
    expect(result.interceptors).toEqual([entry])
    // No leftover `{ interceptors: [] }` masquerading as a hook bag — the
    // manager would otherwise register an empty bag as a hook contribution.
    expect(result.hookBag).toBeUndefined()
  })

  it("splits an object carrying both, so a plugin can adopt them one at a time", () => {
    const entry = contribution()
    const onEnable = () => {}
    const result = splitActivationContributions({
      onEnable,
      interceptors: [entry],
    } as unknown as PluginHooks)
    expect(result.interceptors).toEqual([entry])
    expect(result.hookBag).toEqual({ onEnable })
  })

  it("ignores a non-array `interceptors` rather than trusting its shape", () => {
    const result = splitActivationContributions({
      interceptors: "nope",
    } as unknown as PluginHooks)
    expect(result.interceptors).toEqual([])
  })

  it("does not mutate the object the plugin returned", () => {
    const original = {
      onEnable: () => {},
      interceptors: [contribution()],
    } as unknown as PluginHooks
    splitActivationContributions(original)
    expect((original as { interceptors?: unknown[] }).interceptors).toHaveLength(1)
  })
})

describe("registerDeclaredInterceptors", () => {
  it("rejects a result if its permission is revoked while the handler waits", async () => {
    let allowed = true
    let finish!: () => void
    registerContributions(
      "p1",
      [
        contribution({
          handler: (async (value: object) => {
            await new Promise<void>((resolve) => {
              finish = resolve
            })
            return { ...value, projection: "late" }
          }) as never,
          failurePolicy: "fail-closed",
        }),
      ],
      { hasPermission: () => allowed }
    )
    const pending = dispatchTransform(
      "tool.result.project",
      { projection: "original" },
      { operationId: "revoked" }
    )
    await Promise.resolve()
    allowed = false
    finish()
    await expect(pending).rejects.toMatchObject({ name: "InterceptorFailClosedError" })
  })
  it("refuses declared interception without the canonical permission", () => {
    const outcome = registerContributions("p1", [contribution()], { hasPermission: () => false })
    expect(outcome.registered).toBe(0)
    expect(outcome.rejected).toEqual([
      { point: "tool.result.project", reason: "permission-denied" },
    ])
  })
  it("registers a valid contribution", () => {
    const outcome = registerDeclaredInterceptors("p1", [contribution()])
    expect(outcome.registered).toBe(1)
    expect(listInterceptorsForPoint("tool.result.project")).toHaveLength(1)
  })

  it("rejects an unknown point instead of silently dropping it", () => {
    const outcome = registerDeclaredInterceptors("p1", [contribution({ point: "nope" as never })])
    expect(outcome.rejected).toEqual([{ point: "nope", reason: "unknown-point" }])
    expect(outcome.registered).toBe(0)
  })

  it("rejects a semantic that disagrees with the point", () => {
    const outcome = registerDeclaredInterceptors("p1", [
      contribution({ point: "tool.execute", semantic: "observe" }),
    ])
    expect(outcome.rejected[0]).toEqual({ point: "tool.execute", reason: "semantic-mismatch" })
  })

  it("rejects a non-function handler", () => {
    const outcome = registerDeclaredInterceptors("p1", [
      contribution({ handler: "not a function" as never }),
    ])
    expect(outcome.rejected[0]?.reason).toBe("handler-not-a-function")
  })

  it.each(["agent.turn.decide", "model.stream.transform", "ui.surface.project"] as const)(
    "registers the real consumer point %s",
    (point) => {
      const outcome = registerDeclaredInterceptors("p1", [contribution({ point })])
      expect(outcome.registered).toBe(1)
      expect(outcome.dormant).toEqual([])
      expect(listInterceptorsForPoint(point)).toHaveLength(1)
    }
  )

  it("replaces the plugin's previous interceptors rather than stacking them", () => {
    registerDeclaredInterceptors("p1", [contribution()])
    registerDeclaredInterceptors("p1", [contribution()])
    expect(listInterceptorsForPoint("tool.result.project")).toHaveLength(1)
  })

  it("leaves another plugin's interceptors alone", () => {
    registerDeclaredInterceptors("p1", [contribution()])
    registerDeclaredInterceptors("p2", [contribution()])
    expect(listInterceptorsForPoint("tool.result.project")).toHaveLength(2)
  })

  it("sweeps a superseded generation's records from every surface", () => {
    // A chat middleware whose disposer never fired would otherwise keep a dead
    // generation's closure on a live chain.
    registerInterceptor({
      registrationId: "p1:stale-mw",
      pluginId: "p1",
      pluginInstanceId: "p1#1",
      generation: 1,
      realmId: "global",
      pointId: "model.request.invoke",
      semantic: "around",
      trustTier: "community",
      order: {},
      timeoutMs: 100,
      handler: (() => undefined) as never,
      source: "chat-middleware",
      runtime: "frontend",
    })
    registerDeclaredInterceptors("p1", [contribution()], { generation: 2 })
    expect(listInterceptorsForPoint("model.request.invoke")).toHaveLength(0)
  })

  it("keeps the CURRENT generation's records from another surface", () => {
    registerInterceptor({
      registrationId: "p1:live-mw",
      pluginId: "p1",
      pluginInstanceId: "p1#2",
      generation: 2,
      realmId: "global",
      pointId: "model.request.invoke",
      semantic: "around",
      trustTier: "community",
      order: {},
      timeoutMs: 100,
      handler: (() => undefined) as never,
      source: "chat-middleware",
      runtime: "frontend",
    })
    registerDeclaredInterceptors("p1", [contribution()], { generation: 2 })
    expect(listInterceptorsForPoint("model.request.invoke")).toHaveLength(1)
  })

  it("derives a stable registration id from a declared contribution id", () => {
    registerDeclaredInterceptors("p1", [contribution({ id: "redact" })])
    expect(listInterceptorsForPoint("tool.result.project")[0]?.registrationId).toBe(
      "p1:tool.result.project:redact"
    )
  })

  it("carries ordering, timeout and failure-policy narrowing onto the record", () => {
    registerDeclaredInterceptors("p1", [
      contribution({
        id: "one",
        after: ["other-plugin"],
        priority: 3,
        timeoutMs: 250,
        failurePolicy: "fail-closed",
      }),
    ])
    const [record] = listInterceptorsForPoint("tool.result.project")
    expect(record?.order).toEqual({ after: ["other-plugin"], priority: 3 })
    expect(record?.timeoutMs).toBe(250)
    expect(record?.failurePolicy).toBe("fail-closed")
  })

  it("keeps going after a rejection instead of abandoning the rest", () => {
    const outcome = registerDeclaredInterceptors("p1", [
      contribution({ point: "nope" as never }),
      contribution({ id: "good" }),
    ])
    expect(outcome.registered).toBe(1)
    expect(outcome.rejected).toHaveLength(1)
  })
})
