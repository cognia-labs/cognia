import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { Task, TaskContent, TaskItem, TaskItemFile, TaskTrigger } from "./task"
import { Button } from "@/components/ui/button"

const meta = {
  title: "AI Elements/Task",
  component: Task,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Task disclosure using a real keyboard-focusable trigger, with a synthetic file token. No task execution or filesystem access. Expanded/collapsed states demonstrate compound component composition.",
      },
    },
  },
  args: { defaultOpen: true },
  argTypes: { defaultOpen: { control: "boolean" } },
  render: function Example(args) {
    const t = useTranslations("common")
    return (
      <div className="w-96 max-w-full">
        <Task {...args}>
          <TaskTrigger title={t("more")}>
            <Button variant="ghost">{t("more")}</Button>
          </TaskTrigger>
          <TaskContent>
            <TaskItem>{t("confirm")}</TaskItem>
            <TaskItemFile>{"src/example.ts"}</TaskItemFile>
          </TaskContent>
        </Task>
      </div>
    )
  },
} satisfies Meta<typeof Task>
export default meta
type Story = StoryObj<typeof meta>
export const Expanded: Story = {}
export const Collapsed: Story = { args: { defaultOpen: false } }
