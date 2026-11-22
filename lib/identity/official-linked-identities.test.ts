import type { LogtoDrivers, LogtoSession } from "@/lib/logto/client"

import { officialDeployment } from "./official-deployment"
import {
  OfficialIdentityLinkError,
  linkOfficialIdentity,
  readOfficialLinkedIdentities,
  unlinkOfficialIdentity,
} from "./official-linked-identities"

const deployment = officialDeployment({})!

function jwt(sub: string): string {
  return `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`
}

const currentSession: LogtoSession = {
  issuer: deployment.issuer,
  clientId: "cognia-app",
  resource: deployment.audience,
  accessToken: jwt("usr_ada"),
  scopes: ["openid", "profile", "offline_access"],
  issuerKind: "oidc",
}

const dummyDrivers: LogtoDrivers = {
  openUrl: jest.fn(),
  waitForCode: jest.fn(),
}

describe("official-linked-identities", () => {
  it("reads linked sign-in methods and available providers", async () => {
    const fetchImpl = jest.fn(async () =>
      Response.json({
        identities: [
          {
            providerId: "feishu",
            identity: { provider: "lark", tenant: "t_1", subject: "on_1" },
            createdAt: "2026-11-22T00:00:00.000Z",
          },
        ],
        availableProviders: ["feishu", "github", "google"],
        canUnlink: false,
      })
    ) as unknown as typeof fetch

    const state = await readOfficialLinkedIdentities(currentSession, { fetchImpl })
    expect(state).toEqual({
      identities: [
        {
          providerId: "feishu",
          identity: { provider: "lark", tenant: "t_1", subject: "on_1" },
          createdAt: "2026-11-22T00:00:00.000Z",
        },
      ],
      availableProviders: ["feishu", "github", "google"],
      canUnlink: false,
    })
  })

  it("re-authenticates with freshLogin, revokes the temporary refresh token, and maps last-identity on unlink", async () => {
    const revoke = jest.fn(async () => ({ status: "revoked" as const }))
    const login = jest.fn(async () => ({
      ...currentSession,
      idToken: "fresh-id-token",
      refreshToken: "temp-rt",
    }))
    const fetchImpl = jest.fn(async () =>
      Response.json(
        { error: "last_identity", error_description: "cannot remove last sign-in" },
        { status: 409 }
      )
    ) as unknown as typeof fetch

    await expect(
      unlinkOfficialIdentity(
        deployment,
        dummyDrivers,
        { redirectUri: "cn.cognia.app:/auth/callback", clientKind: "native" },
        currentSession,
        "feishu",
        { login, revoke, fetchImpl }
      )
    ).rejects.toMatchObject({
      name: "OfficialIdentityLinkError",
      code: "last-identity",
    })
    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({ freshLogin: true, clientId: "cognia-app" }),
      dummyDrivers
    )
    expect(revoke).toHaveBeenCalledWith(
      { issuer: deployment.issuer, clientId: "cognia-app" },
      "temp-rt",
      "refresh_token",
      fetchImpl
    )
  })

  it("rejects when the fresh sign-in belongs to a different person", async () => {
    const login = jest.fn(async () => ({
      ...currentSession,
      accessToken: jwt("usr_other"),
      idToken: "fresh-other",
    }))
    await expect(
      unlinkOfficialIdentity(
        deployment,
        dummyDrivers,
        { redirectUri: "cn.cognia.app:/auth/callback", clientKind: "native" },
        currentSession,
        "github",
        { login, fetchImpl: jest.fn() as unknown as typeof fetch }
      )
    ).rejects.toMatchObject({ code: "different-person" })
  })

  it("completes the PKCE link start + claim polling loop and closes the popup handle", async () => {
    const close = jest.fn()
    const openLinkWindow = jest.fn(async () => ({ isClosed: () => false, close }))
    let claimCount = 0
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/api/account/identities/link")) {
        return Response.json({
          url: "https://github.com/login/oauth/authorize?state=lnk_123",
          state: "lnk_123",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      }
      claimCount += 1
      if (claimCount === 1) {
        return Response.json({ status: "pending", provider: "github" })
      }
      return Response.json({
        status: "linked",
        provider: "github",
        identities: [
          {
            providerId: "feishu",
            identity: { provider: "lark", tenant: "t_1", subject: "on_1" },
            createdAt: null,
          },
          {
            providerId: "github",
            identity: { provider: "github", subject: "gh_2" },
            createdAt: null,
          },
        ],
        availableProviders: ["feishu", "github"],
        canUnlink: true,
      })
    }) as unknown as typeof fetch

    const result = await linkOfficialIdentity(
      deployment,
      dummyDrivers,
      { redirectUri: "https://app.cognia.cn/logto/callback", clientKind: "web" },
      currentSession,
      "github",
      {
        login: jest.fn(async () => ({ ...currentSession, idToken: "fresh-id" })),
        fetchImpl,
        openLinkWindow,
        pollIntervalMs: 5,
      }
    )

    expect(openLinkWindow).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize?state=lnk_123"
    )
    expect(close).toHaveBeenCalledTimes(1)
    expect(result.canUnlink).toBe(true)
    expect(result.identities.map((i) => i.providerId)).toEqual(["feishu", "github"])
  })

  it("maps identity_already_linked failure from claim to typed error", async () => {
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/account/identities/link")) {
        return Response.json({
          url: "https://github.com/login/oauth/authorize?state=lnk_conflict",
          state: "lnk_conflict",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        })
      }
      return Response.json({
        status: "failed",
        error: "identity_already_linked",
      })
    }) as unknown as typeof fetch

    await expect(
      linkOfficialIdentity(
        deployment,
        dummyDrivers,
        { redirectUri: "cn.cognia.app:/auth/callback", clientKind: "native" },
        currentSession,
        "github",
        {
          login: jest.fn(async () => ({ ...currentSession, idToken: "fresh-id" })),
          fetchImpl,
          openLinkWindow: jest.fn(),
          pollIntervalMs: 5,
        }
      )
    ).rejects.toEqual(
      expect.objectContaining<Partial<OfficialIdentityLinkError>>({
        code: "identity-already-linked",
      })
    )
  })
})
