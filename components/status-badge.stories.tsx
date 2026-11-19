import type { Meta, StoryObj } from "@storybook/nextjs"

import { StatusBadge } from "./status-badge"

// Reuse a namespace that already has status labels so t(value) resolves.
const meta = {
  title: "Shared/StatusBadge",
  component: StatusBadge,
  tags: ["autodocs", "quality"],
  parameters: {
    docs: {
      description: {
        component:
          "Translated status pill. Resolves value under labelNamespace, then falls back to the raw value when a translation is missing. variantMap overrides the built-in status colors; fallbackVariant handles unknown values. The Locale and Theme toolbar controls use the real app messages and CSS. This isolated component needs no database, store, native host, or provider credentials.",
      },
    },
  },
  // Prop extraction is disabled globally; keep this small contract explicit.
  argTypes: {
    value: {
      control: "text",
      description: "Status key within labelNamespace; unknown keys render verbatim.",
    },
    labelNamespace: {
      control: "text",
      description: "Existing next-intl namespace containing status labels.",
    },
    variantMap: { control: "object", description: "Optional per-status variant overrides." },
    fallbackVariant: {
      control: "select",
      options: [
        "default",
        "secondary",
        "destructive",
        "success",
        "warning",
        "outline",
        "ghost",
        "link",
      ],
      description: "Variant used when neither the custom nor built-in map contains value.",
      table: { defaultValue: { summary: "outline" } },
    },
    pulse: {
      control: "boolean",
      description: "Show a decorative status dot; inspect reduced-motion behavior separately.",
      table: { defaultValue: { summary: "false" } },
    },
    pulseClassName: {
      control: "text",
      description: "Optional CSS classes for the decorative dot.",
    },
    className: { control: "text", description: "Optional CSS classes passed to the badge." },
  },
  args: { labelNamespace: "twin.status", value: "running" },
} satisfies Meta<typeof StatusBadge>

export default meta
type Story = StoryObj<typeof meta>

// default variant (positive / active)
export const Positive: Story = { args: { value: "completed" } }
// outline variant (neutral)
export const Neutral: Story = { args: { value: "paused" } }
// destructive variant
export const Destructive: Story = { args: { value: "failed" } }

export const WithPulse: Story = { args: { value: "running", pulse: true } }

// Missing keys fall back to the raw value rather than throwing.
export const RawFallback: Story = {
  tags: ["!quality"],
  args: { value: "some-unmapped-state" },
  parameters: {
    docs: {
      description: {
        story:
          "Intentionally exercises a missing translation. The badge shows the raw status; next-intl may also log its missing-message diagnostic.",
      },
    },
  },
}

export const CustomVariant: Story = {
  args: { value: "running", variantMap: { running: "secondary" } },
  parameters: {
    docs: {
      description: { story: "A custom map takes precedence over the built-in running variant." },
    },
  },
}

export const VariantMatrix: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(["completed", "running", "paused", "pending", "failed", "rejected"] as const).map((v) => (
        <StatusBadge key={v} labelNamespace="twin.status" value={v} />
      ))}
    </div>
  ),
}
