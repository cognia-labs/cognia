/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/settings/pet/pet-section", () => ({
  PetSection: () => <div data-testid="stub-pet-section" />,
}))
jest.mock("@/components/mobile/me/sub-page-shell", () => ({
  SubPageShell: ({
    title,
    testid,
    children,
  }: {
    title: string
    testid: string
    children: React.ReactNode
  }) => (
    <main data-testid={testid}>
      <h1>{title}</h1>
      {children}
    </main>
  ),
}))

import Page from "./page"

describe("MobilePetPage", () => {
  it("renders the Pet settings section, which is the whole console", () => {
    render(<Page />)
    expect(screen.getByTestId("mobile-pet-page")).toContainElement(
      screen.getByTestId("stub-pet-section")
    )
  })

  it("titles the page from the mobile.me namespace", () => {
    render(<Page />)
    expect(screen.getByText("petRow")).toBeInTheDocument()
  })
})
