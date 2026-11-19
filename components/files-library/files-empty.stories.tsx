import type { Meta, StoryObj } from "@storybook/nextjs"
import { expect, fn, userEvent, within } from "storybook/test"
import { FilesEmpty } from "./files-empty"

const meta = {
  title: "Files/Empty",
  component: FilesEmpty,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Empty-library copy for real browser capabilities (ADR-0223). No database read is started. Filter clearing calls a spy; workspace files honestly show that this browser has no local workspace-file capability.",
      },
    },
  },
  args: { section: { kind: "all" }, lens: "suggested", filtered: false, onClear: fn() },
  argTypes: {
    filtered: { control: "boolean" },
    touch: { control: "boolean" },
    lens: { control: "select", options: ["suggested", "favorites", "mine", "ai", "shared"] },
    section: { control: "object" },
  },
  decorators: [
    (Story) => (
      <div className="w-[40rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FilesEmpty>
export default meta
type Story = StoryObj<typeof meta>
export const All: Story = {}
export const Filtered: Story = {
  args: { filtered: true },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button"))
    await expect(args.onClear).toHaveBeenCalledTimes(1)
  },
}
export const Trash: Story = { args: { section: { kind: "trash" } } }
export const TouchFolder: Story = {
  args: { section: { kind: "folder", folderId: "storybook-folder" }, touch: true },
}
export const WorkspaceUnavailable: Story = {
  args: { section: { kind: "group", group: "workspace" } },
}
