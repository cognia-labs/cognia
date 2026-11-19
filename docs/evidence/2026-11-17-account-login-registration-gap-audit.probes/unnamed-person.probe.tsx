/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
jest.doMock("next/navigation", () => ({ usePathname: () => "/" }))
jest.doMock("@/lib/platform/window-role", () => ({
  getWindowRole: () => "main",
  isSecondaryOverlayRole: () => false,
}))
jest.doMock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({
      loaded: true,
      locked: false,
      unlockedAccountId: "local_acct_a",
      activeAccountId: "local_acct_a",
    }),
}))
const { CloudSignInGate } = jest.requireActual(
  "@/components/account/cloud-sign-in-gate"
) as typeof import("@/components/account/cloud-sign-in-gate")
import { getDb } from "@/lib/db/schema"
import { readLogtoIdentity } from "@/lib/identity/logto-claims"
import { resolveIdentityFromClaims } from "@/lib/identity/sign-in"
import type { ReadyDeployment } from "@/lib/identity/deployment-discovery"
import type { LogtoSession } from "@/lib/logto/client"

const deployment: ReadyDeployment = {
  status: "ready",
  baseUrl: "https://host.example",
  config: {
    deploymentMode: "multi-tenant",
    hostId: "h",
    oidc: { issuer: "https://issuer.example", webClientId: "w", audience: "a", scopes: [] },
  } as unknown as ReadyDeployment["config"],
  social: [{ provider: "github", directSignIn: "social:github" }],
  collaborationServiceUrl: "https://collab.example",
  registrationPolicy: "bootstrap-then-invite",
  webOrigin: null,
}
const session: LogtoSession = {
  issuer: "https://issuer.example",
  clientId: "w",
  resource: "a",
  accessToken: `h.${Buffer.from(JSON.stringify({ sub: "subject-without-profile", exp: 9999999999 })).toString("base64url")}.s`,
  idToken: `h.${Buffer.from(JSON.stringify({ sub: "subject-without-profile" })).toString("base64url")}.s`,
  refreshToken: "rt",
  scopes: [],
}

afterEach(() => cleanup())
it("a valid subject-only fresh sign-in omits the only sign-out and offline controls", async () => {
  await getDb().open()
  const identity = readLogtoIdentity(session)!
  expect(
    (await resolveIdentityFromClaims(identity, session.issuer, Date.now())).user.displayName
  ).toBe("subject-without-profile")
  const popup = { closed: false, close: jest.fn(), location: { replace: jest.fn() } }
  jest.spyOn(window, "open").mockReturnValue(popup as unknown as Window)
  render(
    <CloudSignInGate
      deps={{
        discover: async () => deployment,
        readState: async () => ({ status: "signed-out" }),
        signIn: async () => session,
        settle: async () => ({ outcome: "unaffiliated" }),
        profile: "cloud-companion",
        isCapacitor: () => false,
      }}
    >
      <div>app-content</div>
    </CloudSignInGate>
  )
  fireEvent.click(await screen.findByRole("button", { name: "Continue with GitHub" }))
  expect(
    await screen.findByRole("heading", {
      name: "You are signed in, but not in an organization yet",
    })
  ).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "Continue offline" })).not.toBeInTheDocument()
  getDb().close()
})
