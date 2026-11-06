import { render, screen } from "@testing-library/react"

import DefaultPetSection, { PetSection } from "./pet-section"

describe("PetSection", () => {
  it("points to the pet page's Appearance & settings instead of a second copy", () => {
    render(<PetSection />)
    const link = screen.getByRole("link", { name: /Open Appearance & settings/ })
    expect(link).toHaveAttribute("href", "/pet?view=appearance")
    expect(screen.queryByTestId("pet-customization-workspace")).toBeNull()
  })

  it("says what lives there", () => {
    render(<PetSection />)
    expect(screen.getByTestId("settings-pet-pointer")).toHaveTextContent(/desktop window/i)
  })

  it("is the default export too, which the pet's settings section loads", () => {
    // `components/pet/module.ui.ts` (ADR-0250 §14).
    expect(DefaultPetSection).toBe(PetSection)
  })
})
