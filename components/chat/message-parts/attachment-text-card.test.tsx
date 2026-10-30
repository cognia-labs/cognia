import { fireEvent, render, screen } from "@testing-library/react"
import { AttachmentTextCard } from "./attachment-text-card"

describe("AttachmentTextCard", () => {
  it("shows the filename and extracted length without the body", () => {
    render(<AttachmentTextCard filename="report.pdf" mediaType="application/pdf" text="abcde" />)
    expect(screen.getByText("report.pdf")).toBeInTheDocument()
    expect(screen.getByText("5 chars extracted")).toBeInTheDocument()
    // Collapsed by default — the point of the bubble is the user's own message.
    expect(screen.queryByTestId("attachment-text-card-body")).not.toBeInTheDocument()
  })

  it("uses the singular form for a one-character extraction", () => {
    render(<AttachmentTextCard filename="a.txt" text="x" />)
    expect(screen.getByText("1 char extracted")).toBeInTheDocument()
  })

  it("expands and collapses the extracted text", () => {
    render(<AttachmentTextCard filename="report.pdf" text="the full body text" />)
    const toggle = screen.getByRole("button", { name: /report\.pdf/ })
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(screen.getByTestId("attachment-text-card-body")).toHaveTextContent("the full body text")

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("attachment-text-card-body")).not.toBeInTheDocument()
  })

  it("wires the toggle to the body for assistive tech", () => {
    render(<AttachmentTextCard filename="a.txt" text="body" />)
    const toggle = screen.getByRole("button", { name: /a\.txt/ })
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-controls")).toBe(
      screen.getByTestId("attachment-text-card-body").id
    )
  })

  it("puts the media type in the title without cluttering the label", () => {
    render(<AttachmentTextCard filename="a.csv" mediaType="text/csv" text="x,y" />)
    expect(screen.getByTitle("a.csv · text/csv")).toBeInTheDocument()
  })

  it("renders a card for an empty extraction rather than crashing", () => {
    render(<AttachmentTextCard filename="empty.txt" text="" />)
    expect(screen.getByText("0 chars extracted")).toBeInTheDocument()
  })
})

const cloudProvenance = {
  v: 1 as const,
  providerId: "google" as const,
  resourceKind: "doc" as const,
  resourceId: "abcdefghijklmnop1234",
  url: "https://docs.google.com/document/d/abcdefghijklmnop1234/edit",
  title: "Plan",
  fetchedAt: 1,
  completeness: { status: "complete" as const },
}
const injectedCloudProvenance = {
  ...cloudProvenance,
  accountId: "private-account",
  authorizationEpoch: "private-epoch",
  accountBinding: { accountId: "private-account" },
}

import { openDockDocument } from "@/lib/artifacts/dock-documents"
jest.mock("@/lib/artifacts/dock-documents", () => ({ openDockDocument: jest.fn() }))
jest.mock("./attachment-source-actions", () => ({ AttachmentSourceActions: () => null }))
it.each(["deleted-asset", undefined])(
  "opens a sent cloud snapshot without inline fallback when assetId=%s",
  (assetId) => {
    jest.mocked(openDockDocument).mockClear()
    render(
      <AttachmentTextCard
        filename="Plan.md"
        text="saved body"
        sessionId="owner"
        messageId="m"
        assetId={assetId}
        provenance={injectedCloudProvenance}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /openDock|Open in dock/ }))
    expect(openDockDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "owner",
        view: "snapshot",
        snapshot: assetId
          ? { kind: "asset", assetId, messageId: "m" }
          : {
              kind: "inline",
              content: expect.objectContaining({ origin: "sent", text: "saved body" }),
            },
      })
    )
  }
)
it("keeps legacy cards without provenance unchanged", () => {
  render(<AttachmentTextCard filename="local.txt" text="local" sessionId="owner" />)
  expect(screen.queryByRole("button", { name: /openDock|Open in dock/ })).not.toBeInTheDocument()
})
