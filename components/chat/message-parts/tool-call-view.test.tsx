/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

import { ToolCallView } from "./tool-call-view"

// A function declaration hoists with the `jest.mock` factories that use it.
function mockRow(name: string) {
  return function Row(props: Record<string, unknown>) {
    return (
      <div
        data-testid={name}
        data-props={JSON.stringify({ ...props, part: undefined, onToggle: typeof props.onToggle })}
      />
    )
  }
}

jest.mock("./terminal-tool-part", () => ({ TerminalToolPart: mockRow("terminal-row") }))
jest.mock("./structured-tool-part", () => ({ StructuredToolPart: mockRow("structured-row") }))
jest.mock("./file-tool-part", () => ({
  FileToolPart: mockRow("file-row"),
  isFileToolPart: (p: { type?: string }) => p.type === "tool-Read" || p.type === "tool-Edit",
}))
jest.mock("./tool-detail-body", () => ({
  isBashToolPart: (p: { type?: string }) => p.type === "tool-Bash",
}))

const part = (type: string): ToolUIPart =>
  ({ type, toolCallId: "c1", state: "output-available", input: {} }) as unknown as ToolUIPart

const propsOf = (testId: string) =>
  JSON.parse(screen.getByTestId(testId).dataset.props ?? "{}") as Record<string, unknown>

describe("ToolCallView", () => {
  it("draws Bash with the terminal row, file tools with the file row, the rest structured", () => {
    const { unmount } = render(<ToolCallView part={part("tool-Bash")} />)
    expect(screen.getByTestId("terminal-row")).toBeInTheDocument()
    unmount()
    const second = render(<ToolCallView part={part("tool-Edit")} />)
    expect(screen.getByTestId("file-row")).toBeInTheDocument()
    second.unmount()
    render(<ToolCallView part={part("tool-WebFetch")} />)
    expect(screen.getByTestId("structured-row")).toBeInTheDocument()
  })

  it("hands the disclosure and the session to the row it draws", () => {
    render(
      <ToolCallView
        part={part("tool-Read")}
        sessionId="s1"
        defaultOpen={false}
        expanded
        onToggle={() => {}}
        memoryKey="m1"
      />
    )
    expect(propsOf("file-row")).toMatchObject({
      sessionId: "s1",
      defaultOpen: false,
      expanded: true,
      onToggle: "function",
      memoryKey: "m1",
    })
  })

  it("passes nothing it was not given, so each row keeps its own defaults", () => {
    render(<ToolCallView part={part("tool-WebFetch")} />)
    expect(Object.keys(propsOf("structured-row")).sort()).toEqual(["onToggle"])
    expect(propsOf("structured-row").onToggle).toBe("undefined")
  })
})
