import type { Meta, StoryObj } from "@storybook/nextjs"

import { PetSection } from "./pet-section"

// Settings → Pet: a pointer to the pet page's Appearance & settings, where the
// pet's settings live beside the pet itself.
const meta = {
  title: "Settings/Pet/PetSection",
  component: PetSection,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="w-[640px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PetSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
