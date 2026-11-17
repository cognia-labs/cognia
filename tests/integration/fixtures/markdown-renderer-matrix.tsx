// D7 feature matrix: the finished renderer (`MarkdownRenderer`, one tree), a
// long finished reply drawn as lazy sections (`FinalizedLongTextPart`) and the
// streaming branch (`StreamingTextPart`, one Streamdown tree per block) must
// agree on everything the shared configuration decides. Runs outside Jest's
// simplified react-markdown mock; only the expensive leaf renderers are
// replaced (the heavy test aliases `next/dynamic` to a chunk that names its
// renderer).
import React, { act } from "react"
import { createRoot } from "react-dom/client"
import { createRequire } from "node:module"
import { NextIntlClientProvider } from "next-intl"

import { MarkdownRenderer } from "@/components/chat/markdown-renderer"
import { FinalizedLongTextPart, StreamingTextPart } from "@/components/chat/streaming-text-part"
import { TooltipProvider } from "@/components/ui/tooltip"
import messages from "@/i18n/messages/en.json"

const features = [
  "## Setup",
  "",
  "Inline \\(x^2\\) and display:",
  "",
  "\\[y^2\\]",
  "",
  "## Setup",
  "",
  "```diff\n-old\n+new\n```",
  "",
  "```mermaid\ngraph TD\n  A-->B\n```",
  "",
  "[project](file:///repo/file.ts) [site](https://example.com) [unsafe](javascript:alert(1))",
  "",
  "### Setup",
].join("\n")

// Twenty-four blocks: three lazy sections, the same heading in each.
const long = Array.from({ length: 12 }, (_, index) => `## Setup\n\nParagraph ${index}.`).join(
  "\n\n"
)

// A tree resolves references and footnotes only against its own definitions,
// so a reply with any renders as one tree on every path.
const definitions = [
  long,
  "See [the guide][guide] and a claim.[^1]",
  "[guide]: https://example.com/guide",
  "[^1]: The source.",
].join("\n\n")

function summarize(container: Element) {
  const count = (selector: string) => container.querySelectorAll(selector).length
  return {
    headingIds: [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map(
      (heading) => heading.id
    ),
    // The finished branch draws math through `<MathInline>` / `<MathBlock>`
    // chunks, Streamdown through KaTeX; either way two expressions render.
    math: count('[data-chunk="MathInline"], [data-chunk="MathBlock"]') + count(".katex"),
    rawLatex: (container.textContent ?? "").includes("\\("),
    diff: count('[data-chunk="DiffBlock"]'),
    mermaid: count('[data-chunk="MermaidBlock"]'),
    file: count('a[href^="file:"]'),
    web: count('a[href^="https:"]'),
    unsafe: count('a[href^="javascript:"]'),
    reference: count('a[href="https://example.com/guide"]'),
    footnotes: count("[data-footnotes] li"),
  }
}

async function main() {
  // JSDOM is supplied by the existing Jest environment, not an app dependency.
  const { JSDOM } = createRequire(require.resolve("jest-environment-jsdom"))("jsdom")
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com" })
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  if (!dom.window.matchMedia) {
    Object.assign(dom.window, {
      matchMedia: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
      }),
    })
  }
  Object.assign(globalThis, { matchMedia: dom.window.matchMedia })

  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error
  const errors: string[] = []
  console.log = () => undefined
  console.warn = () => undefined
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "))

  async function draw(element: React.ReactElement) {
    const container = document.createElement("div")
    document.body.append(container)
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <TooltipProvider>{element}</TooltipProvider>
        </NextIntlClientProvider>
      )
    )
    // Lazy sections mount on the next frame without IntersectionObserver.
    for (let frame = 0; frame < 4; frame++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 5)))
    }
    const summary = summarize(container)
    const sections = container.querySelectorAll('[data-testid="finalized-markdown-section"]').length
    await act(async () => root.unmount())
    container.remove()
    return { ...summary, sections }
  }

  try {
    const result = {
      features: {
        finalized: await draw(<MarkdownRenderer content={features} />),
        streaming: await draw(<StreamingTextPart text={features} isStreaming />),
      },
      long: {
        finalized: await draw(<MarkdownRenderer content={long} />),
        sections: await draw(<FinalizedLongTextPart text={long} />),
        streaming: await draw(<StreamingTextPart text={long} isStreaming />),
      },
      definitions: {
        finalized: await draw(<MarkdownRenderer content={definitions} />),
        sections: await draw(<FinalizedLongTextPart text={definitions} />),
        streaming: await draw(<StreamingTextPart text={definitions} isStreaming />),
      },
      mentions: await (async () => {
        const container = document.createElement("div")
        document.body.append(container)
        const root = createRoot(container)
        await act(async () =>
          root.render(
            <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
              <TooltipProvider>
                <MarkdownRenderer
                  content={"**Hi** @Alice, see `@Alice` and [@Alice](https://example.com)"}
                  mentions={[{ name: "Alice", color: "rgb(1, 2, 3)" }]}
                />
              </TooltipProvider>
            </NextIntlClientProvider>
          )
        )
        const chips = [...container.querySelectorAll("[data-mention]")]
        const summary = {
          strong: container.querySelectorAll("strong").length,
          chips: chips.map((chip) => [
            chip.textContent,
            chip.getAttribute("data-mention"),
            (chip as HTMLElement).style.color,
          ]),
        }
        await act(async () => root.unmount())
        container.remove()
        return summary
      })(),
      errors,
    }
    process.stdout.write("\nMARKDOWN_MATRIX_RESULT=" + JSON.stringify(result))
  } finally {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    dom.window.close()
  }
}

// Logger transports used by the real error boundaries keep background timers.
void main().then(() => process.exit(0))
