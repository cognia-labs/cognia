import { useTranslations as englishTranslator } from "next-intl"

import {
  isImageFile,
  isShareablePart,
  markdownFence,
  partPlainText,
  partShare,
  renderPartHtml,
  renderPartMarkdown,
  renderPartText,
  type PartRenderContext,
} from "./descriptors"
import { partLabelsFrom } from "./labels"

// The global next-intl mock resolves keys against the generated en.json.
const ctx: PartRenderContext = { labels: partLabelsFrom(englishTranslator("export.document")) }

const all = (part: unknown) => ({
  markdown: renderPartMarkdown(part, ctx),
  html: renderPartHtml(part, ctx),
  text: renderPartText(part, ctx),
})

describe("plain text by purpose", () => {
  it("keeps reasoning, tool inputs and sources to search", () => {
    const reasoning = { type: "reasoning", text: "weighing options" }
    const tool = { type: "tool-Bash", input: { command: "ls -la" }, output: "huge listing" }
    const sources = {
      type: "sources",
      sources: [{ id: "1", title: "Guide", url: "https://example.com", origin: "cognia-web" }],
    }
    for (const purpose of ["preview", "model-context"] as const) {
      expect(partPlainText(reasoning, purpose)).toBe("")
      expect(partPlainText(tool, purpose)).toBe("")
      expect(partPlainText(sources, purpose)).toBe("")
    }
    expect(partPlainText(reasoning, "search")).toBe("weighing options")
    expect(partPlainText(tool, "search")).toBe("Bash ls -la")
    expect(partPlainText(tool, "search")).not.toContain("huge listing")
    expect(partPlainText(sources, "search")).toBe("Guide https://example.com")
    expect(
      partPlainText(
        {
          type: "sources",
          sources: [
            {
              id: "mem-src",
              title: "Private memory excerpt",
              snippet: "secret preference",
              origin: "memory",
            },
            {
              id: "claim-src",
              title: "Private project claim",
              snippet: "secret claim",
              origin: "project-claim",
            },
            {
              id: "pub-src",
              title: "Public doc",
              url: "https://example.org",
              origin: "cognia-web",
            },
          ],
        },
        "search"
      )
    ).toBe("Public doc https://example.org")
  })

  it("names a file for a model and finds it by name, never reading its payload", () => {
    const file = { type: "file", filename: "spec.pdf", mediaType: "application/pdf", url: "data:x" }
    expect(partPlainText(file, "model-context")).toBe("[attached file: spec.pdf (application/pdf)]")
    expect(partPlainText(file, "search")).toBe("spec.pdf")
    expect(partPlainText(file, "preview")).toBe("")
  })

  it("reads an interactive surface through its plain-text mirror", () => {
    expect(partPlainText({ type: "a2ui", plainTextMirror: "Approve | Reject" }, "preview")).toBe(
      "Approve | Reject"
    )
  })

  it("has no text for a card, an unknown part or something that is not a part", () => {
    expect(partPlainText({ type: "artifact", title: "Plan", kind: "document" }, "search")).toBe("")
    expect(partPlainText({ type: "data-future" }, "search")).toBe("")
    expect(partPlainText(null, "search")).toBe("")
    expect(partPlainText({ text: "no type" }, "search")).toBe("")
  })
})

describe("share", () => {
  it("hands over typed text with block HTML, and leaves a video description out", () => {
    const share = partShare({ type: "text", text: "# Title\n\n- one\n- two" })
    expect(share?.plain).toBe("# Title\n\n- one\n- two")
    expect(share?.html).toContain("<h1>Title</h1>")
    expect(share?.html).toContain("<li>one</li>")
    expect(isShareablePart({ type: "text", text: "" })).toBe(false)
  })

  it("attaches an inline image and names it in share-sheet text", () => {
    const share = partShare({
      type: "file",
      url: "data:image/png;base64,AAAA",
      mediaType: "image/png",
      filename: "shot.png",
    })
    expect(share?.plain).toBe("![shot.png](data:image/png;base64,AAAA)")
    expect(share?.native).toBe("shot.png")
    expect(share?.image).toEqual({
      url: "data:image/png;base64,AAAA",
      filename: "shot.png",
      mediaType: "image/png",
    })
  })

  it("does not share reasoning, tools or cards", () => {
    for (const part of [
      { type: "reasoning", text: "x" },
      { type: "tool-Bash", input: {} },
      { type: "artifact", title: "Plan", kind: "document" },
      { type: "a2ui", surfaceId: "s", content: "{}" },
    ]) {
      expect(isShareablePart(part)).toBe(false)
      expect(partShare(part)).toBeNull()
    }
  })
})

