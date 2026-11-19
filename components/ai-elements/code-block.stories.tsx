import type { Meta, StoryObj } from "@storybook/nextjs"
import { useState } from "react"
import { useTranslations } from "next-intl"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { Button } from "@/components/ui/button"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "./code-block"

const SAMPLE = '// Synthetic comment\nexport const marker = "你好"\nconst total = 42'
const PREFIX = `// ${"x".repeat(110)}\n`
const SUFFIX = `\n// ${"y".repeat(110)}`

const meta = {
  title: "AI Elements/CodeBlock",
  component: CodeBlock,
  tags: ["quality", "autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "The real token-based AI Elements code primitive. It shares corrected default One theme inputs with the streaming and finalized chat renderers. Copy writes the original fixture text through the browser clipboard API; automated checks capture that boundary locally. The edit example replaces equal-length source with identical first/last 100 characters, so cached tokens must follow the full source identity. No model, host or download is invoked.",
      },
    },
  },
  args: { code: SAMPLE, language: "typescript", showLineNumbers: false },
  argTypes: {
    code: { control: "text" },
    language: { control: "text" },
    showLineNumbers: { control: "boolean" },
  },
  render: function Example(args) {
    const t = useTranslations("common")
    return (
      <div className="w-[48rem] max-w-full">
        <CodeBlock {...args}>
          <CodeBlockHeader>
            <CodeBlockTitle>
              <CodeBlockFilename>fixture.ts</CodeBlockFilename>
            </CodeBlockTitle>
            <CodeBlockActions>
              <CodeBlockCopyButton aria-label={t("copy")} />
            </CodeBlockActions>
          </CodeBlockHeader>
        </CodeBlock>
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () =>
        expect(canvasElement.querySelector('code span[style*="--shiki-dark"]')).toBeInTheDocument(),
      { timeout: 10000 }
    )
    await expect(canvasElement.querySelector("pre")!.style.backgroundColor).not.toBe("")
    await expect(
      canvasElement.querySelector("pre")!.style.getPropertyValue("--shiki-dark-bg")
    ).not.toBe("")
  },
} satisfies Meta<typeof CodeBlock>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const LineNumbers: Story = { args: { showLineNumbers: true } }
export const ChangedMiddle: Story = {
  render: function Changed() {
    const [changed, setChanged] = useState(false)
    const t = useTranslations("common")
    return (
      <div className="w-[48rem] max-w-full space-y-3">
        <Button onClick={() => setChanged(!changed)}>{t("edit")}</Button>
        <CodeBlock
          code={`${PREFIX}const marker = "${changed ? "AFTER!" : "BEFORE"}"${SUFFIX}`}
          language="typescript"
        />
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    await waitFor(
      () =>
        expect(canvasElement.querySelector('code span[style*="--shiki-dark"]')).toBeInTheDocument(),
      { timeout: 10000 }
    )
    const code = canvasElement.querySelector("pre code")!
    await expect(code).toHaveTextContent("BEFORE")
    await userEvent.click(within(canvasElement).getByRole("button"))
    await waitFor(
      () => {
        expect(code.querySelector('span[style*="--shiki-dark"]')).toBeInTheDocument()
        expect(code).toHaveTextContent("AFTER!")
      },
      { timeout: 10000 }
    )
    await expect(code).not.toHaveTextContent("BEFORE")
  },
}
