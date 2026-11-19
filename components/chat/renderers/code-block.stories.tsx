import type { Meta, StoryObj } from "@storybook/nextjs"

import { expect, waitFor, within } from "storybook/test"

import { CodeBlock } from "./code-block"

const SAMPLE = `export function greet(name: string): string {
  // A friendly greeting
  const trimmed = name.trim()
  if (!trimmed) return "Hello, stranger!"
  return \`Hello, \${trimmed}!\`
}`

const meta = {
  title: "Chat/Renderers/CodeBlock",
  component: CodeBlock,
  args: { code: SAMPLE, language: "typescript" },
  tags: ["quality"],
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "The finalized chat code renderer with real Shiki, shared default One registrations, line controls and local copy. The default ink is corrected against built-in neutral light/dark code surfaces; arbitrary imported palettes need separate checks. Streaming here is the plain fallback, not the real Streamdown engine. Copy keeps the complete original source even when the 2,000-line render budget clips the view. No download/fullscreen actions are automatically invoked.",
      },
    },
  },
  argTypes: {
    code: { control: "text" },
    language: { control: "text" },
    showLineNumbers: { control: "boolean" },
    isStreaming: { control: "boolean" },
    compact: { control: "boolean" },
    wrapLines: { control: "boolean" },
  },
  decorators: [
    (Story) => (
      <div className="w-[48rem] max-w-full">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement, args }) => {
    await expect(within(canvasElement).getByRole("figure")).toBeVisible()
    if (args.language && !args.isStreaming && !args.highlightLines?.length) {
      await waitFor(
        () => expect(canvasElement.querySelector("pre.shiki span[style]")).toBeInTheDocument(),
        { timeout: 10000 }
      )
    }
  },
} satisfies Meta<typeof CodeBlock>

export default meta
type Story = StoryObj<typeof meta>

export const TypeScript: Story = {}

export const WithLineNumbers: Story = {
  args: { showLineNumbers: true, filename: "greet.ts" },
}

export const HighlightedLines: Story = {
  args: { showLineNumbers: true, highlightLines: [2, 4] },
}

// While streaming, Shiki is skipped — plain <pre> with line numbers.
export const Streaming: Story = {
  args: { isStreaming: true },
}

export const PlainText: Story = {
  args: { code: "no language → plain text\nsecond line", language: undefined },
}

// Nested inside a file-tool row expansion — slim header, tight padding.
export const Compact: Story = {
  args: { compact: true, showLineNumbers: true },
}

export const WrappedLongLine: Story = {
  args: { code: `const longLabel = "${"synthetic-你好-".repeat(40)}"`, wrapLines: true },
}

export const LongSource: Story = {
  args: {
    code: [
      ...Array.from({ length: 2001 }, (_, index) => `// Line ${index}: 你好`),
      "// COMPLETE_SOURCE_TAIL",
    ].join("\r\n"),
    capHeight: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          "The view is clipped at the real render budget. Copy must retain every line, CRLF and Unicode character, including COMPLETE_SOURCE_TAIL beyond the visible slice.",
      },
    },
  },
}
