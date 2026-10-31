import { defineAuthProvider } from "./define-auth-provider"
import { __makeSession } from "@cognia/plugin-contract/lib/plugin/auth/auth-provider-registry"
import type { PluginAuthProvider } from "../api/auth-provider"

describe("defineAuthProvider", () => {
  it("returns the provider unchanged (pure pass-through)", () => {
    const session = __makeSession({
      accessToken: "t",
      account: { id: "u", label: "U" },
      scopes: [],
    })
    const input: PluginAuthProvider = {
      id: "acme",
      label: "Acme",
      getSessions: async () => [session],
      createSession: async () => session,
      removeSession: async () => {},
    }
    const provider = defineAuthProvider(input)
    expect(provider).toBe(input)
    expect(provider.id).toBe("acme")
    expect(provider.label).toBe("Acme")
    expect(typeof provider.getSessions).toBe("function")
  })

  it("preserves Host-coordinated callbacks without invoking or scheduling them", () => {
    const exchange = jest.fn<
      ReturnType<NonNullable<PluginAuthProvider["exchange"]>>,
      Parameters<NonNullable<PluginAuthProvider["exchange"]>>
    >()
    const refresh = jest.fn<
      ReturnType<NonNullable<PluginAuthProvider["refresh"]>>,
      Parameters<NonNullable<PluginAuthProvider["refresh"]>>
    >()
    const revoke = jest.fn<
      ReturnType<NonNullable<PluginAuthProvider["revoke"]>>,
      Parameters<NonNullable<PluginAuthProvider["revoke"]>>
    >()
    const describe = jest.fn<
      ReturnType<NonNullable<PluginAuthProvider["describe"]>>,
      Parameters<NonNullable<PluginAuthProvider["describe"]>>
    >()
    const input: PluginAuthProvider = {
      id: "acme",
      label: "Acme",
      getSessions: async () => [],
      createSession: async () =>
        __makeSession({ accessToken: "t", account: { id: "u", label: "U" }, scopes: [] }),
      removeSession: async () => {},
      exchange,
      refresh,
      revoke,
      describe,
    }

    const provider = defineAuthProvider(input)
    expect(provider).toBe(input)
    for (const key of ["exchange", "refresh", "revoke", "describe"] as const) {
      expect(provider[key]).toBe(input[key])
      expect(input[key]).not.toHaveBeenCalled()
    }
  })
})
