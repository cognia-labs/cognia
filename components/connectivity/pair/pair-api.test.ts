/** @jest-environment jsdom */

import { encodePairPayload } from "@/lib/qr/pair-payload"
import { fetchCompanionAuthConfig, registerCompanionDevice } from "@/lib/tauri/companion-auth"
import { getActiveLogtoSession, signInToLogto, updateLogtoSession } from "@/lib/logto/app-session"
import { captureAccountScope, getActiveAccountId } from "@/lib/accounts/active-account-id"
import { completeSignIn } from "@/lib/identity/complete-sign-in"
import { assertSignedInIdentityOwner } from "@/lib/identity/sign-in"

import { registerDecodedPairPayload, registerPairPayload } from "./pair-api"

jest.mock("@/lib/tauri/companion-auth", () => ({
  registerCompanionDevice: jest.fn(),
  fetchCompanionAuthConfig: jest.fn(),
  authConfigIssuerKind: jest.requireActual("@/lib/tauri/companion-auth").authConfigIssuerKind,
}))
jest.mock("@/lib/logto/app-session", () => ({
  getActiveLogtoSession: jest.fn(),
  signInToLogto: jest.fn(),
  updateLogtoSession: jest.fn(),
}))
jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: jest.fn(),
  captureAccountScope: jest.fn(),
}))
jest.mock("@/lib/identity/complete-sign-in", () => ({ completeSignIn: jest.fn() }))
jest.mock("@/lib/identity/sign-in", () => ({ assertSignedInIdentityOwner: jest.fn() }))
jest.mock("@/lib/logto/web-popup", () => ({
  createLogtoWebPopupDrivers: () => ({ flavour: "popup" }),
}))
jest.mock("@/lib/logto/capacitor-drivers", () => ({
  createLogtoCapacitorDrivers: () => ({ flavour: "capacitor" }),
}))
let capacitorShell = false
jest.mock("@/lib/platform/detect", () => ({ isCapacitor: () => capacitorShell }))
jest.mock("@/lib/device/device-identity", () => ({
  getLocalDeviceConsoleLabel: async () => "Test phone",
}))

const register = registerCompanionDevice as jest.MockedFunction<typeof registerCompanionDevice>
const activeSession = getActiveLogtoSession as jest.MockedFunction<typeof getActiveLogtoSession>
const authConfig = fetchCompanionAuthConfig as jest.MockedFunction<typeof fetchCompanionAuthConfig>
const signIn = signInToLogto as jest.MockedFunction<typeof signInToLogto>
const updateSession = jest.mocked(updateLogtoSession)
const activeProfile = jest.mocked(getActiveAccountId)
const captureScope = jest.mocked(captureAccountScope)
const assertScope = jest.fn<void, []>()
const complete = jest.mocked(completeSignIn)
const validateOwner = jest.mocked(assertSignedInIdentityOwner)
const payload = {
  baseUrl: "https://host.local:27890",
  mode: "owner-invitation" as const,
  invitation: "owner-invitation",
  hostId: "host-1",
  tenantId: "tenant-1",
  expiresAt: Date.now() + 60_000,
  serverVersion: "1.2.3",
  fingerprint: "ab".repeat(32),
}
const config = {
  baseUrl: payload.baseUrl,
  deviceId: "device-1",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "secret" },
  deviceKeyThumbprint: "thumbprint",
  accountId: payload.tenantId,
  serverVersion: payload.serverVersion,
}

beforeEach(() => {
  register.mockReset()
  activeSession.mockReset()
  authConfig.mockReset()
  signIn.mockReset()
  activeProfile.mockReturnValue("acct_pair")
  assertScope.mockReset()
  captureScope.mockReset().mockReturnValue(assertScope)
  complete.mockReset().mockResolvedValue({} as never)
  validateOwner.mockReset().mockResolvedValue(undefined)
  updateSession.mockReset().mockImplementation(async (_previous, update, options) => {
    const candidate = await update()
    await options?.beforeCommit?.(candidate)
    await options?.afterCommit?.(candidate, { assertCurrent: () => {} })
    return candidate
  })
})

it("registers the invitation through the canonical device-key flow", async () => {
  register.mockResolvedValue(config)
  await expect(registerPairPayload(encodePairPayload(payload))).resolves.toEqual({
    kind: "ok",
    config: { ...config, targetId: payload.hostId },
    path: "direct",
  })
  expect(register).toHaveBeenCalledWith(
    {
      baseUrl: payload.baseUrl,
      mode: payload.mode,
      invitation: payload.invitation,
      hostId: payload.hostId,
      tenantId: payload.tenantId,
      displayName: "Test phone",
      serverVersion: payload.serverVersion,
      serverFingerprint: payload.fingerprint,
    },
    undefined
  )
})

