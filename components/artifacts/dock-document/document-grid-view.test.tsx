/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react"
import { DocumentGridView, parseDocumentGrid } from "./document-grid-view"
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

it("parses sectioned RFC-4180 CSV without splitting a heading inside a quoted cell", () => {
  const sections = parseDocumentGrid(
    '## People\nName,Note\nAlice,"first\n## still a cell"\n[Truncated by Cognia: limit]\n\n## Next\nx,y\n1,2'
  )
  expect(sections).toHaveLength(2)
  expect(sections[0].data).toEqual([["Alice", "first\n## still a cell"]])
  expect(sections[0].note).toContain("Truncated")
  expect(sections[1].columnCount).toBe(2)
})
it("renders plain-text cells, counts, notes and an explicit source toggle", () => {
  const text = "## Safe\nName,Value\n<script>,https://example.com\n[Truncated by Cognia: limit]"
  render(<DocumentGridView text={text} />)
  expect(screen.getByRole("table", { name: "Safe" })).toBeInTheDocument()
  expect(screen.getByRole("cell", { name: "<script>" })).toBeInTheDocument()
  expect(screen.queryByRole("link")).toBeNull()
  expect(screen.getByText(/Truncated/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole("button", { name: "grid.source" }))
  expect(screen.queryByRole("table")).toBeNull()
  expect(
    screen.getByText((_, element) => element?.tagName === "PRE" && element.textContent === text)
  ).toBeInTheDocument()
})
