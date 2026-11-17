import { fireEvent, render, screen } from "@testing-library/react"

import { ComposerPasteReminder, ComposerPastedChips, countLines } from "./composer-pasted-chips"

const ph = "[Pasted 2 lines #1]"

it("counts lines without splitting", () => {
  expect(countLines("one")).toBe(1)
  expect(countLines("a\nb\nc")).toBe(3)
})

it("shows a chip per folded paste still in the text, and removes one on ×", () => {
  const onRemove = jest.fn()
  const { rerender } = render(
    <ComposerPastedChips
      text={`see ${ph}`}
      pastedBlocks={{ [ph]: "a\nb", "[gone]": "x" }}
      onRemove={onRemove}
    />
  )
  const chips = screen.getByTestId("composer-pasted-chips")
  expect(chips.children).toHaveLength(1)

  fireEvent.click(screen.getByRole("button"))
  expect(onRemove).toHaveBeenCalledWith(ph)

  rerender(<ComposerPastedChips text="deleted" pastedBlocks={{ [ph]: "a" }} onRemove={onRemove} />)
  expect(screen.queryByTestId("composer-pasted-chips")).toBeNull()
})

it("asks for a re-paste only for placeholders whose body was lost", () => {
  const { rerender } = render(<ComposerPasteReminder text={`x ${ph}`} pastedBlocks={{}} />)
  expect(screen.getByTestId("composer-paste-reminder")).toBeInTheDocument()

  rerender(<ComposerPasteReminder text={`x ${ph}`} pastedBlocks={{ [ph]: "body" }} />)
  expect(screen.queryByTestId("composer-paste-reminder")).toBeNull()
})
