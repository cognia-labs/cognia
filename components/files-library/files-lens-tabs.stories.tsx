import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, userEvent, within } from "storybook/test"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesLensTabs } from "./files-lens-tabs"

const meta = {
  title: "Files/Lenses",
  component: FilesLensTabs,
  tags: ["quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real Files lens selection backed by a reset preview store. Changes persist only on the Storybook origin; no Files library is fetched. Each canvas resets state. Trash intentionally hides lenses; avoid multi-canvas Autodocs for this store-mutating fixture.",
      },
    },
  },
  beforeEach: () => {
    resetStore(useFilesLibraryStore)
    seedStore(useFilesLibraryStore, { section: { kind: "all" }, lens: "suggested" })
  },
} satisfies Meta<typeof FilesLensTabs>
export default meta
type Story = StoryObj<typeof meta>
export const Suggested: Story = {
  play: async ({ canvasElement }) => {
    const tabs = within(canvasElement).getAllByRole("radio")
    await expect(tabs[0]).toHaveAttribute("aria-checked", "true")
    await userEvent.click(tabs[1]!)
    await expect(tabs[1]).toHaveAttribute("aria-checked", "true")
    await expect(useFilesLibraryStore.getState().lens).toBe("favorites")
  },
}
export const Favorites: Story = {
  beforeEach: () => {
    resetStore(useFilesLibraryStore)
    seedStore(useFilesLibraryStore, { section: { kind: "all" }, lens: "favorites" })
  },
}
export const TrashHidden: Story = {
  beforeEach: () => {
    resetStore(useFilesLibraryStore)
    seedStore(useFilesLibraryStore, { section: { kind: "trash" } })
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("radiogroup")).not.toBeInTheDocument()
  },
}
