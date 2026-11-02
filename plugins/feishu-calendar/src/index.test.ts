/** @jest-environment jsdom */
/** @cognia-host-integration-test */
import { createHash, webcrypto } from "node:crypto"
Object.defineProperty(globalThis.crypto, "subtle", { configurable: true, value: webcrypto.subtle })
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { createSyncAPI, clearSyncForPlugin } from "@/lib/plugin/api/sync-api"
jest.mock("@/lib/plugin/auth/connection-access", () => ({
  connectionAccess: () => ({
    connected: async (ref: string) => ({
      id: ref,
      status: "connected",
      ownerPluginId: "feishu-calendar",
    }),
    checked: async (task: () => Promise<unknown>) => task(),
  }),
}))
const database = createDbTestFixture({ seeded: false })
beforeAll(database.initialize)
beforeEach(async () => {
  await database.restore()
  await getDb().authConnections.put({ id: "ref", status: "connected" } as never)
})
afterEach(() => clearSyncForPlugin("feishu-calendar"))
afterAll(database.dispose)
import type {
  IntegrationActionHandlerContext,
  IntegrationProviderContext,
} from "@cognia/plugin-sdk/api/integration"
import type { PluginContext } from "@cognia/plugin-sdk"
import definition, * as calendar from "./index"

function fixture() {
  const request = jest.fn(async (_url: string, _init?: { method?: string; body?: string }) => ({
    status: 200,
    headers: {},
    data: { code: 0, data: { event: { event_id: "event" } } },
  }))
  return {
    request,
    context: {
      pluginId: "feishu-calendar",
      integrationId: "feishu-calendar",
      accountId: "account",
      connection: { ref: "ref", issuer: "https://accounts.feishu.cn", revision: 1 },
      jobId: "job-stable",
      signal: new AbortController().signal,
      authenticatedRequest: request,
    } as unknown as IntegrationActionHandlerContext,
  }
}

