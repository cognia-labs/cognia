/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

import userEvent from "@testing-library/user-event"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { IssueTextEditor } from "./issue-text-editor"
import { registerInlineLinkKind } from "@/lib/chat/inline-links"

function renderEditor(over: Partial<React.ComponentProps<typeof IssueTextEditor>> = {}) {
  const props: React.ComponentProps<typeof IssueTextEditor> = {
    value: "Ship it",
    onCommit: jest.fn(),
    ariaLabel: "Title",
    testId: "editor",
    ...over,
  }
  return { props, ...render(<IssueTextEditor {...props} />) }
}

describe("IssueTextEditor", () => {
  it("shows the value as text until clicked", () => {
    renderEditor()
    expect(screen.getByTestId("editor")).toHaveTextContent("Ship it")
    expect(screen.queryByTestId("editor-input")).not.toBeInTheDocument()
  })

  it("shows a placeholder for an empty value", () => {
    renderEditor({ value: "", placeholder: "Add a description" })
    expect(screen.getByTestId("editor")).toHaveTextContent("Add a description")
  })

  it("opens an input on click", async () => {
    const user = userEvent.setup()
    renderEditor()
    await user.click(screen.getByTestId("editor"))
    expect(screen.getByTestId("editor-input")).toHaveValue("Ship it")
  })

  it("commits on blur rather than discarding, because losing typing is the worst outcome", async () => {
    const user = userEvent.setup()
    const onCommit = jest.fn()
    renderEditor({ onCommit })
    await user.click(screen.getByTestId("editor"))
    await user.clear(screen.getByTestId("editor-input"))
    await user.type(screen.getByTestId("editor-input"), "Renamed")
    fireEvent.blur(screen.getByTestId("editor-input"))
    expect(onCommit).toHaveBeenCalledWith("Renamed")
  })

  it("commits on Enter for a single-line field", async () => {
    const user = userEvent.setup()
    const onCommit = jest.fn()
    renderEditor({ onCommit })
    await user.click(screen.getByTestId("editor"))
    await user.clear(screen.getByTestId("editor-input"))
    await user.type(screen.getByTestId("editor-input"), "Renamed{Enter}")
    expect(onCommit).toHaveBeenCalledWith("Renamed")
  })

  it("reverts on Escape, so there is a way out", async () => {
    const user = userEvent.setup()
    const onCommit = jest.fn()
    renderEditor({ onCommit })
    await user.click(screen.getByTestId("editor"))
    await user.clear(screen.getByTestId("editor-input"))
    await user.type(screen.getByTestId("editor-input"), "Discarded{Escape}")
    expect(onCommit).not.toHaveBeenCalled()
    expect(screen.getByTestId("editor")).toHaveTextContent("Ship it")
  })

  it("does not commit an unchanged value", async () => {
    const user = userEvent.setup()
    const onCommit = jest.fn()
    renderEditor({ onCommit })
    await user.click(screen.getByTestId("editor"))
    fireEvent.blur(screen.getByTestId("editor-input"))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it("trims a single-line commit", async () => {
    const user = userEvent.setup()
    const onCommit = jest.fn()
    renderEditor({ onCommit })
    await user.click(screen.getByTestId("editor"))
    await user.clear(screen.getByTestId("editor-input"))
    await user.type(screen.getByTestId("editor-input"), "  Padded  ")
    fireEvent.blur(screen.getByTestId("editor-input"))
    expect(onCommit).toHaveBeenCalledWith("Padded")
  })

  describe("required", () => {
    it("refuses a blank commit and reverts — an untitled issue is unfindable", async () => {
      const user = userEvent.setup()
      const onCommit = jest.fn()
      renderEditor({ onCommit, required: true })
      await user.click(screen.getByTestId("editor"))
      await user.clear(screen.getByTestId("editor-input"))
      fireEvent.blur(screen.getByTestId("editor-input"))
      expect(onCommit).not.toHaveBeenCalled()
      expect(screen.getByTestId("editor")).toHaveTextContent("Ship it")
    })

    it("allows a blank description, which is not required", async () => {
      const user = userEvent.setup()
      const onCommit = jest.fn()
      renderEditor({ onCommit, multiline: true })
      await user.click(screen.getByTestId("editor"))
      await user.clear(screen.getByTestId("editor-input"))
      fireEvent.blur(screen.getByTestId("editor-input"))
      expect(onCommit).toHaveBeenCalledWith("")
    })
  })

  describe("multiline", () => {
    it("keeps Enter as a newline", async () => {
      const user = userEvent.setup()
      const onCommit = jest.fn()
      renderEditor({ onCommit, multiline: true })
      await user.click(screen.getByTestId("editor"))
      await user.type(screen.getByTestId("editor-input"), "{Enter}more")
      expect(onCommit).not.toHaveBeenCalled()
    })

    it("commits on Ctrl+Enter", async () => {
      const user = userEvent.setup()
      const onCommit = jest.fn()
      renderEditor({ onCommit, multiline: true, value: "a" })
      await user.click(screen.getByTestId("editor"))
      await user.type(screen.getByTestId("editor-input"), "b")
      await user.keyboard("{Control>}{Enter}{/Control}")
      expect(onCommit).toHaveBeenCalledWith("ab")
    })
  })

  describe("disabled", () => {
    it("never opens an input", async () => {
      const user = userEvent.setup()
      renderEditor({ disabled: true })
      await user.click(screen.getByTestId("editor"))
      expect(screen.queryByTestId("editor-input")).not.toBeInTheDocument()
    })
  })

  it("adopts an external change while idle", () => {
    const { rerender } = renderEditor()
    rerender(
      <IssueTextEditor
        value="Changed elsewhere"
        onCommit={jest.fn()}
        ariaLabel="Title"
        testId="editor"
      />
    )
    expect(screen.getByTestId("editor")).toHaveTextContent("Changed elsewhere")
  })

  it("does not yank text out from under an active edit", async () => {
    const user = userEvent.setup()
    const { rerender } = renderEditor()
    await user.click(screen.getByTestId("editor"))
    await user.clear(screen.getByTestId("editor-input"))
    await user.type(screen.getByTestId("editor-input"), "Mine")
    rerender(
      <IssueTextEditor value="Theirs" onCommit={jest.fn()} ariaLabel="Title" testId="editor" />
    )
    expect(screen.getByTestId("editor-input")).toHaveValue("Mine")
  })
})

describe("linkify", () => {
  let dispose: () => void
  beforeEach(() => {
    dispose = registerInlineLinkKind({
      id: "issue",
      pattern: /\b[A-Z]+-\d+\b/g,
      matches: () => true,
      href: (text) => `/issues?identifier=${text}`,
      parseHref: () => undefined,
      accepts: () => true,
    })
  })
  afterEach(() => act(() => dispose()))

  it("links references in the shown text; a link click does not open the editor", async () => {
    const user = userEvent.setup()
    renderEditor({
      value: "Blocked by MERC-2",
      multiline: true,
      linkify: true,
      ariaLabel: "Description",
    })
    const link = screen.getByRole("link", { name: "MERC-2" })
    link.addEventListener("click", (event) => event.preventDefault())
    await user.click(link)
    expect(screen.queryByTestId("editor-input")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Description" }))
    expect(screen.getByTestId("editor-input")).toHaveValue("Blocked by MERC-2")
  })

  it("opens the editor from the keyboard", async () => {
    const user = userEvent.setup()
    renderEditor({ value: "MERC-2", linkify: true })
    screen.getByRole("button", { name: "Title" }).focus()
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("editor-input")).toHaveValue("MERC-2")
  })

  it("is read-only text with live links when disabled", async () => {
    const user = userEvent.setup()
    renderEditor({ value: "MERC-2", linkify: true, disabled: true })
    expect(screen.queryByRole("button")).toBeNull()
    expect(screen.getByRole("link", { name: "MERC-2" })).toBeInTheDocument()
    await user.click(screen.getByTestId("editor"))
    expect(screen.queryByTestId("editor-input")).not.toBeInTheDocument()
  })

  it("keeps the placeholder button for an empty value", () => {
    renderEditor({ value: "", linkify: true, placeholder: "Add a description" })
    expect(screen.getByRole("button")).toHaveTextContent("Add a description")
  })
})
