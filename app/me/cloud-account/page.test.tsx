/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/components/account/manage/account-identity-tab", () => ({
  AccountIdentityTab: ({ account }: { account: { id: string } }) => (
    <div data-testid="stub-identity-tab" data-account={account.id} />
  ),
}))

jest.mock("@/components/settings/companion/cloud-deployment-card", () => ({
  CloudDeploymentCard: () => <div data-testid="stub-deployment-card" />,
}))

let mockActiveAccount: { id: string; displayName: string } | null = {
  id: "acct_mobile",
  displayName: "Mobile",
}
jest.mock("@/stores/account/account-store", () => ({
  selectActiveAccount: (s: { activeAccount: typeof mockActiveAccount }) => s.activeAccount,
  useAccountStore: (selector: (s: { activeAccount: typeof mockActiveAccount }) => unknown) =>
    selector({ activeAccount: mockActiveAccount }),
}))

import Page from "./page"

beforeEach(() => {
  mockActiveAccount = { id: "acct_mobile", displayName: "Mobile" }
})

describe("MobileCloudAccountPage", () => {
  it("renders the unified AccountIdentityTab when a local profile is active", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-cloud-account-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-identity-tab")).toHaveAttribute("data-account", "acct_mobile")
    expect(screen.queryByTestId("stub-deployment-card")).not.toBeInTheDocument()
  })

  it("falls back to CloudDeploymentCard before a local profile hydrates", () => {
    mockActiveAccount = null
    render(<Page />)
    expect(screen.getByTestId("mobile-cloud-account-page")).toBeInTheDocument()
    expect(screen.getByTestId("stub-deployment-card")).toBeInTheDocument()
  })

  it("titles the page from the mobile.me namespace", () => {
    render(<Page />)
    expect(screen.getByText("cloudAccountRow")).toBeInTheDocument()
  })
})
