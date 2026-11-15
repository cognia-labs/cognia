/**
 * @jest-environment jsdom
 *
 * Branch/Switch/Loop inspector forms — structured-condition authoring, the
 * case-list editor and the loop container fields.
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { BranchConfig, BreakConfig, ContinueConfig, LoopConfig, SwitchConfig } from "./index"

function lastParams(onChange: jest.Mock): Record<string, unknown> {
  return onChange.mock.calls[onChange.mock.calls.length - 1][0] as Record<string, unknown>
}

describe("BranchConfig", () => {
  it("renders the condition builder", () => {
    const onChange = jest.fn()
    render(<BranchConfig params={{}} onChange={onChange} />)
    expect(screen.getByTestId("branch-conditions-condition-builder")).toBeInTheDocument()
  })

  it("patches params.conditions when the builder changes", () => {
    const onChange = jest.fn()
    render(<BranchConfig params={{}} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("branch-conditions-add-condition"))
    const next = lastParams(onChange)
    const group = next.conditions as { conditions: unknown[] }
    expect(group.conditions).toHaveLength(1)
  })
})

describe("SwitchConfig", () => {
  it("adds a case with a generated id", () => {
    const onChange = jest.fn()
    render(<SwitchConfig params={{}} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("switch-add-case"))
    const next = lastParams(onChange)
    const cases = next.cases as Array<{ id: string; when: { conditions: unknown[] } }>
    expect(cases).toHaveLength(1)
    expect(cases[0].id).toMatch(/^c_/)
    expect(cases[0].when.conditions).toEqual([])
  })

  it("edits a case label and removes a case", () => {
    const onChange = jest.fn()
    const params = {
      cases: [
        { id: "c_a", label: "Alpha", when: { combinator: "all", conditions: [] } },
        { id: "c_b", label: "Beta", when: { combinator: "all", conditions: [] } },
      ],
    }
    render(<SwitchConfig params={params} onChange={onChange} />)
    const labelInput = screen.getByTestId("switch-case-label-0") as HTMLInputElement
    fireEvent.change(labelInput, { target: { value: "Gamma" } })
    let next = lastParams(onChange)
    expect((next.cases as Array<{ label: string }>)[0].label).toBe("Gamma")

    fireEvent.click(screen.getByTestId("switch-remove-case-1"))
    next = lastParams(onChange)
    expect(next.cases as unknown[]).toHaveLength(1)
  })

  it("nests a condition builder per case", () => {
    const onChange = jest.fn()
    const params = {
      cases: [{ id: "c_a", label: "Alpha", when: { combinator: "all", conditions: [] } }],
    }
    render(<SwitchConfig params={params} onChange={onChange} />)
    fireEvent.click(screen.getByTestId("switch-case-0-add-condition"))
    const next = lastParams(onChange)
    const cases = next.cases as Array<{ when: { conditions: unknown[] } }>
    expect(cases[0].when.conditions).toHaveLength(1)
  })
})

describe("LoopConfig", () => {
  it("renders the container form with the per-mode field", () => {
    const onChange = jest.fn()
    render(
      <LoopConfig
        params={{ mode: "forEach", source: "{{ $node['n1'].items }}" }}
        onChange={onChange}
      />
    )
    expect(screen.getByTestId("loop-mode")).toBeInTheDocument()
    expect(screen.getByTestId("loop-concurrency")).toBeInTheDocument()
  })

  it("hides concurrency for while mode (sequential by definition)", () => {
    const onChange = jest.fn()
    render(
      <LoopConfig
        params={{ mode: "while", whileExpression: "{{ $static.go }}" }}
        onChange={onChange}
      />
    )
    expect(screen.queryByTestId("loop-concurrency")).toBeNull()
  })

  it("patches iterationConcurrency as a number", () => {
    const onChange = jest.fn()
    render(<LoopConfig params={{ mode: "times", times: 3 }} onChange={onChange} />)
    fireEvent.change(screen.getByTestId("loop-concurrency"), { target: { value: "4" } })
    expect(lastParams(onChange).iterationConcurrency).toBe(4)
  })

  it("shows conditionTiming only for while mode", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig params={{ mode: "while", whileExpression: "x" }} onChange={onChange} />
    )
    expect(screen.getByTestId("loop-condition-timing")).toBeInTheDocument()
    rerender(<LoopConfig params={{ mode: "forEach", source: "y" }} onChange={onChange} />)
    expect(screen.queryByTestId("loop-condition-timing")).toBeNull()
    rerender(<LoopConfig params={{ mode: "times", times: 2 }} onChange={onChange} />)
    expect(screen.queryByTestId("loop-condition-timing")).toBeNull()
  })

  it("shows batchSize only for forEach mode and patches it as a number", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig params={{ mode: "forEach", source: "y" }} onChange={onChange} />
    )
    fireEvent.change(screen.getByTestId("loop-batch-size"), { target: { value: "5" } })
    expect(lastParams(onChange).batchSize).toBe(5)
    rerender(
      <LoopConfig params={{ mode: "forEach", source: "y", batchSize: 5 }} onChange={onChange} />
    )
    fireEvent.change(screen.getByTestId("loop-batch-size"), { target: { value: "" } })
    expect(lastParams(onChange).batchSize).toBeUndefined()
    rerender(<LoopConfig params={{ mode: "while", whileExpression: "x" }} onChange={onChange} />)
    expect(screen.queryByTestId("loop-batch-size")).toBeNull()
  })

  it("patches conditionTiming via the select and stores the default as undefined", async () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig params={{ mode: "while", whileExpression: "x" }} onChange={onChange} />
    )
    await userEvent.click(screen.getByTestId("loop-condition-timing"))
    await userEvent.click(screen.getByRole("option", { name: "Check after (do-while)" }))
    expect(lastParams(onChange).conditionTiming).toBe("post")
    rerender(
      <LoopConfig
        params={{ mode: "while", whileExpression: "x", conditionTiming: "post" }}
        onChange={onChange}
      />
    )
    await userEvent.click(screen.getByTestId("loop-condition-timing"))
    await userEvent.click(screen.getByRole("option", { name: "Check before (while)" }))
    expect(lastParams(onChange).conditionTiming).toBeUndefined()
  })

  it("switching mode away clears mode-scoped knobs (conditionTiming/batchSize)", async () => {
    const onChange = jest.fn()
    render(
      <LoopConfig
        params={{ mode: "while", whileExpression: "x", conditionTiming: "post" }}
        onChange={onChange}
      />
    )
    await userEvent.click(screen.getByTestId("loop-mode"))
    await userEvent.click(screen.getByRole("option", { name: "For each item" }))
    const next = lastParams(onChange)
    expect(next.mode).toBe("forEach")
    expect(next.conditionTiming).toBeUndefined()

    const onChange2 = jest.fn()
    render(
      <LoopConfig params={{ mode: "forEach", source: "y", batchSize: 4 }} onChange={onChange2} />
    )
    const triggers = screen.getAllByTestId("loop-mode")
    await userEvent.click(triggers[triggers.length - 1])
    await userEvent.click(screen.getByRole("option", { name: "Fixed count" }))
    const next2 = lastParams(onChange2)
    expect(next2.mode).toBe("times")
    expect(next2.batchSize).toBeUndefined()
  })

  it("authors the error policies", async () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig params={{ mode: "times", times: 2 }} onChange={onChange} />
    )
    await userEvent.click(screen.getByTestId("loop-on-item-error"))
    await userEvent.click(screen.getByRole("option", { name: "Continue with null" }))
    expect(lastParams(onChange).onItemError).toBe("continue-with-null")
    rerender(
      <LoopConfig
        params={{ mode: "times", times: 2, onItemError: "remove-failed" }}
        onChange={onChange}
      />
    )
    expect(screen.getByTestId("loop-on-item-error")).toHaveTextContent("Remove failed item")
    await userEvent.click(screen.getByTestId("loop-on-item-error"))
    await userEvent.click(screen.getByRole("option", { name: "Fail the loop" }))
    expect(lastParams(onChange).onItemError).toBeUndefined()
  })

  it("shows onItemError for every mode", () => {
    const onChange = jest.fn()
    const { rerender } = render(
      <LoopConfig params={{ mode: "forEach", source: "y" }} onChange={onChange} />
    )
    expect(screen.getByTestId("loop-on-item-error")).toBeInTheDocument()
    rerender(<LoopConfig params={{ mode: "while", whileExpression: "x" }} onChange={onChange} />)
    expect(screen.getByTestId("loop-on-item-error")).toBeInTheDocument()
    rerender(<LoopConfig params={{ mode: "times", times: 2 }} onChange={onChange} />)
    expect(screen.getByTestId("loop-on-item-error")).toBeInTheDocument()
  })
})

describe("BreakConfig / ContinueConfig", () => {
  it("render their info copy without params", () => {
    render(<BreakConfig />)
    render(<ContinueConfig />)
    // Both are static info paragraphs; presence is enough.
    expect(document.querySelectorAll("p").length).toBeGreaterThanOrEqual(2)
  })
})
