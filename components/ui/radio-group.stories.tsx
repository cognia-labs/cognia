import type { Meta, StoryObj } from "@storybook/nextjs"
import { useId } from "react"
import { useTranslations } from "next-intl"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { Field, FieldLabel, FieldLegend, FieldSet } from "./field"
import { RadioGroup, RadioGroupItem } from "./radio-group"

const meta = {
  title: "UI/RadioGroup",
  component: RadioGroup,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real single-choice group, translated labels and initial yes/no choice. Arrow keys move both focus and selection; the third choice is disabled. Callback records the selected value without saving or approving anything.",
      },
    },
  },
  args: { defaultValue: "yes", onValueChange: fn(), disabled: false },
  argTypes: {
    defaultValue: {
      control: "select",
      options: ["yes", "no"],
      description: "Initial choice; remount to reset.",
    },
    disabled: { control: "boolean" },
    onValueChange: { description: "Records the selected value." },
  },
  render: function Example(args) {
    const id = useId()
    const t = useTranslations("common")
    return (
      <FieldSet>
        <FieldLegend id={id} variant="label">
          {t("confirm")}
        </FieldLegend>
        <RadioGroup {...args} aria-labelledby={id}>
          {(["yes", "no", "cancel"] as const).map((value) => (
            <Field
              key={value}
              orientation="horizontal"
              data-disabled={args.disabled || value === "cancel"}
            >
              <RadioGroupItem
                value={value}
                id={`${id}-${value}`}
                disabled={value === "cancel" || args.disabled}
              />
              <FieldLabel htmlFor={`${id}-${value}`}>{t(value)}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
    )
  },
} satisfies Meta<typeof RadioGroup>
export default meta
type Story = StoryObj<typeof meta>

export const Keyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const radios = within(canvasElement).getAllByRole("radio")
    await expect(radios[0]).toBeChecked()
    radios[0]!.focus()
    await userEvent.keyboard("{ArrowDown>}")
    await waitFor(() => expect(radios[1]).toBeChecked())
    await userEvent.keyboard("{/ArrowDown}")
    await expect(radios[1]).toHaveFocus()
    await expect(args.onValueChange).toHaveBeenCalledWith("no")
    await expect(radios[2]).toBeDisabled()
  },
}
export const NoSelected: Story = { args: { defaultValue: "no" } }
export const Disabled: Story = { args: { disabled: true } }
