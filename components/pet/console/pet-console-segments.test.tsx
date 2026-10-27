import { fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"
import { PetConsoleSegments } from "./pet-console-segments"

function Harness({ desktopOnly = false }: { desktopOnly?: boolean }) {
  const [value, setValue] = useState<"a" | "b">("a")
  return (
    <PetConsoleSegments
      testId="segments"
      label="Things"
      value={value}
      onValueChange={setValue}
      segments={[
        { id: "a", label: "Alpha", content: () => <div data-testid="content-a" /> },
        { id: "b", label: "Beta", desktopOnly, content: () => <div data-testid="content-b" /> },
      ]}
    />
  )
}

describe("PetConsoleSegments", () => {
  it("shows the chosen segment and switches on selection", () => {
    render(<Harness />)
    const list = screen.getByTestId("segments-segments")
    expect(list).toHaveAttribute("role", "tablist")
    expect(list).toHaveAccessibleName("Things")
    expect(screen.getByTestId("content-a")).toBeInTheDocument()
    expect(screen.queryByTestId("content-b")).toBeNull()
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Beta" }))
    expect(screen.getByTestId("content-b")).toBeInTheDocument()
    expect(screen.queryByTestId("content-a")).toBeNull()
  })

  it("badges a desktop-only segment and keeps it selectable", () => {
    render(<Harness desktopOnly />)
    const beta = document.querySelector('[data-segment="b"]') as HTMLElement
    expect(beta).toHaveAttribute("data-desktop-only", "true")
    expect(within(beta).getByTestId("pet-console-desktop-badge")).toHaveTextContent("Desktop")
    expect(beta).not.toBeDisabled()
  })
})
