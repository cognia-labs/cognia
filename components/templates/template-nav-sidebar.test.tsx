import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import type { TemplateDefinitionEnvelope } from "@/lib/templates/contracts"

import {
  DEFINITION_SHELVES,
  TemplateDomainIcon,
  TemplateNavSidebar,
  countByDomain,
  type TemplateNavSidebarProps,
} from "./template-nav-sidebar"

function definition(id: string, domain: string): TemplateDefinitionEnvelope {
  return { id, domain } as unknown as TemplateDefinitionEnvelope
}

function renderNav(props: Partial<TemplateNavSidebarProps> = {}) {
  const onSelectShelf = jest.fn()
  const onSelectDomain = jest.fn()
  render(
    <TemplateNavSidebar
      shelf="library"
      onSelectShelf={onSelectShelf}
      counts={{ library: 3, drafts: 1, published: 2 }}
      facetDefinitions={[
        definition("a", "skill"),
        definition("b", "skill"),
        definition("c", "workflow"),
      ]}
      domain="all"
      onSelectDomain={onSelectDomain}
      {...props}
    />
  )
  return { onSelectShelf, onSelectDomain }
}

describe("countByDomain", () => {
  it("counts definition ids, not envelopes, and lists the fullest type first", () => {
    // A draft and its release share one id: one template, two rows.
    const counts = countByDomain([
      definition("w1", "workflow"),
      definition("s1", "skill"),
      definition("s1", "skill"),
      definition("s2", "skill"),
      definition("g1", "goal"),
    ])
    expect(counts).toEqual([
      ["skill", 2],
      ["goal", 1],
      ["workflow", 1],
    ])
  })

  it("is empty for an empty shelf", () => {
    expect(countByDomain([])).toEqual([])
  })
})

describe("<TemplateNavSidebar />", () => {
  it("lists every shelf with its count and marks the open one", () => {
    const { onSelectShelf } = renderNav()
    expect(screen.getByRole("navigation", { name: "nav.label" })).toBeInTheDocument()
    expect(screen.getByTestId("template-nav-library")).toHaveAttribute("aria-current", "page")
    expect(screen.getByTestId("template-nav-drafts")).not.toHaveAttribute("aria-current")
    expect(screen.getByTestId("template-nav-count-library")).toHaveTextContent("3")
    expect(screen.getByTestId("template-nav-count-published")).toHaveTextContent("2")
    // A shelf without a count shows none rather than a zero it never measured.
    expect(screen.queryByTestId("template-nav-count-instances")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("template-nav-packages"))
    expect(onSelectShelf).toHaveBeenCalledWith("packages")
  })

  it("counts each type on the shelf and a total on All", () => {
    renderNav()
    expect(screen.getByTestId("template-nav-type-all")).toHaveTextContent("3")
    expect(screen.getByTestId("template-nav-type-all")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("template-nav-type-skill")).toHaveTextContent("domains.skill")
    expect(screen.getByTestId("template-nav-type-skill")).toHaveTextContent("2")
    expect(screen.getByTestId("template-nav-type-workflow")).toHaveTextContent("1")
  })

  it("picks a type", () => {
    const { onSelectDomain } = renderNav()
    fireEvent.click(screen.getByTestId("template-nav-type-skill"))
    expect(onSelectDomain).toHaveBeenCalledWith("skill")
  })

  it("clears the active type when it is clicked again", () => {
    const { onSelectDomain } = renderNav({ domain: "skill" })
    const row = screen.getByTestId("template-nav-type-skill")
    expect(row).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("template-nav-type-all")).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(row)
    expect(onSelectDomain).toHaveBeenCalledWith("all")
  })

  it.each(["packages", "instances"] as const)(
    "has no type list on the %s shelf, whose rows are not definitions",
    (shelf) => {
      renderNav({ shelf })
      expect(DEFINITION_SHELVES).not.toContain(shelf)
      expect(screen.queryByTestId("template-nav-types")).not.toBeInTheDocument()
    }
  )
})

describe("<TemplateDomainIcon />", () => {
  it("draws a decorative tile tagged with its type", () => {
    const { container } = render(<TemplateDomainIcon domain="workflow" className="size-8" />)
    const tile = container.querySelector("[data-template-domain-icon]")
    expect(tile).toHaveAttribute("data-template-domain-icon", "workflow")
    expect(tile).toHaveAttribute("aria-hidden")
    expect(tile).toHaveClass("size-8")
    expect(tile?.querySelector("svg")).not.toBeNull()
  })

  it("falls back to a generic glyph for a type it has no icon for", () => {
    const { container } = render(<TemplateDomainIcon domain={"unknown" as never} />)
    expect(container.querySelector("svg")).not.toBeNull()
  })
})
