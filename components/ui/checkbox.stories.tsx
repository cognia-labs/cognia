import type { Meta, StoryObj } from "@storybook/nextjs"
import { useId } from "react"
import { useTranslations } from "next-intl"
import { expect, userEvent, within } from "storybook/test"
import { Checkbox } from "./checkbox"
import { Label } from "./label"

const meta = {
  title: "UI/Checkbox",
  component: Checkbox,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Uncontrolled checkbox with an associated translated label. Keyboard/pointer changes are local; checked, indeterminate and disabled cases use the real Radix primitive.",
      },
    },
  },
  argTypes: {
    disabled: { control: "boolean" },
    defaultChecked: { control: "select", options: [false, true, "indeterminate"] },
  },
  render: function Example(args) {
    const id = useId()
    const t = useTranslations("common")
    return (
      <div className="flex items-center gap-3">
        <Checkbox {...args} id={id} />
        <Label htmlFor={id}>{t("confirm")}</Label>
      </div>
    )
  },
} satisfies Meta<typeof Checkbox>
export default meta
type Story = StoryObj<typeof meta>
export const Unchecked: Story = {
  args: { defaultChecked: false },
  play: async ({ canvasElement }) => {
    const checkbox = within(canvasElement).getByRole("checkbox")
    await expect(checkbox).not.toBeChecked()
    await userEvent.click(checkbox)
    await expect(checkbox).toBeChecked()
  },
}
export const Checked: Story = { args: { defaultChecked: true } }
export const Indeterminate: Story = { args: { defaultChecked: "indeterminate" } }
export const Disabled: Story = { args: { disabled: true } }
