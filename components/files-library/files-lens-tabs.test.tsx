/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesLensTabs } from "./files-lens-tabs"

beforeEach(() => useFilesLibraryStore.setState({ section: { kind: "all" }, lens: "suggested" }))

it("lists every lens and switches between them", async () => {
  const user = userEvent.setup()
  render(<FilesLensTabs />)
  expect(screen.getByRole("radiogroup")).toHaveAccessibleName()
  for (const name of ["Suggested", "Favorites", "Mine", "AI-generated", "Shared with me"]) {
    expect(screen.getByRole("radio", { name })).toBeInTheDocument()
  }
  expect(screen.getByRole("radio", { name: "Suggested" })).toHaveAttribute("aria-checked", "true")
  await user.click(screen.getByRole("radio", { name: "AI-generated" }))
  expect(useFilesLibraryStore.getState().lens).toBe("ai")
})

it("shows no lenses in the Trash", () => {
  useFilesLibraryStore.setState({ section: { kind: "trash" } })
  render(<FilesLensTabs />)
  expect(screen.queryByRole("radiogroup")).toBeNull()
})

it("selects the next lens with ArrowRight and keeps a checked lens selected", async () => {
  const user = userEvent.setup()
  render(<FilesLensTabs />)
  await user.click(screen.getByRole("radio", { name: "Suggested" }))
  // Radix schedules roving focus; hold the physical key until it moves so
  // keyup cannot overtake the focus task in the synthetic event sequence.
  await user.keyboard("{ArrowRight>}")
  const favorites = screen.getByRole("radio", { name: "Favorites" })
  await waitFor(() => expect(favorites).toHaveFocus())
  await waitFor(() => expect(favorites).toBeChecked())
  await user.keyboard("{/ArrowRight}")
  expect(useFilesLibraryStore.getState().lens).toBe("favorites")
  await user.click(favorites)
  expect(favorites).toBeChecked()
  expect(useFilesLibraryStore.getState().lens).toBe("favorites")
})
