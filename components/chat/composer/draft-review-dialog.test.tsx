import { fireEvent, render, screen } from "@testing-library/react"

import type { ConnectorDraftRow } from "@/lib/db/connector-types"

import { DraftReviewDialog } from "./draft-review-dialog"

jest.mock("@/components/inbox/draft-editor", () => ({
  DraftEditor: ({ draft, onClose }: { draft: { id: string }; onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      {`edit ${draft.id}`}
    </button>
  ),
}))

it("lists each pending draft, and an editor closing closes the dialog", () => {
  const onOpenChange = jest.fn()
  render(
    <DraftReviewDialog
      open
      onOpenChange={onOpenChange}
      drafts={[{ id: "d1" }, { id: "d2" }] as unknown as ConnectorDraftRow[]}
    />
  )

  expect(screen.getByText("edit d2")).toBeInTheDocument()
  fireEvent.click(screen.getByText("edit d1"))
  expect(onOpenChange).toHaveBeenCalledWith(false)
})

it("says so when nothing is pending", () => {
  render(<DraftReviewDialog open onOpenChange={jest.fn()} drafts={[]} />)
  expect(screen.queryByRole("button", { name: /edit/ })).toBeNull()
  expect(screen.getByRole("dialog")).toBeInTheDocument()
})
