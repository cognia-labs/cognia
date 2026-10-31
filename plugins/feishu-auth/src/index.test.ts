import definition, { manifest } from "./index"
import type { PluginContext } from "@cognia/plugin-sdk"

it("registers a shared provider and tears it down with its activation", async () => {
  const callbacks: Array<() => void> = []
  const unregister = jest.fn()
  const registerProvider = jest.fn(() => unregister)
  const ctx = {
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => {
        callbacks.push(dispose)
      },
    },
    auth: { registerProvider },
  } as unknown as PluginContext
  await definition.activate?.(ctx)
  expect(manifest.authProviders).toEqual([{ id: "feishu-user-oauth", label: "Feishu user OAuth" }])
  expect(registerProvider).toHaveBeenCalledWith(
    expect.objectContaining({ id: "feishu-user-oauth", createSession: expect.any(Function) })
  )
  callbacks[0]()
  expect(unregister).toHaveBeenCalledTimes(1)
})