describe("Feishu Calendar plugin", () => {
  it("ES-32 labels unsupported features and exposes no active exception or push controls", () => {
    expect(calendar.feishuCalendarIntegration.limitations).toEqual([
      "recurrenceExceptionEditing",
      "nativePushNotifications",
    ])
    expect(calendar.feishuCalendarIntegration.actions.map((action) => action.id)).not.toEqual(
      expect.arrayContaining(["editException", "subscribePush"])
    )
    expect(
      calendar.feishuCalendarIntegration.actions.some((action) => /exception|push/i.test(action.id))
    ).toBe(false)
  })
  it("declares a service consumer with no provider credentials and real handlers", () => {
    expect(calendar.manifest.dependencies).toBeUndefined()
    expect(calendar.manifest.requiresServices).toEqual({ "auth.feishu": "^1.0.0" })
    expect(calendar.feishuCalendarIntegration.authStrategies[0]).toMatchObject({
      type: "connection",
      service: "auth.feishu",
    })
    expect(calendar.feishuCalendarIntegration.authStrategies[0].configSchema).toBeUndefined()
    expect(calendar.feishuCalendarIntegration.authStrategies[0].providerId).toBeUndefined()
    for (const action of calendar.feishuCalendarIntegration.actions) {
      expect(typeof calendar[action.handler as keyof typeof calendar]).toBe("function")
    }
    expect(calendar.manifest.scheduledTasks?.[0]).toMatchObject({
      handler: "syncSubscribedCalendars",
      defaultEnabled: true,
    })
    expect(
      calendar.feishuCalendarIntegration.actions.find((a) => a.id === "deleteEvent")?.risk
    ).toBe("destructive")
    expect(
      calendar.feishuCalendarIntegration.actions.find((a) => a.id === "createEvent")?.idempotency
    ).toBe("required")
  })

  it("uses the host action job as Feishu creation idempotency and retains the account-bound broker", async () => {
    const f = fixture()
    await calendar.createEvent(
      {
        calendarId: "cal",
        event: { summary: "Meeting", start_time: { timestamp: "1" }, end_time: { timestamp: "2" } },
      },
      f.context
    )
    expect(new URL(f.request.mock.calls[0][0]).searchParams.get("idempotency_key")).toBe(
      "job-stable"
    )
    expect(f.request.mock.calls[0][1]).toMatchObject({ method: "POST" })
  })

  it("discovers selectable calendars through the credential-bound resource context", async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      data: {
        code: 0,
        data: { calendar_list: [{ calendar_id: "cal", summary: "Work" }], has_more: false },
      },
    } as never)
    await expect(
      calendar.listCalendarResources(
        { accountId: "account", kind: "calendar", limit: 50 },
        f.context as IntegrationProviderContext
      )
    ).resolves.toMatchObject({ items: [{ kind: "calendar", id: "cal", name: "Work" }] })
    await expect(
      calendar.listCalendarResources(
        { accountId: "account", kind: "room" },
        f.context as IntegrationProviderContext
      )
    ).rejects.toThrow("resource kind")
  })

  it("registers and disposes the actual scheduled sync handler", async () => {
    const disposers: Array<() => void> = []
    const dispose = jest.fn()
    const registerHandler = jest.fn(
      (
        _name: string,
        _handler: (args: unknown, task: { signal: AbortSignal }) => Promise<unknown>
      ) => dispose
    )
    const context = {
      storage: { get: jest.fn(), set: jest.fn() },
      integrations: {
        migrateLegacy: jest.fn(),
        listAccounts: jest.fn(async () => []),
        listSubscriptions: jest.fn(),
        authenticatedRequest: jest.fn(),
        publishEvent: jest.fn(),
      },
      scheduler: { registerHandler },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: (callback: () => void) => {
          disposers.push(callback)
        },
      },
    } as unknown as PluginContext
    await definition.activate?.(context)
    expect(registerHandler.mock.calls[0][0]).toBe("syncSubscribedCalendars")
    const handler = registerHandler.mock.calls[0][1]
    await expect(handler({}, { signal: new AbortController().signal })).resolves.toMatchObject({
      success: true,
      output: { calendars: 0 },
    })
    disposers.forEach((dispose) => dispose())
    expect(dispose).toHaveBeenCalledTimes(1)
    const f = fixture()
    expect(() => calendar.syncCalendar({ calendarId: "cal" }, f.context)).toThrow("not active")
  })

  it("reports degraded health without leaking provider response data", async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({
      status: 403,
      headers: {},
      data: { code: 99991672, msg: "sensitive provider content" },
    } as never)
    const health = await calendar.checkCalendarHealth(f.context)
    expect(health).toMatchObject({ health: "degraded", recoveryAction: "reauthorize" })
    expect(JSON.stringify(health)).not.toContain("sensitive")
  })

  it("propagates scheduler cancellation from the second handler argument", async () => {
    const disposers: Array<() => void> = []
    const task = new AbortController()
    const values = new Map<string, unknown>()
    const registerHandler = jest.fn(
      (
        _name: string,
        _handler: (args: unknown, task: { signal: AbortSignal }) => Promise<unknown>
      ) =>
        () =>
          undefined
    )
    const request = jest.fn(async () => {
      task.abort()
      return {
        status: 200,
        headers: {},
        data: {
          code: 0,
          data: { items: [{ event_id: "event" }], has_more: false, sync_token: "must-not-commit" },
        },
      }
    })
    const publishEvent = jest.fn()
    const context = {
      sync: createSyncAPI("feishu-calendar", { hasPermission: () => true }),
      auth: {
        connections: {
          get: async () => ({
            ref: "ref",
            status: "connected",
            issuer: "https://accounts.feishu.cn",
            revision: 1,
          }),
        },
      },
      storage: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value))
        },
      },
      integrations: {
        migrateLegacy: jest.fn(),
        listAccounts: async () => [{ id: "account", enabled: true, connectionId: "ref" }],
        listSubscriptions: async () => [
          { enabled: true, resourceKind: "calendar", resourceId: "cal" },
        ],
        authenticatedRequest: request,
        publishEvent,
      },
      scheduler: { registerHandler },
      lifecycle: {
        signal: new AbortController().signal,
        onDispose: (dispose: () => void) => {
          disposers.push(dispose)
        },
      },
    } as unknown as PluginContext
    await definition.activate?.(context)
    try {
      await expect(registerHandler.mock.calls[0][1]({}, { signal: task.signal })).rejects.toThrow()
      expect(request).toHaveBeenCalledTimes(1)
      expect(publishEvent).not.toHaveBeenCalled()
      expect(values.size).toBe(0)
      expect(
        (
          await getDb().externalSyncCursors.get(
            `plugin:feishu-calendar/calendar:${createHash("sha256")
              .update(JSON.stringify(["account", "cal"]))
              .digest("hex")}`
          )
        )?.cursor
      ).toBeUndefined()
    } finally {
      disposers.forEach((dispose) => dispose())
    }
  })
})
