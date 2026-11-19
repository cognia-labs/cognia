import type { Meta, StoryObj } from "@storybook/nextjs"
import { useId } from "react"
import { useTranslations } from "next-intl"
import { expect, userEvent, within } from "storybook/test"
import { Input } from "./input"
import { Label } from "./label"

const meta = {
  title: "UI/Input",
  component: Input,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Labeled input with real browser editing, disabled and invalid states. Synthetic text remains in this preview only; no form submission or persistence.",
      },
    },
  },
  args: { disabled: false },
  argTypes: {
    disabled: { control: "boolean" },
    "aria-invalid": {
      control: "boolean",
      description: "Expose validation state to assistive technology.",
    },
  },
  render: function Example(args) {
    const id = useId()
    const t = useTranslations("common")
    return (
      <div className="grid w-80 max-w-full gap-2">
        <Label htmlFor={id}>{t("edit")}</Label>
        <Input {...args} id={id} />
      </div>
    )
  },
} satisfies Meta<typeof Input>
export default meta
type Story = StoryObj<typeof meta>

export const Editable: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox")
    await userEvent.clear(input)
    await userEvent.type(input, "Cognia")
    await expect(input).toHaveValue("Cognia")
  },
}
export const Disabled: Story = { args: { disabled: true, defaultValue: "Cognia" } }
export const Invalid: Story = { args: { "aria-invalid": true, defaultValue: "invalid.example" } }
