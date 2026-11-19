import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { expect, fn, userEvent, within } from "storybook/test"
import { Button } from "./button"

const meta = {
  title: "UI/Button",
  component: Button,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real shared button variants, translated labels and disabled behavior. Callback spies record gestures without saving data or invoking a host.",
      },
    },
  },
  args: { onClick: fn(), disabled: false },
  argTypes: {
    disabled: { control: "boolean", description: "Prevent pointer and keyboard activation." },
    variant: {
      control: "select",
      options: ["default", "secondary", "destructive", "outline", "ghost", "link"],
    },
    size: { control: "select", options: ["default", "sm", "lg", "icon"] },
  },
  render: function Example(args) {
    const t = useTranslations("common")
    return <Button {...args}>{t("save")}</Button>
  },
} satisfies Meta<typeof Button>
export default meta
type Story = StoryObj<typeof meta>

export const Enabled: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button"))
    await expect(args.onClick).toHaveBeenCalledTimes(1)
  },
}
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole("button")
    await expect(button).toBeDisabled()
    // Native activation also stays inert; pointer-events:none prevents the
    // simulated pointer from reaching a disabled button in the first place.
    button.click()
    await expect(args.onClick).not.toHaveBeenCalled()
  },
}
export const Destructive: Story = { args: { variant: "destructive" } }
export const Outline: Story = { args: { variant: "outline" } }
