import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { Button } from "./button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./dropdown-menu"

const select = fn()
const meta = {
  title: "UI/DropdownMenu",
  component: DropdownMenu,
  tags: ["quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real portalled menu, keyboard activation and focus restoration. Menu actions record a spy; they never save, edit or cancel an actual object. Includes the local primitive's click-only activation fallback. Keep portal examples on individual canvases. The standalone trigger background becomes inert while the modal popup is open; the example includes that integration wrapper.",
      },
    },
  },
  argTypes: { defaultOpen: { control: "boolean" } },
  beforeEach: () => {
    select.mockClear()
  },
  render: function Example(args) {
    const t = useTranslations("common")
    const [open, setOpen] = useState(args.defaultOpen ?? false)
    return (
      <div inert={open}>
        <DropdownMenu
          {...args}
          onOpenChange={(value) => {
            setOpen(value)
            args.onOpenChange?.(value)
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="outline">{t("more")}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t("confirm")}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => select("save")}>{t("save")}</DropdownMenuItem>
              <DropdownMenuItem disabled>{t("edit")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => select("cancel")}>
                {t("cancel")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  },
} satisfies Meta<typeof DropdownMenu>
export default meta
type Story = StoryObj<typeof meta>

export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole("button")
    const body = within(canvasElement.ownerDocument.body)
    trigger.focus()
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(body.getByRole("menu")).toBeVisible())
    await userEvent.keyboard("{Home}{Enter}")
    await expect(select).toHaveBeenCalledWith("save")
    await waitFor(() => expect(body.queryByRole("menu")).not.toBeInTheDocument())
    await expect(trigger).toHaveFocus()
  },
}
export const ClickOnly: Story = {
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole("button")
    const body = within(canvasElement.ownerDocument.body)
    trigger.click()
    await waitFor(() => expect(body.getByRole("menu")).toBeVisible())
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(body.queryByRole("menu")).not.toBeInTheDocument())
    await expect(select).not.toHaveBeenCalled()
  },
}
export const Open: Story = {
  play: async ({ canvasElement }) => {
    within(canvasElement).getByRole("button").focus()
    await userEvent.keyboard("{Enter}")
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() => expect(body.getByRole("menu")).toBeVisible())
    await waitFor(() => expect(body.getAllByRole("menuitem")[0]).toHaveFocus())
  },
}
