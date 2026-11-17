/**
 * @jest-environment jsdom
 */

import * as ReactForMocks from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import {
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "@/lib/ui/hover-reveal"

import {
  InlineCopyButton,
  TOOL_ROW_SCROLL_TEXT_CLASS,
  ToolRowBlock,
  ToolRowShell,
  ToolStatusDot,
} from "./tool-row"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockTouchShell = false
jest.mock("@/hooks/ui/use-pointer", () => ({
  useTouchShell: () => mockTouchShell,
}))

const copyMock = jest.fn(async () => true)
jest.mock("@/hooks/ui", () => ({
  useCopy: () => ({ copied: false, copy: copyMock }),
}))

describe("ToolStatusDot", () => {
  it("maps each tool state to a status colour", () => {
    const { container, rerender } = render(<ToolStatusDot status="output-available" />)
    expect(container.firstChild).toHaveClass("bg-success")

    rerender(<ToolStatusDot status="output-error" />)
    expect(container.firstChild).toHaveClass("bg-destructive")

    rerender(<ToolStatusDot status="output-denied" />)
    expect(container.firstChild).toHaveClass("bg-orange-600")
  })

  it("breathes while running — and for the group's aggregate running state", () => {
    const { container, rerender } = render(<ToolStatusDot status="input-available" />)
    expect(container.firstChild).toHaveClass("animate-pulse")

    rerender(<ToolStatusDot status="running" />)
    expect(container.firstChild).toHaveClass("animate-pulse")

    rerender(<ToolStatusDot status="output-available" />)
    expect(container.firstChild).not.toHaveClass("animate-pulse")
  })
})

describe("InlineCopyButton", () => {
  it("copies the value without letting the click reach the row toggle", () => {
    const onRowClick = jest.fn()
    render(
      ReactForMocks.createElement(
        "div",
        { onClick: onRowClick },
        ReactForMocks.createElement(InlineCopyButton, {
          value: "pnpm test",
          label: "copy",
          testId: "copy-btn",
        })
      )
    )
    fireEvent.click(screen.getByTestId("copy-btn"))
    expect(copyMock).toHaveBeenCalledWith("pnpm test")
    expect(onRowClick).not.toHaveBeenCalled()
  })
})

describe("ToolRowShell", () => {
  it("keeps the row actions reachable without a hover", () => {
    copyMock.mockClear()
    const onToggle = jest.fn()
    render(
      <ToolRowShell
        status="output-available"
        ariaLabel="row"
        testId="row"
        onToggle={onToggle}
        lead={<span>$</span>}
        actions={<InlineCopyButton value="ls -la" label="copy command" testId="row-copy" />}
      >
        <div>Command output</div>
      </ToolRowShell>
    )
    const button = screen.getByTestId("row-copy")
    const wrapper = button.parentElement
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.groupBase) {
      expect(wrapper).toHaveClass(variant)
    }
    expect(wrapper).toHaveClass("group-hover/trow:opacity-100")
    for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
      expect(wrapper).not.toHaveClass(forbidden)
    }
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(copyMock).toHaveBeenCalledWith("ls -la")
    expect(onToggle).not.toHaveBeenCalled()
    const toggle = screen.getByRole("button", { name: "row" })
    expect(toggle).not.toContainElement(button)
    fireEvent.click(toggle)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  describe("on touch (D2)", () => {
    beforeEach(() => {
      mockTouchShell = true
    })
    afterEach(() => {
      mockTouchShell = false
    })

    it("draws the actions at the top of the open body, not over the row", () => {
      render(
        <ToolRowShell
          status="output-available"
          ariaLabel="row"
          testId="row"
          open
          meta={<span>12 lines</span>}
          actions={<InlineCopyButton value="ls" label="copy command" testId="row-copy" />}
        >
          <div data-testid="row-body">Command output</div>
        </ToolRowShell>
      )
      const actions = screen.getByTestId("tool-row-actions")
      expect(actions.dataset.placement).toBe("body")
      expect(actions).toHaveClass("touch-hit-each")
      expect(actions.nextElementSibling).toBe(screen.getByTestId("row-body"))
      // The row's meta text is no longer covered.
      expect(screen.getAllByTestId("tool-row-actions")).toHaveLength(1)
    })

    it("draws them after the meta on a row with no body", () => {
      render(
        <ToolRowShell
          status="output-available"
          ariaLabel="row"
          testId="row"
          meta={<span>done</span>}
          actions={<InlineCopyButton value="ls" label="copy command" testId="row-copy" />}
        />
      )
      expect(screen.getByTestId("tool-row-actions").dataset.placement).toBe("inline")
    })
  })

  it("keeps the pointer overlay off touch", () => {
    render(
      <ToolRowShell
        status="output-available"
        ariaLabel="row"
        testId="row"
        actions={<InlineCopyButton value="ls" label="copy command" testId="row-copy" />}
      >
        <div>Command output</div>
      </ToolRowShell>
    )
    expect(screen.getByTestId("tool-row-actions").dataset.placement).toBe("overlay")
  })

  it("rings the toggle on keyboard focus and grows the row to the touch floor", () => {
    render(
      <ToolRowShell status="output-available" ariaLabel="row" testId="row" onToggle={() => {}}>
        <div>Command output</div>
      </ToolRowShell>
    )
    const toggle = screen.getByRole("button", { name: "row" })
    expect(toggle).toHaveClass("focus-visible:ring-[3px]", "focus-visible:ring-ring/50")
    expect(toggle).not.toHaveClass("focus-visible:outline-none")
    expect(toggle.parentElement).toHaveClass("pointer-coarse:min-h-11")
  })

  it("leads with the status dot and the verb label by default", () => {
    render(
      <ToolRowShell
        status="output-available"
        ariaLabel="row"
        testId="row"
        lead={<span>READ</span>}
        target={<span>file.ts</span>}
      />
    )
    const inner = screen.getByTestId("row-toggle")
    expect(inner.firstElementChild).toHaveClass("rounded-full")
    expect(inner).toHaveTextContent("READfile.ts")
  })

  it("can drop the dot and the lead for rows whose target names them", () => {
    render(
      <ToolRowShell
        status="output-available"
        ariaLabel="row"
        testId="row"
        showDot={false}
        target={<span>Thought for 3 seconds</span>}
      />
    )
    const inner = screen.getByTestId("row-toggle")
    expect(inner.querySelector(".rounded-full")).toBeNull()
    expect(inner.textContent).toBe("Thought for 3 seconds")
  })
})

describe("ToolRowBlock", () => {
  it("renders the header label and the payload", () => {
    render(
      <ToolRowBlock label="stdout" testId="blk">
        <div>payload</div>
      </ToolRowBlock>
    )
    expect(screen.getByTestId("blk").textContent).toContain("stdout")
    expect(screen.getByTestId("blk").textContent).toContain("payload")
  })

  it("offers a copy button in the header when copyValue is set", () => {
    render(
      <ToolRowBlock label="stdout" copyValue="full output" testId="blk">
        <div>out</div>
      </ToolRowBlock>
    )
    fireEvent.click(screen.getByTestId("blk-copy"))
    expect(copyMock).toHaveBeenCalledWith("full output")
  })

  it("tints the block destructive in error mode", () => {
    render(
      <ToolRowBlock label="error" error testId="blk">
        <div>boom</div>
      </ToolRowBlock>
    )
    const block = screen.getByTestId("blk")
    expect(block.className).toContain("border-destructive/40")
    expect(block.querySelector(".border-b")?.className).toContain("text-destructive")
  })
})

describe("TOOL_ROW_SCROLL_TEXT_CLASS", () => {
  const classes = TOOL_ROW_SCROLL_TEXT_CLASS.split(" ")

  it("lets the text box shrink inside the flex row", () => {
    expect(classes).toContain("min-w-0")
  })

  it("keeps the ellipsis for fine pointers", () => {
    expect(classes).toContain("truncate")
  })

  it("scrolls sideways on touch, with no visible scrollbar in any engine", () => {
    expect(classes).toEqual(
      expect.arrayContaining([
        "pointer-coarse:overflow-x-auto",
        "pointer-coarse:text-clip",
        "[scrollbar-width:none]",
        "[&::-webkit-scrollbar]:hidden",
      ])
    )
  })
})
