/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TierSegmentedControl } from "./tier-segmented-control"

const OPTIONS = [
  { value: "off", label: "Off" },
  { value: "whitelist", label: "Whitelist" },
  { value: "perCall", label: "Per call" },
] as const

describe("TierSegmentedControl", () => {
  it("presses exactly the stored value", () => {
    render(
      <TierSegmentedControl
        value="whitelist"
        options={OPTIONS}
        onChange={jest.fn()}
        ariaLabel="Tier"
      />
    )
    expect(screen.getByRole("radio", { name: "Whitelist" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("radio", { name: "Off" })).toHaveAttribute("aria-checked", "false")
  })

  it("reports a new choice", async () => {
    const onChange = jest.fn()
    render(
      <TierSegmentedControl value="off" options={OPTIONS} onChange={onChange} ariaLabel="Tier" />
    )
    await userEvent.click(screen.getByRole("radio", { name: "Per call" }))
    expect(onChange).toHaveBeenCalledWith("perCall")
  })

  it("never reports an empty value when the pressed item is clicked again", async () => {
    const onChange = jest.fn()
    render(
      <TierSegmentedControl value="off" options={OPTIONS} onChange={onChange} ariaLabel="Tier" />
    )
    await userEvent.click(screen.getByRole("radio", { name: "Off" }))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("renders nothing pressed for a value no option names", () => {
    render(
      <TierSegmentedControl value={null} options={OPTIONS} onChange={jest.fn()} ariaLabel="Tier" />
    )
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-checked", "false")
    }
  })

  it("disables every segment while saving", () => {
    render(
      <TierSegmentedControl
        value="off"
        options={OPTIONS}
        onChange={jest.fn()}
        ariaLabel="Tier"
        disabled
      />
    )
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled()
  })
})
