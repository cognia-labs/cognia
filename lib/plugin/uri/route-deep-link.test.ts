const handleActivationEvent = jest.fn(async (_event: string) => {})
let managerAvailable = true
jest.mock("@/lib/plugin/core/manager", () => ({
  getPluginManager: () => {
    if (!managerAvailable) throw new Error("not initialized")
    return { handleActivationEvent }
  },
}))

import { hasPluginDeepLinkHandler, routePluginDeepLink } from "./route-deep-link"
import { __resetUriHandlersForTesting, registerUriHandler } from "./uri-handler-registry"
import type { ParsedDeepLink } from "./parse-deep-link"

afterEach(() => {
  __resetUriHandlersForTesting()
  handleActivationEvent.mockClear()
  managerAvailable = true
})

it("activates the addressed plugin, then hands it the link", async () => {
  const seen: ParsedDeepLink[] = []
  registerUriHandler("acme", (uri) => void seen.push(uri))
  await expect(routePluginDeepLink("cognia://plugin/acme/cb?code=1")).resolves.toBe(true)
  expect(handleActivationEvent).toHaveBeenCalledWith("onUri:acme")
  expect(seen).toEqual([
    expect.objectContaining({ pluginId: "acme", path: "cb", query: { code: "1" } }),
  ])
})

it("still dispatches when the manager is not up, and reports links nobody handles", async () => {
  managerAvailable = false
  const seen: string[] = []
  registerUriHandler("acme", (uri) => void seen.push(uri.path))
  await expect(routePluginDeepLink("cognia://plugin/acme/x")).resolves.toBe(true)
  expect(seen).toEqual(["x"])
  await expect(routePluginDeepLink("cognia://plugin/other/x")).resolves.toBe(false)
  managerAvailable = true
  await expect(routePluginDeepLink("https://example.com")).resolves.toBe(false)
  expect(handleActivationEvent).not.toHaveBeenCalled()
})

it("says whether a plugin link has a handler, without dispatching it", async () => {
  const seen: string[] = []
  registerUriHandler("acme", (uri) => void seen.push(uri.path))
  await expect(hasPluginDeepLinkHandler("cognia://plugin/acme/cb")).resolves.toBe(true)
  await expect(hasPluginDeepLinkHandler("cognia://plugin/ghost/cb")).resolves.toBe(false)
  await expect(hasPluginDeepLinkHandler("cognia://chat")).resolves.toBe(false)
  expect(seen).toEqual([])
  expect(handleActivationEvent).toHaveBeenCalledWith("onUri:ghost")
})

it("shares one activation between concurrent lookups of the same plugin", async () => {
  registerUriHandler("acme", () => {})
  await Promise.all([
    routePluginDeepLink("cognia://plugin/acme/a"),
    hasPluginDeepLinkHandler("cognia://plugin/acme/a"),
  ])
  expect(handleActivationEvent).toHaveBeenCalledTimes(1)
})

jest.mock("@/lib/plugin/auth/auth-attempts", () => ({
  ...jest.requireActual("@/lib/plugin/auth/auth-attempts"),
  consumeAttempt: jest.fn(async (state: string) => ({ state })),
  cancelAttempt: jest.fn(async () => {}),
}))
it("dispatches Host auth callbacks without activating a plugin and retains old plugin handlers", async () => {
  const { registerAuthCallbackWaiter } = await import("@/lib/plugin/auth/callback-acceptor")
  const waiter = registerAuthCallbackWaiter("host-state", {
    providerId: "p",
    clientId: "c",
    issuer: "https://issuer",
  })
  expect(await hasPluginDeepLinkHandler("cognia://auth/callback?state=host-state&code=c")).toBe(
    true
  )
  expect(await routePluginDeepLink("cognia://auth/callback?state=host-state&code=c")).toBe(true)
  expect((await waiter.promise).callback.code).toBe("c")
  expect(handleActivationEvent).not.toHaveBeenCalled()
  const oldHandler = jest.fn()
  registerUriHandler("feishu-auth", oldHandler)
  expect(
    await routePluginDeepLink("cognia://plugin/feishu-auth/oauth-callback?state=old&code=c")
  ).toBe(true)
  expect(oldHandler).toHaveBeenCalled()
})