it("refuses pairing when a reused session belongs to another profile owner", async () => {
  register.mockResolvedValue(config)
  activeSession.mockResolvedValue({
    issuer: "https://id.example/oidc",
    clientId: "web-client",
    resource: "https://host.example/api",
    accessToken: "oidc-access",
    scopes: ["openid"],
  })
  validateOwner.mockRejectedValue(new Error("profile belongs to another person"))

  await expect(
    registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })
  ).resolves.toMatchObject({
    kind: "registration_error",
    message: "profile belongs to another person",
  })
  expect(register).not.toHaveBeenCalled()
  expect(complete).not.toHaveBeenCalled()
})

it("does not bind or register a reused session superseded by logout", async () => {
  const session = {
    issuer: "https://id.example/oidc",
    clientId: "web-client",
    resource: "https://host.example/api",
    accessToken: "oidc-access",
    scopes: ["openid"],
  }
  activeSession.mockResolvedValue(session)
  register.mockResolvedValue(config)
  updateSession.mockRejectedValue(new Error("authentication operation superseded"))

  await expect(
    registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })
  ).resolves.toMatchObject({
    kind: "registration_error",
    message: "authentication operation superseded",
  })
  expect(updateSession).toHaveBeenCalledWith(session, expect.any(Function), {
    localAccountId: "acct_pair",
    beforeCommit: expect.any(Function),
    afterCommit: expect.any(Function),
  })
  expect(validateOwner).not.toHaveBeenCalled()
  expect(complete).not.toHaveBeenCalled()
  expect(register).not.toHaveBeenCalled()
})

it.each(["before validation", "during validation", "before binding"])(
  "rejects reused pairing credentials when local scope expires %s",
  async (changeAt) => {
    const session = {
      issuer: "https://id.example/oidc",
      clientId: "web-client",
      resource: "https://host.example/api",
      accessToken: "oidc-access",
      scopes: ["openid"],
    }
    const invalidate = () => {
      assertScope.mockImplementation(() => {
        throw new Error("local account scope changed")
      })
    }
    activeSession.mockResolvedValue(session)
    register.mockResolvedValue(config)
    if (changeAt === "before validation") invalidate()
    if (changeAt === "during validation") validateOwner.mockImplementation(async () => invalidate())
    if (changeAt === "before binding") {
      updateSession.mockImplementation(async (_previous, update, options) => {
        const candidate = await update()
        await options?.beforeCommit?.(candidate)
        invalidate()
        await options?.afterCommit?.(candidate, { assertCurrent: () => {} })
        return candidate
      })
    }

    await expect(
      registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })
    ).resolves.toMatchObject({
      kind: "registration_error",
      message: "local account scope changed",
    })
    expect(captureScope).toHaveBeenCalledWith("acct_pair")
    if (changeAt === "before validation") expect(validateOwner).not.toHaveBeenCalled()
    else expect(validateOwner).toHaveBeenCalledTimes(1)
    expect(complete).not.toHaveBeenCalled()
    expect(register).not.toHaveBeenCalled()
  }
)

it("validates a fresh session before commit using the profile captured before asynchronous work", async () => {
  const session = {
    issuer: "https://id.example/oidc",
    clientId: "web-client",
    resource: "https://host.example/api",
    accessToken: "oidc-access",
    scopes: ["openid"],
  }
  activeSession.mockImplementation(async () => {
    activeProfile.mockReturnValue("acct_other")
    return null
  })
  authConfig.mockResolvedValue({
    deploymentMode: "multi-tenant",
    hostId: payload.hostId,
    oidc: {
      issuer: session.issuer,
      audience: session.resource,
      webClientId: session.clientId,
      scopes: ["openid"],
    },
    signaling: { url: "wss://host.example/signaling", iceServers: [] },
  })
  signIn.mockImplementation(async (_config, _drivers, deps) => {
    await deps?.beforeCommit?.(session)
    await deps?.afterCommit?.(session, { assertCurrent: () => {} })
    return session
  })
  register.mockResolvedValue(config)

  await expect(
    registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })
  ).resolves.toMatchObject({ kind: "ok" })

  expect(signIn.mock.calls[0][2]).toEqual({
    localAccountId: "acct_pair",
    beforeCommit: expect.any(Function),
    afterCommit: expect.any(Function),
  })
  expect(validateOwner).toHaveBeenCalledWith(session, { localAccountId: "acct_pair" })
  expect(complete).toHaveBeenCalledWith(session, {
    localAccountId: "acct_pair",
    assertCurrent: expect.any(Function),
  })
  expect(validateOwner.mock.invocationCallOrder[0]).toBeLessThan(
    complete.mock.invocationCallOrder[0]
  )
  expect(complete.mock.invocationCallOrder[0]).toBeLessThan(register.mock.invocationCallOrder[0])
})

