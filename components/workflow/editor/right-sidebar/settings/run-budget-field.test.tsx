/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useState } from "react"

import enMessages from "@/i18n/messages/en.json"

import { parseRunBudget, RunBudgetField } from "./run-budget-field"

function Harness({ initial, onChange }: { initial?: number; onChange: jest.Mock }) {
  const [value, setValue] = useState(initial)
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RunBudgetField
        value={value}
        onChange={(next) => {
          onChange(next)
          setValue(next)
        }}
      />
      <button type="button" onClick={() => setValue(9)}>
        external
      </button>
    </NextIntlClientProvider>
  )
}

describe("parseRunBudget", () => {
  it("reads a positive number and treats everything else as no limit", () => {
    expect(parseRunBudget("1.25")).toBe(1.25)
    expect(parseRunBudget("")).toBeUndefined()
    expect(parseRunBudget("  ")).toBeUndefined()
    expect(parseRunBudget("0")).toBeUndefined()
    expect(parseRunBudget("-2")).toBeUndefined()
    expect(parseRunBudget("abc")).toBeUndefined()
  })
})

describe("RunBudgetField", () => {
  it("labels the field and shows no limit by default", () => {
    render(<Harness onChange={jest.fn()} />)
    const input = screen.getByLabelText("Run budget (USD)")
    expect(input).toHaveValue(null)
    expect(input).toHaveAttribute("placeholder", "No limit")
  })

  it("keeps an intermediate value while it is being typed", () => {
    const onChange = jest.fn()
    render(<Harness onChange={onChange} />)
    const input = screen.getByTestId("wf-max-cost")

    fireEvent.change(input, { target: { value: "0" } })
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    expect(input).toHaveValue(0)
    fireEvent.change(input, { target: { value: "0.5" } })
    expect(onChange).toHaveBeenLastCalledWith(0.5)
    expect(input).toHaveValue(0.5)
  })

  it("shows a value changed elsewhere", () => {
    render(<Harness initial={2} onChange={jest.fn()} />)
    expect(screen.getByTestId("wf-max-cost")).toHaveValue(2)
    fireEvent.click(screen.getByText("external"))
    expect(screen.getByTestId("wf-max-cost")).toHaveValue(9)
  })
})
