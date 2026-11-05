import { act, render, screen } from "@testing-library/react"

import { notifyInlineLinksChanged, registerInlineLinkKind } from "@/lib/chat/inline-links"
import { InlineLinkedText } from "./inline-linked-text"

let known: Set<string>
let dispose: () => void
beforeEach(() => {
  known = new Set(["MERC"])
  dispose = registerInlineLinkKind({
    id: "issue",
    pattern: /\b[A-Z]+-\d+\b/g,
    matches: (text) => !text.endsWith("-0"),
    href: (text) => `/issues?identifier=${text}`,
    parseHref: () => undefined,
    accepts: (text) => known.has(text.split("-")[0]),
  })
})
afterEach(() => act(() => dispose()))

describe("InlineLinkedText", () => {
  it("links accepted references in place and keeps the rest as text", () => {
    const { container } = render(
      <p>
        <InlineLinkedText text="Fixes MERC-12, not ABC-3 or MERC-0." />
      </p>
    )
    expect(container.textContent).toBe("Fixes MERC-12, not ABC-3 or MERC-0.")
    const links = screen.getAllByRole("link")
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute("href", "/issues?identifier=MERC-12")
    expect(links[0]).toHaveAttribute("data-inline-link", "issue")
  })

  it("links a reference once its kind accepts it", () => {
    render(<InlineLinkedText text="ABC-3" />)
    expect(screen.queryByRole("link")).toBeNull()
    act(() => {
      known.add("ABC")
      notifyInlineLinksChanged()
    })
    expect(screen.getByRole("link", { name: "ABC-3" })).toBeInTheDocument()
  })

  it("renders plain text when no kind is registered", () => {
    act(() => dispose())
    const { container } = render(<InlineLinkedText text="MERC-1" />)
    expect(container.textContent).toBe("MERC-1")
    expect(screen.queryByRole("link")).toBeNull()
  })
})
