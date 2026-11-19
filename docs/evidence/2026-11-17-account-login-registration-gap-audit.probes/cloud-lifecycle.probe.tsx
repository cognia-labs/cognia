/** @jest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

jest.doMock("next/navigation", () => ({ usePathname: () => "/" }))
jest.doMock("@/lib/accounts/active-account-id", () => ({
  ...jest.requireActual("@/lib/accounts/active-account-id"),
  captureAccountScope: jest.fn(() => () => {}),
}))
jest.doMock("@/lib/platform/window-role", () => ({
  getWindowRole: () => "main",
  isSecondaryOverlayRole: () => false,
}))
jest.doMock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))
jest.doMock("@/lib/logto/app-session", () => ({
  ...jest.requireActual("@/lib/logto/app-session"),
  signOutFromLogto: jest.fn(async (deps: { afterClear?: () => Promise<void> }) => {
    await deps.afterClear?.()
    return {
      hadSession: true,
      cleared: true,
      refreshTokenRevocation: { status: "failed", reason: "issuer unreachable" },
      accessTokenRevocation: { status: "failed", reason: "issuer unreachable" },
      endSessionUrl: "https://issuer.example/logout?id_token_hint=hint",
    }
  }),
}))
jest.doMock("@/lib/identity/complete-sign-in", () => ({
  completeSignOut: jest.fn(async () => {}),
}))
jest.doMock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({
      loaded: true,
      locked: false,
      unlockedAccountId: "acct_cloud_audit",
      activeAccountId: "acct_cloud_audit",
    }),
}))

import {
  createLogtoWebPopupDrivers,
  LOGTO_CALLBACK_STATE_KEY,
  readValidatedLogtoCallback,
} from "@/lib/logto/web-popup"
import type { CloudSignInGateDeps } from "@/components/account/cloud-sign-in-gate"
// Audit probes are deliberately outside the normal *.test.tsx discovery.
// Register mocks before loading the UI rather than depending on Jest hoisting.
const { CloudSignInGate } = jest.requireActual(
  "@/components/account/cloud-sign-in-gate"
) as typeof import("@/components/account/cloud-sign-in-gate")
const { signOutFromLogto } = jest.requireMock(
  "@/lib/logto/app-session"
) as typeof import("@/lib/logto/app-session")
const { openUrl } = jest.requireMock("@/lib/native/opener") as typeof import("@/lib/native/opener")
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
  accessToken: "at",
  refreshToken: "rt",
  scopes: [],
}

function renderGate(overrides: Partial<CloudSignInGateDeps> = {}) {
  const deps: CloudSignInGateDeps = {
    discover: async () => deployment,
    readState: async () => ({ status: "signed-out" }),
    settle: async () => ({ outcome: "unaffiliated" }),
    profile: "cloud-companion",
    isCapacitor: () => false,
    ...overrides,
  }
  return render(
    <CloudSignInGate deps={deps}>
      <div>app-content</div>
    </CloudSignInGate>
  )
}

afterEach(() => {
  cleanup()
  jest.useRealTimers()
  jest.restoreAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

it("CONFIRMED: starting flow B clobbers A, and returning A consumes B's state too", () => {
  jest.spyOn(window, "open").mockReturnValue({ closed: false } as Window)
  const first = createLogtoWebPopupDrivers()
  const second = createLogtoWebPopupDrivers()
  first.openUrl("https://issuer.example/authorize?state=flow-A")
  second.openUrl("https://issuer.example/authorize?state=flow-B")
  expect(localStorage.getItem(LOGTO_CALLBACK_STATE_KEY)).toBe("flow-B")
  expect(readValidatedLogtoCallback("?code=code-A&state=flow-A")).toMatchObject({
    code: null,
    error: "state_mismatch",
  })
  expect(localStorage.getItem(LOGTO_CALLBACK_STATE_KEY)).toBeNull()
  expect(readValidatedLogtoCallback("?code=code-B&state=flow-B")).toMatchObject({
    code: null,
    error: "state_mismatch",
  })
})

it("CONFIRMED: an unrelated stale callback destroys the current login's pending state", () => {
  localStorage.setItem(LOGTO_CALLBACK_STATE_KEY, "current")
  expect(readValidatedLogtoCallback("?code=stale-code&state=stale").error).toBe("state_mismatch")
  expect(readValidatedLogtoCallback("?code=valid-code&state=current")).toMatchObject({
    code: null,
    error: "state_mismatch",
  })
})

it("CONFIRMED: closing the web login popup leaves the gate with no cancel or offline action", async () => {
  const popup = {
    closed: false,
    location: { replace: jest.fn() },
    close: jest.fn(),
  }
  jest.spyOn(window, "open").mockReturnValue(popup as unknown as Window)
  let state = ""
  let result = "pending"
  renderGate({
    signIn: async (_deployment, _method, drivers, options) => {
      state = "popup-close-probe"
      await drivers.openUrl(`https://issuer.example/authorize?state=${state}`)
      try {
        await drivers.waitForCode({ redirectUri: options.redirectUri, state })
        result = "resolved"
      } catch {
        result = "rejected"
      }
      return session
    },
  })
  fireEvent.click(await screen.findByRole("button", { name: "Continue with GitHub" }))
  await waitFor(() => expect(popup.location.replace).toHaveBeenCalled())
  jest.useFakeTimers()
  popup.closed = true
  await act(async () => {
    jest.advanceTimersByTime(10 * 60 * 1000)
  })
  expect(result).toBe("pending")
  expect(screen.getByRole("status")).toHaveTextContent("Signing in")
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
  jest.useRealTimers()
  // The exact current flow's callback is the only cleanup available to this probe.
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: window,
        data: { __cogniaLogto: true, code: "cleanup", state, error: null },
      })
    )
  })
})

it("CONFIRMED: the gate drops failed-revocation and end-session results after sign-out", async () => {
  renderGate({
    readState: async () => ({
      status: "active",
      session,
      identity: { userId: "usr_a", logtoSubject: "s", displayName: "Ada" },
    }),
  })
  fireEvent.click(await screen.findByRole("button", { name: "Sign out" }))
  await waitFor(() => expect(signOutFromLogto).toHaveBeenCalledTimes(1))
  expect(await screen.findByRole("button", { name: "Continue with GitHub" })).toBeInTheDocument()
  expect(openUrl).not.toHaveBeenCalled()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})
