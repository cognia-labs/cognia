import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs"

const meta = {
  title: "UI/Tabs",
  component: Tabs,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real tabs with actual labelled panels, translated text and a disabled third tab. Arrow-key activation selects its matching panel; Escape is not a dismissal gesture here. Only local component state changes and the callback is a spy.",
      },
    },
  },
  args: { defaultValue: "yes", onValueChange: fn() },
  argTypes: {
    defaultValue: { control: "select", options: ["yes", "no"] },
    orientation: { control: "select", options: ["horizontal", "vertical"] },
    onValueChange: { description: "Records active panel, not a navigation or save." },
  },
  render: function Example(args) {
    const t = useTranslations("common")
    return (
      <Tabs {...args} className="w-80 max-w-full">
        <TabsList aria-label={t("confirm")}>
          <TabsTrigger value="yes">{t("yes")}</TabsTrigger>
          <TabsTrigger value="no">{t("no")}</TabsTrigger>
          <TabsTrigger value="cancel" disabled>
            {t("cancel")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="yes">{t("save")}</TabsContent>
        <TabsContent value="no">{t("edit")}</TabsContent>
        <TabsContent value="cancel">{t("cancel")}</TabsContent>
      </Tabs>
    )
  },
} satisfies Meta<typeof Tabs>
export default meta
type Story = StoryObj<typeof meta>

export const Keyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const tabs = canvas.getAllByRole("tab")
    tabs[0]!.focus()
    await userEvent.keyboard("{ArrowRight}")
    await waitFor(() => expect(tabs[1]).toHaveAttribute("aria-selected", "true"))
    await expect(tabs[1]).toHaveFocus()
    await expect(canvas.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tabs[1]!.id)
    await expect(args.onValueChange).toHaveBeenCalledWith("no")
    await expect(tabs[2]).toBeDisabled()
  },
}
export const SecondPanel: Story = { args: { defaultValue: "no" } }
export const Vertical: Story = { args: { orientation: "vertical" } }
