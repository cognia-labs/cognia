import { fireEvent, render, screen } from "@testing-library/react"
import { THEMES } from "@/lib/export/html/syntax-themes"
import { CustomThemeEditor } from "./custom-theme-editor"

const mockName = "LongTheme".repeat(40)
const mockUpsert = jest.fn((input: { id?: string }) => ({ id: input.id ?? "new" }))
jest.mock("@/stores/theme", () => {
  const { THEMES: themes } = jest.requireActual("@/lib/export/html/syntax-themes")
  return {
    useCustomThemeStore: (select: (state: unknown) => unknown) =>
      select({
        themes: [{ id: "saved", name: mockName, tokens: { ...themes.light } }],
        upsert: (input: { id?: string }) => mockUpsert(input),
        remove: jest.fn(),
      }),
    seedTokens: () => ({ ...themes.light }),
  }
})

beforeEach(() => mockUpsert.mockClear())

/** The text field of one token (the second input after its label). */
function tokenText(key: string): HTMLInputElement {
  return screen.getByLabelText(key).parentElement!.querySelectorAll("input")[1] as HTMLInputElement
}

it("adapts token columns to its own width and keeps long saved themes selectable", () => {
  const onSelect = jest.fn()
  const { container } = render(
    <CustomThemeEditor selectedId="saved" builtInBase="arknights" onSelect={onSelect} />
  )
  expect(container.firstChild).toHaveClass("@container/theme-editor")
  expect(screen.getByLabelText("bg").parentElement?.parentElement).toHaveClass(
    "grid-cols-1",
    "@xl/theme-editor:grid-cols-2"
  )
  const chip = screen.getByRole("button", { name: mockName })
  expect(chip).toHaveClass("max-w-full")
  expect(screen.getByText(mockName)).toHaveClass("truncate")
  fireEvent.click(chip)
  expect(onSelect).toHaveBeenCalledWith("saved")
})

it("blocks saving a value that is not a CSS color and names the token (F15)", () => {
  const onSelect = jest.fn()
  render(<CustomThemeEditor selectedId="saved" builtInBase="light" onSelect={onSelect} />)
  const save = screen.getByRole("button", { name: "Update" })

  fireEvent.change(tokenText("accent"), {
    target: { value: "red;}</style><script>alert(1)</script>" },
  })

  expect(tokenText("accent")).toHaveAttribute("aria-invalid", "true")
  expect(screen.getByTestId("theme-invalid-tokens")).toHaveTextContent("accent")
  expect(save).toBeDisabled()
  fireEvent.click(save)
  expect(mockUpsert).not.toHaveBeenCalled()
})

it("saves any CSS color notation, without surrounding whitespace", () => {
  const onSelect = jest.fn()
  render(<CustomThemeEditor selectedId="saved" builtInBase="light" onSelect={onSelect} />)

  fireEvent.change(tokenText("accent"), { target: { value: "  oklch(0.6 0.2 30 / 0.9) " } })
  expect(screen.queryByTestId("theme-invalid-tokens")).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Update" }))

  expect(mockUpsert).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "saved",
      tokens: expect.objectContaining({ accent: "oklch(0.6 0.2 30 / 0.9)", bg: THEMES.light.bg }),
    })
  )
  expect(onSelect).toHaveBeenCalledWith("saved")
})
