import type { Meta, StoryObj } from "@storybook/nextjs"
import { useId } from "react"
import { useTranslations } from "next-intl"
import { expect, fn, userEvent, within } from "storybook/test"
import { Field, FieldLabel } from "./field"
import { Switch } from "./switch"

const meta = {
  title: "UI/Switch",
  component: Switch,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real boolean switch with a translated, associated label. Changes stay in this canvas; the callback is a spy, not a saved preference. defaultChecked is initial state and requires a remount to reset.",
      },
    },
  },
  args: { defaultChecked: false, disabled: false, onCheckedChange: fn() },
  argTypes: {
    defaultChecked: { control: "boolean", description: "Initial checked state." },
    disabled: { control: "boolean" },
    size: { control: "select", options: ["default", "sm"] },
    onCheckedChange: { description: "Records a boolean without persisting settings." },
  },
  render: function Example(args) {
    const id = useId()
    const t = useTranslations("common")
    return (
      <Field orientation="horizontal" data-disabled={args.disabled}>
        <Switch {...args} id={id} />
        <FieldLabel htmlFor={id}>{t("confirm")}</FieldLabel>
      </Field>
    )
  },
} satisfies Meta<typeof Switch>
export default meta
type Story = StoryObj<typeof meta>

export const Unchecked: Story = {
  play: async ({ canvasElement, args }) => {
    const control = within(canvasElement).getByRole("switch")
    await expect(control).not.toBeChecked()
    control.focus()
    await userEvent.keyboard(" ")
    await expect(control).toBeChecked()
    await expect(args.onCheckedChange).toHaveBeenCalledWith(true)
  },
}
export const Checked: Story = { args: { defaultChecked: true } }
export const Small: Story = { args: { size: "sm", defaultChecked: true } }
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement, args }) => {
    const control = within(canvasElement).getByRole("switch")
    await expect(control).toBeDisabled()
    control.click()
    await expect(args.onCheckedChange).not.toHaveBeenCalled()
  },
}
