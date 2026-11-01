import type { PluginContext } from "@cognia/plugin-sdk"
import {
  calendarAccessCode,
  requestCalendarAccess,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
} from "./connection"

it("requests exact calendar reads and writes as separate foreground grants", async () => {
  const get = jest.fn(async () => ({ ref: "host-ref" }))
  const requestGrant = jest.fn(async () => ({ granted: true }))
  const host = { auth: { connections: { get, requestGrant } } } as unknown as PluginContext
  expect(await requestCalendarAccess(host, true)).toBe(true)
  expect(get).toHaveBeenCalledWith({
    service: "auth.feishu",
    scopes: ["calendar:calendar:readonly"],
    interactive: true,
  })
  expect(requestGrant.mock.calls).toEqual([
    ["host-ref", { operations: READ_OPERATIONS, scopes: ["calendar:calendar:readonly"] }],
    ["host-ref", { operations: WRITE_OPERATIONS, scopes: ["calendar:calendar"] }],
  ])
  expect([...READ_OPERATIONS, ...WRITE_OPERATIONS].some((id) => id.includes("*"))).toBe(false)
  expect(WRITE_OPERATIONS).not.toContain("feishu-calendar.request.POST")
})

it("stops after denied read consent and reports only safe Host error codes", async () => {
  const requestGrant = jest.fn(async () => ({ granted: false }))
  const host = {
    auth: { connections: { get: async () => ({ ref: "host-ref" }), requestGrant } },
  } as unknown as PluginContext
  expect(await requestCalendarAccess(host, true)).toBe(false)
  expect(requestGrant).toHaveBeenCalledTimes(1)
  for (const name of [
    "ConsumerGrantRequired",
    "ConnectionRevisionChanged",
    "ConnectionUnavailableError",
  ])
    expect(
      calendarAccessCode(Object.assign(new Error("secret provider payload"), { name }))
    ).toBeDefined()
  expect(calendarAccessCode(new Error("secret provider payload"))).toBeUndefined()
})
