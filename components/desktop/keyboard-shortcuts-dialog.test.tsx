/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

const chords: Record<string, string> = {
  "app.commandPalette.toggle": "⌘K",
  "chat.sidechat.toggle": "⌘;",
}
jest.mock("@/hooks/shortcuts/use-app-shortcut-label", () => ({
  useAppShortcutLabels: (ids: readonly string[]) =>
    ids.map((id) => ({ label: chords[id] ?? "", aria: undefined })),
}))

import { shortcutReferenceRows } from "@/lib/desktop/app-menu"
import { KeyboardShortcutsDialog } from "./keyboard-shortcuts-dialog"

function renderOpen() {
  render(<KeyboardShortcutsDialog open onOpenChange={jest.fn()} />)
  return screen.getByTestId("keyboard-shortcuts-dialog")
}

test("stays closed until asked", () => {
  render(<KeyboardShortcutsDialog open={false} onOpenChange={jest.fn()} />)
  expect(screen.queryByTestId("keyboard-shortcuts-dialog")).toBeNull()
})

test("prints app shortcuts with their effective chord", () => {
  const dialog = renderOpen()
  const palette = within(dialog).getByText("desktop.menu.view.commandPalette").closest("li")!
  expect(palette).toHaveTextContent("⌘K")
  const sidechat = within(dialog).getByText("desktop.menu.view.toggleSidechat").closest("li")!
  expect(sidechat).toHaveTextContent("⌘;")
})

test("prints native accelerators by their label", () => {
  const dialog = renderOpen()
  const newChat = within(dialog).getByText("desktop.menu.file.newChat").closest("li")!
  expect(newChat).toHaveTextContent("desktop.menu.shortcut.cmdOrCtrlN")
})

test("omits a row whose app shortcut is unbound instead of printing an empty key", () => {
  const dialog = renderOpen()
  // zoom.* are unbound in this fixture.
  expect(within(dialog).queryByText("desktop.menu.view.zoomIn")).toBeNull()
})

test("lists every bound row of the derived reference, in order", () => {
  const dialog = renderOpen()
  const expected = shortcutReferenceRows()
    .filter((row) => !("app" in row.shortcut) || chords[row.shortcut.app])
    .map((row) => `desktop.menu.${row.labelKey}`)
  const shown = within(dialog)
    .getAllByRole("listitem")
    .map((li) => li.querySelector("span")?.textContent)
  expect(shown).toEqual(expected)
})
