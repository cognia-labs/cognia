/**
 * @jest-environment jsdom
 */
import React from "react"
import { render, screen, within } from "@testing-library/react"

import { CodeRunCallList } from "./code-run-calls"
import type { CodeRunCall } from "@/lib/chat/code-run-calls"

const CALLS: CodeRunCall[] = [
  { id: "p/1", ordinal: 1, tool: "grep", state: "succeeded", durationMs: 42, resultBytes: 512 },
  { id: "p/2", ordinal: 2, tool: "read", state: "failed", failure: "not-found", durationMs: 3 },
  { id: "p/3", ordinal: 3, tool: "glob", state: "running" },
]

function rows() {
  return screen.getAllByTestId("code-run-call")
}

describe("CodeRunCallList", () => {
  it("lists each nested call with its place, tool and outcome", () => {
    render(<CodeRunCallList calls={CALLS} settled={false} />)
    expect(screen.getByText("3 tool calls from the program")).toBeTruthy()
    const [first, second, third] = rows()
    expect(within(first!).getByText("grep")).toBeTruthy()
    // The test formatter prints bare numbers; the duration comes from the
    // shared short formatter.
    expect(within(first!).getByText("42ms · 512")).toBeTruthy()
    expect(within(second!).getByText("Not found")).toBeTruthy()
    expect(third!.getAttribute("data-state")).toBe("running")
    expect(third!.getAttribute("aria-label")).toBe("Call 3: glob, Running")
  })

  // A call the program was still waiting on when it ended did not finish; it
  // was stopped with the program.
  it("shows a call still running when the program ended as stopped", () => {
    render(<CodeRunCallList calls={CALLS} settled />)
    const third = rows()[2]!
    expect(third.getAttribute("data-state")).toBe("stopped")
    expect(within(third).getByText("Stopped with the program")).toBeTruthy()
  })

  it("names a failure kind it has no label for as a plain failure", () => {
    render(
      <CodeRunCallList
        calls={[{ id: "p/1", ordinal: 1, tool: "read", state: "failed", failure: "brand-new" }]}
        settled
      />
    )
    expect(screen.getByText("Failed")).toBeTruthy()
  })

  it("scales a large result into a larger unit", () => {
    render(
      <CodeRunCallList
        calls={[{ id: "p/1", ordinal: 1, tool: "read", state: "succeeded", resultBytes: 2048 }]}
        settled
      />
    )
    expect(screen.getByText("2")).toBeTruthy()
  })
})
