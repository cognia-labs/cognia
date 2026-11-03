import {
  requestConnectionPrompt,
  resolveConnectionPrompt,
  subscribeConnectionPrompts,
  type ConnectionPromptState,
} from "./connection-prompts"
import type { AuthConnectionRef } from "@cognia/plugin-contract/types/plugin/plugin-auth"

it("dismisses immediately with no prompt surface", async () => {
  await expect(
    requestConnectionPrompt({ kind: "picker", pluginId: "p", pluginName: "P", candidates: [] })
  ).resolves.toEqual({ kind: "dismissed" })
})

it("removes a cancelled configuration prompt without disturbing the active request", async () => {
  let state!: ConnectionPromptState
  const dispose = subscribeConnectionPrompts((value) => {
    state = value
  })
  const controller = new AbortController()
  try {
    const first = requestConnectionPrompt({
      kind: "picker",
      pluginId: "p",
      pluginName: "P",
      candidates: [],
    })
    const second = requestConnectionPrompt(
      {
        kind: "configure",
        pluginId: "p",
        pluginName: "P",
        providerLabel: "P",
        schema: { type: "object", properties: {} },
        issuers: [],
        methods: ["oauth-pkce"],
        defaults: {},
      },
      controller.signal
    )
    const id = state.current!.id
    controller.abort()
    await expect(second).resolves.toEqual({ kind: "dismissed" })
    expect(state.current?.id).toBe(id)
    expect(state.queue).toEqual([])
    resolveConnectionPrompt(id, { kind: "dismissed" })
    await first
  } finally {
    dispose()
  }
})

it("refuses configuration results for a non-configuration prompt", async () => {
  let state!: ConnectionPromptState
  const dispose = subscribeConnectionPrompts((value) => {
    state = value
  })
  try {
    const pending = requestConnectionPrompt({
      kind: "connect-error",
      pluginId: "p",
      pluginName: "P",
      reason: "identity-conflict",
    })
    resolveConnectionPrompt(state.current!.id, {
      kind: "configured",
      method: "client-credentials",
      configuration: { appId: "forged" },
    })
    expect(state.current?.kind).toBe("connect-error")
    resolveConnectionPrompt(state.current!.id, { kind: "dismissed" })
    await expect(pending).resolves.toEqual({ kind: "dismissed" })
  } finally {
    dispose()
  }
})

it("accepts reconnect only on an add-scope prompt and dismisses it without a Host", async () => {
  const request = {
    kind: "add-scopes" as const,
    pluginId: "p",
    pluginName: "P",
    scopes: ["write"],
    connection: {
      ref: "ref" as AuthConnectionRef,
      providerId: "vendor",
      accountLabel: "Account",
      issuer: "https://issuer.test",
      principalKind: "user" as const,
      status: "connected" as const,
      scopes: ["read"],
      revision: 1,
    },
  }
  await expect(requestConnectionPrompt(request)).resolves.toEqual({ kind: "dismissed" })
  let state!: ConnectionPromptState
  const stop = subscribeConnectionPrompts((value) => {
    state = value
  })
  try {
    const pending = requestConnectionPrompt(request)
    const id = state.current!.id
    resolveConnectionPrompt(id, { kind: "approved" })
    expect(state.current?.id).toBe(id)
    resolveConnectionPrompt(id, { kind: "sign-in" })
    expect(state.current?.id).toBe(id)
    resolveConnectionPrompt(id, { kind: "reconnect" })
    await expect(pending).resolves.toEqual({ kind: "reconnect" })
  } finally {
    stop()
  }
})

it("allows only the sign-in decision on a sign-in prompt", async () => {
  let state!: ConnectionPromptState
  const dispose = subscribeConnectionPrompts((value) => {
    state = value
  })
  try {
    const pending = requestConnectionPrompt({
      kind: "sign-in",
      pluginId: "p",
      pluginName: "P",
      providerId: "vendor",
      providerLabel: "Vendor",
      scopes: [],
    })
    const id = state.current!.id
    resolveConnectionPrompt(id, { kind: "approved" })
    expect(state.current?.id).toBe(id)
    resolveConnectionPrompt(id, { kind: "selected", ref: "forged" as AuthConnectionRef })
    expect(state.current?.id).toBe(id)
    resolveConnectionPrompt(id, { kind: "sign-in" })
    await expect(pending).resolves.toEqual({ kind: "sign-in" })
  } finally {
    dispose()
  }
})

it("queues, rejects answers to a queued prompt and dismisses everything on unmount", async () => {
  let state!: ConnectionPromptState
  const dispose = subscribeConnectionPrompts((value) => {
    state = value
  })
  const request = { kind: "picker" as const, pluginId: "p", pluginName: "P", candidates: [] }
  const first = requestConnectionPrompt(request)
  const second = requestConnectionPrompt(request)
  expect(state.queue).toHaveLength(1)
  const id = state.current!.id
  resolveConnectionPrompt(state.queue[0].id, { kind: "dismissed" })
  expect(state.current!.id).toBe(id)
  resolveConnectionPrompt(id, { kind: "selected", ref: "forged" as AuthConnectionRef })
  expect(state.current!.id).toBe(id)
  resolveConnectionPrompt(id, { kind: "approved" })
  expect(state.current!.id).toBe(id)
  resolveConnectionPrompt(id, { kind: "dismissed" })
  await expect(first).resolves.toEqual({ kind: "dismissed" })
  expect(state.current!.id).not.toBe(id)
  dispose()
  await expect(second).resolves.toEqual({ kind: "dismissed" })
})
it("preserves the Host-selected initial method and provider requirements in a configure prompt", async () => {
  let state!: ConnectionPromptState
  const dispose = subscribeConnectionPrompts((value) => {
    state = value
  })
  try {
    const pending = requestConnectionPrompt({
      kind: "configure",
      pluginId: "p",
      pluginName: "P",
      providerLabel: "Provider",
      methods: ["api-key", "oauth-pkce"],
      initialMethod: "oauth-pkce",
      providerDefinition: { id: "vendor", label: "Vendor", methods: ["api-key", "oauth-pkce"] },
      schema: { type: "object", properties: {} },
      defaults: {},
      issuers: [],
    })
    expect(state.current).toMatchObject({
      initialMethod: "oauth-pkce",
      providerDefinition: { id: "vendor" },
    })
    resolveConnectionPrompt(state.current!.id, { kind: "dismissed" })
    await expect(pending).resolves.toEqual({ kind: "dismissed" })
  } finally {
    dispose()
  }
})
