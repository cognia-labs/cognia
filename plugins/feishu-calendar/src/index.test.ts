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
      jobId: "job-stable",
      signal: new AbortController().signal,
      authenticatedRequest: request,
    } as unknown as IntegrationActionHandlerContext,
  }
}

describe("Feishu Calendar plugin", () => {
  it("declares a shared auth dependency and real exported action/resource/health handlers", () => {
    expect(calendar.manifest.dependencies).toEqual({ "feishu-auth": "^1.0.0" })
    expect(calendar.feishuCalendarIntegration.authStrategies[0].providerId).toBe(
      "feishu-user-oauth"
    )
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
      storage: {
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value))
        },
      },
      integrations: {
        listAccounts: async () => [{ id: "account", enabled: true }],
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
      expect([...values.values()][0]).not.toHaveProperty("syncToken")
    } finally {
      disposers.forEach((dispose) => dispose())
    }
  })
})