describe("export representations", () => {
  it("renders block Markdown as HTML with raw HTML and unsafe links neutralised", () => {
    const html = renderPartHtml(
      {
        type: "text",
        text: "## Steps\n\n1. **Run** it\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [ok](https://example.com)",
      },
      ctx
    )
    expect(html).toContain("<h2>Steps</h2>")
    expect(html).toContain("<ol>")
    expect(html).toContain("<strong>Run</strong>")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).not.toContain("javascript:")
    expect(html).toContain('<a href="https://example.com"')
  })

  it("gives every card a labelled representation in each format", () => {
    expect(all({ type: "artifact", title: "Plan", kind: "document" })).toEqual({
      markdown: "> *Artifact (document): Plan*",
      html: '<div class="part-card part-artifact"><p class="part-card-title">Artifact (document): Plan</p></div>',
      text: "[Artifact (document): Plan]",
    })
    expect(renderPartText({ type: "canvas", canvasId: "c", title: "Notes" }, ctx)).toBe(
      "[Canvas: Notes]"
    )
    const subagent = renderPartMarkdown(
      { type: "subagent", name: "Researcher", status: "completed", finalResponse: "Found it." },
      ctx
    )
    expect(subagent).toBe("> **Subagent Researcher (completed)**\n>\n> Found it.")
    expect(renderPartText({ type: "squad-gate", title: "Budget", decision: "approved" }, ctx)).toBe(
      "[Budget: approved]"
    )
    expect(
      renderPartText(
        { type: "verification-verdict", status: "completed", verdict: "fail", points: ["a"] },
        ctx
      )
    ).toBe("[Verification: failed]\n- a")
    expect(
      renderPartText(
        { type: "grounding", claims: [{ supported: true }, { supported: false }] },
        ctx
      )
    ).toBe("[1 of 2 claims supported by sources]")
  })

  it("leaves a note where an interactive surface was, with its mirror", () => {
    expect(renderPartText({ type: "a2ui", surfaceId: "s", content: "{}" }, ctx)).toBe(
      "[Interactive surface — not exported]"
    )
    expect(
      renderPartMarkdown({ type: "a2ui", surfaceId: "s", content: "{}", text: "Pick one" }, ctx)
    ).toBe("> **Interactive surface — not exported**\n>\n> Pick one")
  })

  it("never drops an unknown part silently, only the structural step markers", () => {
    expect(all({ type: "data-widget" }).text).toBe("[data-widget part — not exported]")
    expect(all({ type: "data-widget" }).html).toContain("data-widget part — not exported")
    expect(all({ type: "step-start" })).toEqual({ markdown: "", html: "", text: "" })
  })

  it("lists web citations and counts the user's own material without listing it", () => {
    const part = {
      type: "sources",
      sources: [
        { id: "1", title: "Docs", url: "https://docs.example.com", origin: "anthropic" },
        { id: "2", title: "My diary", origin: "memory" },
        { id: "3", title: "Twin chunk", origin: "twin-rag" },
        { id: "4", title: "1", origin: "footnote" },
      ],
    }
    const markdown = renderPartMarkdown(part, ctx)
    expect(markdown).toContain("- [Docs](https://docs.example.com)")
    expect(markdown).toContain("2 sources from your own material not exported")
    expect(markdown).not.toContain("My diary")
    expect(renderPartHtml(part, ctx)).not.toContain("Twin chunk")
    expect(renderPartText({ type: "sources", sources: [] }, ctx)).toBe("")
  })

  it("folds tool calls with labelled input, output and error", () => {
    const part = {
      type: "tool-web_search",
      state: "output-error",
      input: { q: "x" },
      errorText: "rate limited",
    }
    const markdown = renderPartMarkdown(part, ctx)
    expect(markdown).toContain("🔧 Tool: Web Search [output-error]")
    expect(markdown).toContain("**Parameters:**")
    expect(markdown).toContain("> ❌ rate limited")
    expect(renderPartHtml(part, { ...ctx, expandDetails: false })).toContain(
      '<details class="tool">'
    )
    expect(renderPartText(part, ctx)).toBe("[Tool: Web Search] output-error\nError: rate limited")
  })

  it("fences a tool output longer than any backtick run inside it", () => {
    const markdown = renderPartMarkdown(
      { type: "tool-Bash", state: "output-available", output: "```\ncode\n```" },
      ctx
    )
    expect(markdown).toContain("````\n```\ncode\n```\n````")
  })

  it("names an inline file in plain text rather than printing its data URL", () => {
    expect(
      renderPartText({ type: "file", filename: "a.png", url: "data:image/png;base64,AAAA" }, ctx)
    ).toBe("a.png")
    expect(renderPartText({ type: "file", url: "https://f/x.pdf" }, ctx)).toBe(
      "File <https://f/x.pdf>"
    )
  })
})

describe("helpers", () => {
  it("classifies image files by MIME, data URL and extension", () => {
    expect(isImageFile({ mediaType: "image/png" })).toBe(true)
    expect(isImageFile({ mediaType: "application/pdf" })).toBe(false)
    expect(isImageFile({ url: "data:image/webp;base64,AAAA" })).toBe(true)
    expect(isImageFile({ url: "data:text/plain;base64,AAAA" })).toBe(false)
    expect(isImageFile({ filename: "photo.JPEG" })).toBe(true)
    expect(isImageFile({ filename: "notes.txt" })).toBe(false)
    expect(isImageFile({})).toBe(false)
  })

  it("picks a fence of at least three backticks", () => {
    expect(markdownFence("plain")).toBe("```")
    expect(markdownFence("a ```` b")).toBe("`````")
  })
})
