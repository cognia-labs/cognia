import type { Meta, StoryObj } from "@storybook/nextjs"

import { ApiKeyInput } from "./api-key-input"
import { __resetSpeechProviderKeysForTests } from "@/lib/speech/provider-keys"

// `ApiKeyInput` reads the stored key from the speech module's provider-key
// mirror (`lib/speech/provider-keys.ts`) and renders the "configured" badge +
// Clear button only when a key is present. Reset the mirror each story (as
// loaded, so it never reaches for the keyring) so a seeded key never leaks
// into the empty case.
const meta = {
  title: "Settings/Speech/ApiKeyInput",
  component: ApiKeyInput,
  args: { provider: "openai", label: "OpenAI", placeholder: "sk-…" },
  parameters: { layout: "padded" },
  beforeEach: () => {
    __resetSpeechProviderKeysForTests({}, true)
  },
} satisfies Meta<typeof ApiKeyInput>

export default meta
type Story = StoryObj<typeof meta>

// No stored key → "not configured" badge, Save disabled (draft is empty), no Clear.
export const NotConfigured: Story = {}

// A key is stored → "configured" badge + Clear button; the input is pre-filled
// (masked) and Save stays disabled until the draft diverges.
export const Configured: Story = {
  beforeEach: () => {
    __resetSpeechProviderKeysForTests({ openai: "sk-demo-configured-key" }, true)
  },
}

// A different provider with its own placeholder.
export const ElevenLabs: Story = {
  args: { provider: "elevenlabs", label: "ElevenLabs", placeholder: "sk_…" },
}
