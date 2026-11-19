import type { Meta, StoryObj } from "@storybook/nextjs"
import { useTranslations } from "next-intl"
import { Spinner } from "./spinner"
import { Skeleton } from "./skeleton"
import { Progress } from "./progress"

const meta = {
  title: "UI/Loading",
  component: Spinner,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Real spinner, skeleton and determinate progress primitives. Standalone status has a translated name; decorative graphics stay silent. The fixed-size visual fixture is a CSS/token baseline, not a claim about data loading or native readiness.",
      },
    },
  },
  argTypes: {
    className: { control: "text" },
    label: {
      control: "text",
      description: "Localize only when the spinner is the sole status indicator.",
    },
  },
  render: function Standalone(args) {
    const t = useTranslations("common")
    return <Spinner {...args} label={t("loading")} />
  },
} satisfies Meta<typeof Spinner>
export default meta
type Story = StoryObj<typeof meta>
export const Announced: Story = {}
export const Visual: Story = {
  render: function LoadingFixture() {
    const t = useTranslations("common")
    return (
      <section
        aria-label={t("loading")}
        className="w-96 max-w-full space-y-5 rounded-xl border bg-card p-6"
      >
        <div className="flex items-center gap-4">
          <Spinner label={t("loading")} />
          <div aria-hidden="true" className="grid flex-1 gap-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
        <Progress value={60} aria-label={t("loading")} />
      </section>
    )
  },
}
