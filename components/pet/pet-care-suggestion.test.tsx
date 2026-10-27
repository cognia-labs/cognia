import { fireEvent, render, screen } from "@testing-library/react"

let remaining: Record<string, number> = {}
jest.mock("@/hooks/pet/use-action-cooldown", () => ({
  useActionCooldown: () => ({ remaining: (kind: string) => remaining[kind] ?? 0 }),
}))

import { PetCareSuggestion } from "./pet-care-suggestion"

beforeEach(() => {
  remaining = {}
})

describe("PetCareSuggestion", () => {
  it("names the most-needed need and offers its best care as the primary button", () => {
    const onCare = jest.fn()
    render(<PetCareSuggestion needs={{ energy: 23, mood: 80, bond: 70 }} onCare={onCare} />)
    const row = screen.getByTestId("pet-care-suggestion")
    expect(row).toHaveAttribute("data-need", "energy")
    expect(row).toHaveAttribute("data-tone", "urgent")
    expect(row).toHaveTextContent("Most needed now: Energy 23%")
    const action = screen.getByTestId("pet-care-suggestion-action")
    expect(action).toHaveTextContent("Sleep")
    fireEvent.click(action)
    expect(onCare).toHaveBeenCalledWith("slept")
  })

  it("moves to the next-best care while the best one cools down on this device", () => {
    remaining = { slept: 8_000 }
    const onCare = jest.fn()
    render(<PetCareSuggestion needs={{ energy: 23, mood: 80, bond: 70 }} onCare={onCare} />)
    fireEvent.click(screen.getByTestId("pet-care-suggestion-action"))
    expect(onCare).toHaveBeenCalledWith("fed")
  })

  it("reads the caller's cooldown when given (remote care)", () => {
    render(
      <PetCareSuggestion
        needs={{ energy: 90, mood: 30, bond: 70 }}
        onCare={jest.fn()}
        cooldownRemaining={() => 4_200}
      />
    )
    const action = screen.getByTestId("pet-care-suggestion-action")
    expect(action).toBeDisabled()
    expect(action).toHaveTextContent("Play in 5s")
  })

  it("says the pet is doing well when nothing needs care", () => {
    render(
      <PetCareSuggestion
        needs={{ energy: 90, mood: 80, bond: 70 }}
        onCare={jest.fn()}
        petName="Boba"
      />
    )
    const row = screen.getByTestId("pet-care-suggestion")
    expect(row).toHaveAttribute("data-status", "content")
    expect(row).toHaveTextContent("Boba is doing well")
    expect(screen.queryByTestId("pet-care-suggestion-action")).toBeNull()
  })
})
