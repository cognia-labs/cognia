import type { Meta, StoryObj } from "@storybook/nextjs"
import type { UIMessage } from "ai"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { expect, waitFor } from "storybook/test"
import { Button } from "@/components/ui/button"
import { StreamingTextPart } from "@/components/chat/streaming-text-part"

import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { MessageShell } from "@/components/chat/message-shell"
import { resolveMessageDisplayOptions } from "@/lib/chat/message-display"
import type { MessageDisplayOverrides } from "@/types/appearance"

// ADR-0218 — one assistant turn exercising every part of the chat reading
// surface: link styles and previews, inline code, highlight, an alert, a
// table, a code block, a mermaid diagram and an inline chart. Use the
// overrides to compare text size, spacing, link style, block density and the
// code theme side by side.
const SAMPLE = [
  "## Rendering audit",
  "",
  "The kit lives at https://github.com/deepseek-ai/dsh-libreoffice-kit, and the",
  "[official font notes](https://developer.mozilla.org/en-US/docs/Web/CSS/font-family)",
  "explain the fallback chain. See `lib/chat/code-theme.ts` for the theme pairs,",
  "and note the <mark>highlighted</mark> caveat.",
  "",
  "> [!TIP]",
  "> Links take the **`--link`** token now — see [the ADR](https://example.com/adr).",
  "",
  "| Surface | Before | After | Δ ms |",
  "| --- | --- | ---: | ---: |",
  "| Code block | card in card | one frame | 12 |",
  "| Table | square grid | rounded, hover | 4 |",
  "| Mermaid | stock theme | app palette | 31 |",
  "",
  "```ts",
  "export function resolveChatCodeTheme(id?: ChatCodeThemeId) {",
  "  return (id && CHAT_CODE_THEMES[id]) || CHAT_CODE_THEME",
  "}",
  "```",
  "",
  "```mermaid",
  "graph LR",
  '  A["Streaming"] --> B["Finalised"]',
  '  B --> C["Same frame"]',
  "```",
  "",
  "```chart",
  '{"type":"bar","title":"Render cost","data":[{"name":"Code","before":40,"after":12},{"name":"Table","before":9,"after":4},{"name":"Mermaid","before":55,"after":31}]}',
  "```",
].join("\n")

interface ReadingSurfaceStoryProps {
  overrides?: MessageDisplayOverrides
  content?: string
}

function ReadingSurfaceStory({ overrides, content = SAMPLE }: ReadingSurfaceStoryProps) {
  const display = resolveMessageDisplayOptions({ preset: "balanced", overrides })
  const message: UIMessage = {
    id: "reading-surface",
    role: "assistant",
    parts: [{ type: "text", text: content }],
    metadata: { createdAt: 1_700_000_000_000 },
  }
  return (
    <div className="max-w-[52rem]">
      <MessageShell message={message} display={display}>
        <MarkdownRenderer content={content} markdown={display.markdown} messageId={message.id} />
      </MessageShell>
    </div>
  )
}

const meta = {
  title: "Chat/ReadingSurface",
  component: ReadingSurfaceStory,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Composed reading-surface demonstrations with real MessageShell and MarkdownRenderer. The older examples include links, diagrams and charts and remain manual previews. The individually tagged code parity examples use only synthetic code and the actual Streamdown/finalized engines, with local phase state and no model, host or settings persistence.",
      },
    },
  },
  argTypes: { overrides: { control: "object" }, content: { control: "text" } },
} satisfies Meta<typeof ReadingSurfaceStory>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const LargeRelaxed: Story = {
  args: { overrides: { reading: { textSize: "lg", spacing: "relaxed" } } },
}

export const CompactTextLinks: Story = {
  args: {
    overrides: {
      reading: { textSize: "sm", spacing: "compact" },
      links: { color: "text", underline: "hover", siteIcon: false },
    },
  },
}

export const ComfortableBlocksGithubTheme: Story = {
  args: { overrides: { markdown: { blockDensity: "comfortable", codeTheme: "github" } } },
}

export const FlushBlocks: Story = {
  args: { overrides: { markdown: { blockBorder: false, blockHeader: false } } },
}

const CODE_SOURCE = '// Synthetic comment\nexport const marker = "你好"\nconst total = 42'
function CodeParitySurface({ theme = "one" }: { theme?: "one" | "github" }) {
  const [finished, setFinished] = useState(false)
  const t = useTranslations("common")
  const display = resolveMessageDisplayOptions({
    preset: "balanced",
    overrides: { markdown: { codeTheme: theme } },
  })
  const content = `\`\`\`typescript\n${CODE_SOURCE}\n\`\`\``
  const message: UIMessage = {
    id: "storybook-code-parity",
    role: "assistant",
    parts: [{ type: "text", text: content }],
  }
  return (
    <div className="w-[48rem] max-w-full space-y-3">
      <Button onClick={() => setFinished(!finished)}>{t(finished ? "cancel" : "confirm")}</Button>
      <div data-code-phase={finished ? "finalized" : "streaming"}>
        <MessageShell message={message} display={display}>
          {finished ? (
            <MarkdownRenderer content={content} markdown={display.markdown} />
          ) : (
            <StreamingTextPart text={content} isStreaming markdown={display.markdown} />
          )}
        </MessageShell>
      </div>
    </div>
  )
}

export const DefaultCodeParity: Story = {
  tags: ["quality"],
  parameters: {
    docs: {
      description: {
        story:
          "Real Streamdown starts with a complete synthetic fence while the turn is still streaming. Confirm finalizes it through the actual MarkdownRenderer; Cancel returns to streaming. Both use the default One pair and shared accessible registrations. The browser compares actual token colours and source text across the swap, not the plain CodeBlock fallback.",
      },
    },
  },
  render: () => <CodeParitySurface />,
  play: async ({ canvasElement }) => {
    await waitFor(
      () =>
        expect(
          canvasElement.querySelector(
            '[data-streamdown="code-block-body"] code span[style*="--shiki-dark"]'
          )
        ).toBeInTheDocument(),
      { timeout: 10000 }
    )
  },
}
export const GithubCodeParity: Story = {
  ...DefaultCodeParity,
  tags: ["quality"],
  parameters: {
    docs: {
      description: {
        story:
          "The same real stream/final swap under the supported GitHub pair. Its registration also receives the shared readable-ink correction; the logical selected theme remains GitHub. Tags are explicit because the static story index does not inherit them from a spread story object.",
      },
    },
  },
  render: () => <CodeParitySurface theme="github" />,
}
