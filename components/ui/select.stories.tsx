import type { Meta, StoryObj } from "@storybook/nextjs"
import { useId, useState } from "react"
import { useTranslations } from "next-intl"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { Field, FieldLabel } from "./field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./select"

const meta = {
  title: "UI/Select",
  component: Select,
  tags: ["quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real Radix select and portal with translated label/options. The cancel option is disabled. Choosing a value records a spy and closes the popup; no preference or permission is saved. Portal scenarios stay on individual canvases. The standalone field background becomes inert while the modal popup is open; this example includes that integration wrapper, not only the bare primitive.",
      },
    },
  },
  args: { onValueChange: fn(), disabled: false },
  argTypes: {
    defaultValue: { control: "select", options: [undefined, "yes", "no"] },
    disabled: { control: "boolean" },
    onValueChange: { description: "Records a selected synthetic value." },
  },
  render: function Example(args) {
    const id = useId()
    const [open, setOpen] = useState(args.defaultOpen ?? false)
    const t = useTranslations("common")
    return (
      <Field className="w-64 max-w-full" data-disabled={args.disabled} inert={open}>
        <FieldLabel htmlFor={id}>{t("confirm")}</FieldLabel>
        <Select
          {...args}
          onOpenChange={(value) => {
            setOpen(value)
            args.onOpenChange?.(value)
          }}
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder={t("more")} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>{t("confirm")}</SelectLabel>
              <SelectItem value="yes">{t("yes")}</SelectItem>
              <SelectItem value="no">{t("no")}</SelectItem>
              <SelectItem value="cancel" disabled>
                {t("cancel")}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
    )
  },
} satisfies Meta<typeof Select>
export default meta
type Story = StoryObj<typeof meta>

export const Choose: Story = {
  play: async ({ canvasElement, args }) => {
    const trigger = within(canvasElement).getByRole("combobox")
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(trigger)
    await waitFor(() => expect(body.getByRole("listbox")).toBeVisible())
    const options = body.getAllByRole("option")
    await expect(options[2]).toHaveAttribute("aria-disabled", "true")
    await userEvent.click(options[1]!)
    await expect(args.onValueChange).toHaveBeenCalledWith("no")
    await waitFor(() => expect(body.queryByRole("listbox")).not.toBeInTheDocument())
    await expect(trigger).toHaveFocus()
  },
}
export const Selected: Story = { args: { defaultValue: "yes" } }
export const Open: Story = {
  args: { defaultValue: "yes" },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    within(canvasElement).getByRole("combobox").focus()
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(body.getByRole("listbox")).toBeVisible())
    await waitFor(() => expect(body.getAllByRole("option")[0]).toHaveFocus())
  },
}
export const Disabled: Story = {
  args: { disabled: true },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("combobox")).toBeDisabled()
  },
}
