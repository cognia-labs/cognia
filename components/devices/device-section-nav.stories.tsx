import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { expect, fn, userEvent, within } from "storybook/test"
import { DeviceSectionNav } from "./device-section-nav"

const meta = {
  title: "Devices/DeviceSectionNav",
  component: DeviceSectionNav,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "The horizontal device table of contents. The active section is supplied by the parent; jumping records its anchor without scrolling a real dashboard. The narrow example exercises overflow and keeps the last active chip visible. Fewer than two sections intentionally render nothing.",
      },
    },
  },
  args: { items: [], activeAnchor: "device-section-0", onJump: fn() },
  argTypes: {
    activeAnchor: { control: "text" },
    onJump: { description: "Receives a rendered section anchor; no host or navigation call." },
  },
  render: function Example(args) {
    const t = useTranslations("common")
    const items = ["confirm", "edit", "save", "more", "yes", "no"].map((key, index) => ({
      anchor: `device-section-${index}`,
      label: t(key),
    }))
    return (
      <div className="w-80 max-w-full">
        <DeviceSectionNav {...args} items={args.items.length ? args.items : items} />
      </div>
    )
  },
} satisfies Meta<typeof DeviceSectionNav>
export default meta
type Story = StoryObj<typeof meta>

export const MultipleSections: Story = {
  play: async ({ canvasElement, args }) => {
    const buttons = within(canvasElement).getAllByRole("button")
    await expect(buttons[0]).toHaveAttribute("aria-current", "location")
    await userEvent.click(buttons[1]!)
    await expect(args.onJump).toHaveBeenCalledWith("device-section-1")
  },
}
export const LastSectionActive: Story = { args: { activeAnchor: "device-section-5" } }
export const SingleSectionHidden: Story = {
  args: { items: [{ anchor: "device-section-0", label: "Synthetic single section" }] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("navigation")).not.toBeInTheDocument()
  },
}