it("reuses the active OIDC session for an oidc pairing", async () => {
  const session = {
    issuer: "https://id.example/oidc",
    clientId: "web-client",
    resource: "https://host.example/api",
    organizationId: payload.tenantId,
    accessToken: "oidc-access",
    scopes: ["openid"],
  }
  activeSession.mockResolvedValue(session)
  register.mockResolvedValue(config)

  await registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })

  expect(register).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "oidc", invitation: undefined, oidc: session }),
    undefined
  )
  expect(activeSession).toHaveBeenCalledWith({ localAccountId: "acct_pair" })
  expect(complete).toHaveBeenCalledWith(session, {
    localAccountId: "acct_pair",
    assertCurrent: expect.any(Function),
  })
  expect(validateOwner).toHaveBeenCalledWith(session, { localAccountId: "acct_pair" })
  expect(validateOwner.mock.invocationCallOrder[0]).toBeLessThan(
    complete.mock.invocationCallOrder[0]
  )
})

it("starts canonical Logto PKCE when an oidc pairing has no active session", async () => {
  const session = {
    issuer: "https://id.example/oidc",
    clientId: "web-client",
    resource: "https://host.example/api",
    organizationId: payload.tenantId,
    accessToken: "oidc-access",
    scopes: ["openid"],
  }
  activeSession.mockResolvedValue(null)
  authConfig.mockResolvedValue({
    deploymentMode: "multi-tenant",
    hostId: payload.hostId,
    oidc: {
      issuer: session.issuer,
      audience: session.resource,
      webClientId: session.clientId,
      scopes: ["openid", "offline_access"],
    },
    signaling: { url: "wss://host.example/signaling", iceServers: [] },
  })
  signIn.mockResolvedValue(session)
  register.mockResolvedValue(config)

  await registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })

  expect(signIn).toHaveBeenCalledWith(
    expect.objectContaining({
      issuer: session.issuer,
      clientId: session.clientId,
      resource: session.resource,
      organizationId: payload.tenantId,
      redirectUri: `${window.location.origin}/logto/callback`,
      // The gate adopts an organization by refreshing this very session, and
      // Logto only honours that for a session that asked for the scope.
      scopes: ["openid", "offline_access", "urn:logto:scope:organizations"],
    }),
    { flavour: "popup" },
    {
      localAccountId: "acct_pair",
      beforeCommit: expect.any(Function),
      afterCommit: expect.any(Function),
    }
  )
  expect(register).toHaveBeenCalledWith(expect.objectContaining({ oidc: session }), undefined)
})

it("signs in through the in-app browser and the native application on Capacitor", async () => {
  capacitorShell = true
  try {
    activeSession.mockResolvedValue(null)
    authConfig.mockResolvedValue({
      deploymentMode: "multi-tenant",
      hostId: payload.hostId,
      oidc: {
        issuer: "https://id.example/oidc",
        audience: "https://host.example/api",
        webClientId: "web-client",
        nativeClientId: "native-client",
        scopes: ["openid"],
      },
      signaling: { url: "wss://host.example/signaling", iceServers: [] },
    })
    signIn.mockResolvedValue({
      issuer: "https://id.example/oidc",
      clientId: "native-client",
      resource: "https://host.example/api",
      accessToken: "oidc-access",
      scopes: ["openid"],
    })
    register.mockResolvedValue(config)

    await registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })

    expect(signIn).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "native-client",
        redirectUri: "cognia://logto/callback",
      }),
      { flavour: "capacitor" },
      {
        localAccountId: "acct_pair",
        beforeCommit: expect.any(Function),
        afterCommit: expect.any(Function),
      }
    )
  } finally {
    capacitorShell = false
  }
})

