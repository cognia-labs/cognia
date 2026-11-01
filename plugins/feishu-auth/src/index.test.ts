import plugin, { manifest } from "./index"
import type { PluginContext } from "@cognia/plugin-sdk"

it("activates only a Host-managed provider and disposes its registration", async () => {
  const unregister = jest.fn()
  const registerProvider = jest.fn(() => unregister)
  const onDispose = jest.fn()
  await plugin.activate!({
    auth: { registerProvider },
    lifecycle: { onDispose },
    network: {},
  } as unknown as PluginContext)
  expect(registerProvider).toHaveBeenCalledWith(
    expect.objectContaining({ management: "host", id: "feishu-user-oauth" })
  )
  expect(onDispose).toHaveBeenCalledWith(unregister, "feishu-auth:provider")
  expect(manifest.providesServices).toEqual({ "auth.feishu": "1.0.0" })
  expect(manifest.authProviders).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "feishu-user-oauth",
        methods: ["oauth-pkce", "client-credentials"],
        principals: ["user", "bot"],
      }),
    ])
  )
  onDispose.mock.calls[0][0]()
  expect(unregister).toHaveBeenCalledTimes(1)
  expect(registerProvider).toHaveBeenCalledTimes(1)
})
