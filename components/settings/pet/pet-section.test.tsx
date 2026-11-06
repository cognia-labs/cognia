import { render, screen } from "@testing-library/react"

let mockParams = new URLSearchParams()
jest.mock("next/navigation", () => ({ useSearchParams: () => mockParams }))
const mockConsole = jest.fn()
jest.mock("@/components/pet/console/pet-console", () => ({
  PetConsole: (props: { initialTarget?: unknown }) => {
    mockConsole(props)
    return <div data-testid="pet-console" />
  },
}))

import DefaultPetSection, { PetSection } from "./pet-section"

beforeEach(() => {
  mockParams = new URLSearchParams()
  mockConsole.mockClear()
})

describe("PetSection", () => {
  it("is the whole console, not a pointer to another page", () => {
    render(<PetSection />)
    expect(screen.getByTestId("settings-pet-section")).toContainElement(
      screen.getByTestId("pet-console")
    )
    expect(mockConsole).toHaveBeenLastCalledWith({ initialTarget: undefined })
  })

  it("opens where the section's own params point", () => {
    mockParams = new URLSearchParams("section=pet&petTab=shop")
    render(<PetSection />)
    expect(mockConsole).toHaveBeenLastCalledWith({
      initialTarget: { view: "main", section: "shop" },
    })
  })

  it("opens the appearance sub-page, focused on the binding when asked", () => {
    mockParams = new URLSearchParams("section=pet&petView=appearance&petTab=binding")
    render(<PetSection />)
    expect(mockConsole).toHaveBeenLastCalledWith({
      initialTarget: { view: "appearance", focus: "binding" },
    })
  })

  it("is the default export too, which the pet's settings section loads", () => {
    // `components/pet/module.ui.ts` (ADR-0250 §14).
    expect(DefaultPetSection).toBe(PetSection)
  })
})
