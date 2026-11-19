import type { Meta, StoryObj } from "@storybook/nextjs"
import { useId } from "react"
import { useTranslations } from "next-intl"
import { expect, userEvent, within } from "storybook/test"
import { Field, FieldGroup, FieldLabel } from "./field"
import { Textarea } from "./textarea"

const meta = {
  title: "UI/Textarea",
  component: Textarea,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real multiline input with a translated label. Text is synthetic and stays in the DOM; no draft is saved. Invalid demonstrates an externally supplied aria-invalid state, not a validation service. The long fixture exercises wrapping and content sizing.",
      },
    },
  },
  argTypes: {
    defaultValue: { control: "text", description: "Initial synthetic text; remount to reset." },
    disabled: { control: "boolean" },
    readOnly: { control: "boolean" },
    "aria-invalid": { control: "boolean" },
  },
  render: function Example(args) {
    const id = useId()
    const t = useTranslations("common")
    return (
      <FieldGroup className="w-96 max-w-full">
        <Field data-disabled={args.disabled} data-invalid={args["aria-invalid"]}>
          <FieldLabel htmlFor={id}>{t("edit")}</FieldLabel>
          <Textarea {...args} id={id} />
        </Field>
      </FieldGroup>
    )
  },
} satisfies Meta<typeof Textarea>
export default meta
type Story = StoryObj<typeof meta>

export const Editable: Story = {
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox")
    await userEvent.type(input, "First line\nSecond line")
    await expect(input).toHaveValue("First line\nSecond line")
  },
}
export const Invalid: Story = {
  args: { "aria-invalid": true, defaultValue: "Synthetic invalid input" },
}
export const Disabled: Story = {
  args: { disabled: true, defaultValue: "Synthetic disabled input" },
}
export const ReadOnly: Story = {
  args: { readOnly: true, defaultValue: "Synthetic read-only input" },
  play: async ({ canvasElement }) => {
    const input = within(canvasElement).getByRole("textbox")
    await userEvent.type(input, "changed")
    await expect(input).toHaveValue("Synthetic read-only input")
  },
}
export const LongContent: Story = {
  args: { defaultValue: "Synthetic multiline notes — 合成多行内容。 ".repeat(24) },
}
