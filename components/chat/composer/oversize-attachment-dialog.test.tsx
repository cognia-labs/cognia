import { fireEvent, render, screen } from "@testing-library/react"

import { OversizeAttachmentDialog } from "./oversize-attachment-dialog"

it("is closed without a parked send", () => {
  render(<OversizeAttachmentDialog request={null} />)
  expect(screen.queryByRole("alertdialog")).toBeNull()
})

it("resolves the parked send with the user's choice", () => {
  const resolve = jest.fn()
  const { rerender } = render(<OversizeAttachmentDialog request={{ tokens: 42_000, resolve }} />)
  expect(screen.getByRole("alertdialog")).toHaveTextContent("42")

  const [cancel, confirm] = screen.getAllByRole("button")
  // Confirming also closes the dialog, whose close settles the same promise a
  // second time (a no-op): the first answer is the one that counts.
  fireEvent.click(confirm)
  expect(resolve).toHaveBeenNthCalledWith(1, true)
  resolve.mockClear()

  rerender(<OversizeAttachmentDialog request={{ tokens: 42_000, resolve }} />)
  fireEvent.click(cancel)
  expect(resolve).toHaveBeenNthCalledWith(1, false)
})