it("gives a generic OIDC issuer the reverse-domain callback and no organizations scope", async () => {
  capacitorShell = true
  try {
    activeSession.mockResolvedValue(null)
    authConfig.mockResolvedValue({
      deploymentMode: "multi-tenant",
      hostId: payload.hostId,
      oidc: {
        issuer: "https://id.cognia.test/api/auth",
        audience: "https://sync.cognia.test",
        webClientId: "web-client",
        nativeClientId: "native-client",
        scopes: ["openid"],
        issuerKind: "oidc",
      },
      signaling: { url: "wss://host.example/signaling", iceServers: [] },
    })
    signIn.mockResolvedValue({
      issuer: "https://id.cognia.test/api/auth",
      clientId: "native-client",
      resource: "https://sync.cognia.test",
      accessToken: "oidc-access",
      scopes: ["openid"],
    })
    register.mockResolvedValue(config)

    await registerDecodedPairPayload({ ...payload, mode: "oidc", invitation: undefined })

    expect(signIn).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "native-client",
        redirectUri: "cn.cognia.app:/auth/callback",
        scopes: ["openid"],
        issuerKind: "oidc",
      }),
      { flavour: "capacitor" },
      {
        localAccountId: "acct_pair",
        beforeCommit: expect.any(Function),
        afterCommit: expect.any(Function),
      }
    )
  } finally {
    capacitorShell = false
  }
})

it("rejects old and malformed payloads without registering", async () => {
  await expect(registerPairPayload("cgnp2|legacy")).resolves.toMatchObject({
    kind: "invalid_payload",
  })
  await expect(registerPairPayload("not-cognia")).resolves.toMatchObject({
    kind: "invalid_payload",
  })
  expect(register).not.toHaveBeenCalled()
})

it("normalizes registration failures and keeps the cause for classification", async () => {
  const cause = new Error("invitation already consumed")
  register.mockRejectedValue(cause)
  await expect(registerDecodedPairPayload(payload)).resolves.toEqual({
    kind: "registration_error",
    message: "invitation already consumed",
    error: cause,
    baseUrl: payload.baseUrl,
  })
})

it("hands the decode outcome back so the caller can name the exact payload fault", async () => {
  await expect(registerPairPayload("cgnp2|legacy")).resolves.toMatchObject({
    kind: "invalid_payload",
    outcome: { kind: "version_mismatch", got: 2 },
  })
  await expect(registerPairPayload("not-cognia")).resolves.toMatchObject({
    kind: "invalid_payload",
    outcome: { kind: "wrong_format" },
  })
})

describe("relay pairing path (ADR-0170)", () => {
  const relay = {
    url: "wss://signaling.test/signaling",
    room: {
      v: 2 as const,
      roomId: "room-1",
      roomNonce: "nonce",
      desktopSigningKey: "desktop",
      mobileSigningKey: "mobile",
      notAfter: Date.now() + 60_000,
    },
    mobilePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "d", x: "x", y: "y" },
  }

  it("falls back to the relay room when the Host does not answer directly", async () => {
    register.mockResolvedValue(config)
    const relayFetcher = jest.fn()
    const close = jest.fn()
    const createRelayFetcher = jest.fn(async () => ({ fetcher: relayFetcher, close }))
    const result = await registerPairPayload(encodePairPayload({ ...payload, relay }), undefined, {
      createRelayFetcher,
      probeDirect: async () => false,
    })
    expect(result).toEqual({
      kind: "ok",
      config: { ...config, targetId: payload.hostId, signalingUrl: relay.url },
      path: "relay",
    })
    expect(createRelayFetcher).toHaveBeenCalledWith(relay)
    // Registration ran through the relay's fetcher, and the room was left.
    expect(register.mock.calls[0][1]).toBe(relayFetcher)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("stays direct when the Host answers, even with a relay in the invitation", async () => {
    register.mockResolvedValue(config)
    const createRelayFetcher = jest.fn()
    const result = await registerPairPayload(encodePairPayload({ ...payload, relay }), undefined, {
      createRelayFetcher,
      probeDirect: async () => true,
    })
    expect(result).toMatchObject({ kind: "ok", path: "direct" })
    expect(createRelayFetcher).not.toHaveBeenCalled()
  })

  it("reports a relay room the Host never joined as a registration error", async () => {
    const result = await registerPairPayload(encodePairPayload({ ...payload, relay }), undefined, {
      createRelayFetcher: async () => {
        throw new Error("no peer joined the rendezvous within the wait window")
      },
      probeDirect: async () => false,
    })
    expect(result).toMatchObject({ kind: "registration_error", message: /no peer joined/ })
    expect(register).not.toHaveBeenCalled()
  })
})
