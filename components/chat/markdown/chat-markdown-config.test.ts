import { readFileSync } from "node:fs"
import path from "node:path"

import { MESSAGE_MATH_FONT_SCALES } from "@/types/appearance"

import { mathScaleClass, resolveChatMarkdownConfig } from "./chat-markdown-config"
import { preprocessLatex, rehypeMarkdownHeadingIds } from "./markdown-plugins"
import { chatMarkdownUrlTransform, untrustedMarkdownUrlTransform } from "./rendering-policy"

describe("resolveChatMarkdownConfig", () => {
  it("fills every knob from the chat defaults and caches by input", () => {
    const config = resolveChatMarkdownConfig()
    expect(config.options.math).toBe(true)
    expect(config.math).toBe(true)
    expect(config.preprocess).toBe(preprocessLatex)
    expect(config.rehypePlugins.at(-1)).toBe(rehypeMarkdownHeadingIds)
    expect(config.rehypePluginsForSections).not.toContain(rehypeMarkdownHeadingIds)
    expect(config.urlTransform).toBe(chatMarkdownUrlTransform)
    expect(config.className).toContain("typeset typeset-chat")
    expect(resolveChatMarkdownConfig({})).toBe(config)
    expect(resolveChatMarkdownConfig({ mermaid: false })).not.toBe(config)
  })

  it("turns knobs Streamdown cannot take as props into classes", () => {
    const config = resolveChatMarkdownConfig({
      codeWrap: true,
      mathFontScale: 1.2,
      mathAlign: "left",
    })
    expect(config.knobClassName.split(" ").sort()).toEqual(
      ["[&_pre]:whitespace-pre-wrap", "chat-math-lg", "chat-math-left"].sort()
    )
    expect(config.className).toContain(config.knobClassName)
  })

  it("restricts untrusted text and keeps math off unless it is a document", () => {
    const untrusted = resolveChatMarkdownConfig(undefined, { untrusted: true })
    expect(untrusted.math).toBe(false)
    expect(untrusted.preprocess("\\[x\\]")).toBe("\\[x\\]")
    expect(untrusted.urlTransform).toBe(untrustedMarkdownUrlTransform)
    expect(untrusted.rehypePlugins).not.toBe(resolveChatMarkdownConfig().rehypePlugins)

    expect(
      resolveChatMarkdownConfig(undefined, { untrusted: true, untrustedMath: true }).math
    ).toBe(true)
    expect(resolveChatMarkdownConfig({ math: false }).preprocess("\\[x\\]")).toBe("\\[x\\]")
  })
})

describe("mathScaleClass", () => {
  it("adds no math class at the default scale", () => {
    expect(mathScaleClass(1)).toBeUndefined()
  })

  it("gives every declared math scale a class backed by a globals.css rule", () => {
    // The scale cannot ride down as a style/`data-*` attribute — Streamdown
    // spreads anything it does not declare onto the inner react-markdown, which
    // drops it — so the closed scale set and the stylesheet have to stay in
    // step. Without this a new scale renders at 1x while the finalized branch
    // scales, which is exactly the silent divergence ADR-0127 forbids.
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8")
    for (const scale of MESSAGE_MATH_FONT_SCALES) {
      const className = mathScaleClass(scale)
      if (scale === 1) {
        expect(className).toBeUndefined()
        continue
      }
      expect(className).toBeDefined()
      expect(css).toContain(`.${className} .katex-display {`)
      expect(css).toContain(`.${className} .katex {`)
    }
    expect(css).toContain(".chat-math-left .katex-display,")
    expect(css).toContain(".chat-math-left .katex-display > .katex {")
  })
})
