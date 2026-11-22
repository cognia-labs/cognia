/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key
    t.has = () => true
    return t
  },
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { toast } from "sonner"

import { officialDeployment } from "@/lib/identity/official-deployment"
import {
  OfficialIdentityLinkError,
  type OfficialLinkedIdentitiesState,
} from "@/lib/identity/official-linked-identities"
import type { LogtoSession } from "@/lib/logto/client"

import { OfficialLinkedIdentities } from "./official-linked-identities"

const deployment = officialDeployment({})!

function token(sub: string): string {
  return `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`
}

const session: LogtoSession = {
  issuer: deployment.issuer,
  clientId: "cognia-app",
  resource: deployment.audience,
  accessToken: token("usr_ada"),
  scopes: ["openid", "profile", "offline_access"],
  issuerKind: "oidc",
}

const drivers = jest.fn(() => ({
  drivers: { openUrl: jest.fn(), waitForCode: jest.fn() },
  redirectUri: "cn.cognia.app:/auth/callback",
  clientKind: "native" as const,
}))

beforeEach(() => jest.clearAllMocks())

describe("OfficialLinkedIdentities", () => {
  it("protects the sole sign-in method and offers backup providers to add", async () => {
    const singleState: OfficialLinkedIdentitiesState = {
      identities: [
        {
          providerId: "feishu",
          identity: { provider: "lark", tenant: "t_1", subject: "on_1" },
          createdAt: null,
        },
      ],
      availableProviders: ["feishu", "github", "google"],
      canUnlink: false,
    }
    const afterLinkState: OfficialLinkedIdentitiesState = {
      identities: [
        ...singleState.identities,
        {
          providerId: "github",
          identity: { provider: "github", subject: "gh_2" },
          createdAt: null,
        },
      ],
      availableProviders: ["feishu", "github", "google"],
      canUnlink: true,
    }
    const link = jest.fn(async () => afterLinkState)
    const onChanged = jest.fn()

    render(
      <OfficialLinkedIdentities
        deployment={deployment}
        session={session}
        onChanged={onChanged}
        deps={{ drivers, read: jest.fn(async () => singleState), link }}
      />
    )

    expect(await screen.findByTestId("official-only-method-badge")).toBeInTheDocument()
    expect(screen.getByTestId("official-last-method-hint")).toBeInTheDocument()
    expect(screen.queryByTestId("official-unlink-feishu")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("official-link-github"))
    expect(await screen.findByTestId("official-unlink-github")).toBeInTheDocument()
    expect(link).toHaveBeenCalledWith(
      deployment,
      expect.anything(),
      { redirectUri: "cn.cognia.app:/auth/callback", clientKind: "native" },
      session,
      "github",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(toast.success).toHaveBeenCalledWith("added(github)")
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it("unlinks a secondary provider and surfaces cross-account conflict errors cleanly", async () => {
    const twoState: OfficialLinkedIdentitiesState = {
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
      availableProviders: ["feishu", "github", "google"],
      canUnlink: true,
    }
    const unlink = jest.fn(async () => ({
      identities: [twoState.identities[0]!],
      availableProviders: [
        "feishu",
        "github",
        "google",
      ] as OfficialLinkedIdentitiesState["availableProviders"],
      canUnlink: false,
    }))
    const link = jest.fn(async () => {
      throw new OfficialIdentityLinkError("identity-already-linked", "taken")
    })

    render(
      <OfficialLinkedIdentities
        deployment={deployment}
        session={session}
        deps={{
          drivers,
          read: jest.fn(async () => twoState),
          unlink,
          link,
        }}
      />
    )

    fireEvent.click(await screen.findByTestId("official-link-google"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("error.alreadyLinked(google)"))

    fireEvent.click(screen.getByTestId("official-unlink-github"))
    expect(await screen.findByTestId("official-only-method-badge")).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith("removed(github)")
  })
})
