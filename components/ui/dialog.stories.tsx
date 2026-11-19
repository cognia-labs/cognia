import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { Button } from "./button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog"

const meta = {
  title: "UI/Dialog",
  component: Dialog,
  tags: ["quality"],
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Real portal, modal focus trap and Escape dismissal. All controls are translated. No permission is granted or file written; the dialog illustrates keyboard/modal composition. Keep portal scenarios on individual canvases.",
      },
    },
  },
  argTypes: { defaultOpen: { control: "boolean" } },
  render: function Example(args) {
    const t = useTranslations("common")
    const permissions = useTranslations("creator.permissions")
    return (
      <Dialog {...args}>
        <DialogTrigger asChild>
          <Button className="m-8">{t("edit")}</Button>
        </DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("confirm")}</DialogTitle>
            <DialogDescription>{permissions("writesBlocked")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">{t("cancel")}</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button>{t("confirm")}</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  },
} satisfies Meta<typeof Dialog>
export default meta
type Story = StoryObj<typeof meta>
export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole("button")
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(trigger)
    await waitFor(() => expect(body.getByRole("dialog")).toBeVisible())
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(body.queryByRole("dialog")).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  },
}
export const Open: Story = { args: { defaultOpen: true } }
