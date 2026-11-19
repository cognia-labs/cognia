/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"

import type { DeploymentDiscovery, ReadyDeployment } from "@/lib/identity/deployment-discovery"
import type { CloudSessionState } from "@/lib/identity/cloud-session"
import { officialDeployment } from "@/lib/identity/official-deployment"

import type { CloudDeploymentCardDeps } from "@/components/settings/companion/cloud-deployment-card"

jest.doMock("next-intl", () => ({
  useTranslations: (ns: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      `${ns}.${key}${values ? `(${Object.values(values).join(",")})` : ""}`
    t.has = () => true
    return t
  },
}))
jest.doMock("next/navigation", () => ({ usePathname: () => "/" }))
jest.doMock("sonner", () => ({
  toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.doMock("@/lib/accounts/active-account-id", () => ({ getActiveAccountId: () => "acct_active" }))
jest.doMock("@/lib/native/opener", () => ({ openUrl: jest.fn() }))
// The default check path; tests that inject `discover` never reach it.
const mockDiscoverDeployment = jest.fn()
jest.doMock("@/lib/identity/deployment-discovery", () => ({
  ...jest.requireActual("@/lib/identity/deployment-discovery"),
  discoverDeployment: (...args: unknown[]) => mockDiscoverDeployment(...args),
}))
jest.doMock("@/lib/logto/app-session", () => ({
  signOutFromLogto: jest.fn(),
  signOutLeftTokensLive: () => false,
}))
jest.doMock("@/lib/identity/complete-sign-in", () => ({ completeSignOut: jest.fn() }))
jest.doMock("@/lib/identity/cloud-session", () => ({ readCloudSessionState: jest.fn() }))
jest.doMock("@/stores/account/account-store", () => ({
  useAccountStore: (selector: (state: unknown) => unknown) =>
    selector({ loaded: true, locked: false, unlockedAccountId: null, activeAccountId: null }),
}))

// These audit files deliberately use .probe.tsx, outside normal regression discovery.
// Load the production UI only after registering its fixture boundaries.
const { CloudDeploymentCard } = jest.requireActual(
  "@/components/settings/companion/cloud-deployment-card"
) as typeof import("@/components/settings/companion/cloud-deployment-card")

const ready: ReadyDeployment = {
  status: "ready",
  baseUrl: "https://cloud.example",
  config: {} as ReadyDeployment["config"],
  social: [
    { provider: "github", directSignIn: "social:github" },
    { provider: "feishu-web", directSignIn: "social:feishu-web" },
    { provider: "okta-custom", directSignIn: "social:okta-custom" },
  ],
  collaborationServiceUrl: "https://cloud.example/collab",
  registrationPolicy: "bootstrap-then-invite",
  webOrigin: "https://cloud.example",
}

function memory() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

function deps(overrides: Partial<CloudDeploymentCardDeps> = {}): CloudDeploymentCardDeps {
  return {
    localAccountId: "acct_a",
    discover: jest.fn(async () => ready as DeploymentDiscovery),
    readState: jest.fn(async () => ({ status: "signed-out" }) as CloudSessionState),
    signOut: jest.fn(async () => ({ endSessionUrl: null, tokensLive: false })),
    reload: jest.fn(),
    storage: { local: memory() },
    ...overrides,
  }
}

beforeEach(() => {
  sessionStorage.clear()
  jest.clearAllMocks()
})

describe("mobile official account route audit", () => {
  it("offers no official sign-in after the one-time prompt was dismissed", () => {
    const d = deps({ official: () => officialDeployment({}) })
    render(<CloudDeploymentCard deps={d} />)
    expect(screen.getByTestId("cloud-deployment-official")).toBeInTheDocument()
    expect(screen.getByTestId("cloud-deployment-form")).toBeInTheDocument()
    expect(screen.queryByTestId("cloud-deployment-sign-in")).not.toBeInTheDocument()
    expect(screen.queryByTestId("cloud-deployment-sign-out")).not.toBeInTheDocument()
    expect(d.readState).not.toHaveBeenCalled()
  })
  it("also hides official session controls for an already signed-in profile with no custom deployment", () => {
    const d = deps({
      official: () => officialDeployment({}),
      readState: jest.fn(async () => ({ status: "active" }) as CloudSessionState),
    })
    render(<CloudDeploymentCard deps={d} />)
    expect(screen.getByTestId("cloud-deployment-official")).toBeInTheDocument()
    expect(screen.queryByTestId("cloud-deployment-session")).not.toBeInTheDocument()
    expect(screen.queryByTestId("cloud-deployment-sign-out")).not.toBeInTheDocument()
    expect(d.readState).not.toHaveBeenCalled()
  })
})
