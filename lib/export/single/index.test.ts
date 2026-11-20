jest.mock("@/lib/export/text/rich-markdown", () => ({
  exportToRichMarkdown: jest.fn(() => "MD"),
  exportToRichJSON: jest.fn(() => "JSON"),
  exportToPlainText: jest.fn(() => "TXT"),
}))
jest.mock("@/lib/export/html/beautiful-html", () => ({
  exportToBeautifulHtml: jest.fn(() => "<html>BEAUTIFUL</html>"),
}))
jest.mock("@/lib/export/html/animated-html", () => ({
  exportToAnimatedHtml: jest.fn(() => "<html>ANIMATED</html>"),
}))

import { useTranslations as englishTranslator } from "next-intl"
import { exportLabelsFrom } from "@/lib/export/labels"
import { renderSingleExport } from "./index"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"
import * as md from "@/lib/export/text/rich-markdown"
import * as bh from "@/lib/export/html/beautiful-html"
import * as ah from "@/lib/export/html/animated-html"

// The global next-intl mock resolves keys against the generated en.json.
const labels = exportLabelsFrom(englishTranslator("export.document"), "en")

const session: ChatSession = {
  id: "s",
  title: "My Conversation: With/Symbols!",
} as unknown as ChatSession
const messages: StoredMessage[] = []
const date = new Date("2024-01-01T00:00:00Z")

describe("renderSingleExport", () => {
  it("forces a visible Digital Twin marker when provenance is present", () => {
    const out = renderSingleExport({
      format: "text",
      session,
      messages,
      labels,
      exportedAt: date,
      provenance: [{ source: "digital-twin", sourceId: "twin-1", disclosure: "ai-generated" }],
    })
    expect(out.content).toContain("[AI-generated · Digital Twin]")
  })

  it("renders markdown with a filename derived from the title", () => {
    const out = renderSingleExport({
      format: "markdown",
      session,
      messages,
      labels,
      exportedAt: date,
    })
    expect(out.content).toBe("MD")
    expect(out.filename).toBe("My-Conversation-With-Symbols!.md")
    expect(out.mimeType).toBe("text/markdown")
    expect(md.exportToRichMarkdown).toHaveBeenCalled()
  })

  it("renders JSON", () => {
    const out = renderSingleExport({
      format: "json",
      session,
      messages,
      labels,
      exportedAt: date,
    })
    expect(out.content).toBe("JSON")
    expect(out.filename.endsWith(".json")).toBe(true)
    expect(out.mimeType).toBe("application/json")
  })

  it("renders plain text", () => {
    const out = renderSingleExport({
      format: "text",
      session,
      messages,
      labels,
      exportedAt: date,
    })
    expect(out.content).toBe("TXT")
    expect(out.filename.endsWith(".txt")).toBe(true)
    expect(out.mimeType).toBe("text/plain")
  })

  it("renders HTML and forwards theme/customTheme/metadata flags", () => {
    const out = renderSingleExport({
      format: "html",
      session,
      messages,
      labels,
      exportedAt: date,
      theme: "dark",
      includeMetadata: true,
      includeTimestamps: false,
    })
    expect(out.content).toBe("<html>BEAUTIFUL</html>")
    expect(out.filename.endsWith(".html")).toBe(true)
    expect(out.mimeType).toBe("text/html")
    expect(bh.exportToBeautifulHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        session,
        theme: "dark",
        includeMetadata: true,
        includeTimestamps: false,
      })
    )
  })

  it("renders animated HTML with .animated.html suffix", () => {
    const out = renderSingleExport({
      format: "animated",
      session,
      messages,
      labels,
      exportedAt: date,
    })
    expect(out.content).toBe("<html>ANIMATED</html>")
    expect(out.filename.endsWith(".animated.html")).toBe(true)
    expect(out.mimeType).toBe("text/html")
    expect(ah.exportToAnimatedHtml).toHaveBeenCalled()
  })

  it("falls back to 'conversation' slug when title produces empty slug", () => {
    const out = renderSingleExport({
      format: "markdown",
      session: { id: "x", title: "..." } as unknown as ChatSession,
      messages,
      labels,
      exportedAt: date,
    })
    expect(out.filename).toBe("conversation.md")
  })

  it("uses Date.now()-based exportedAt when omitted", () => {
    const out = renderSingleExport({
      format: "markdown",
      session,
      messages,
      labels,
    })
    expect(out.content).toBe("MD")
  })

  it("renders per-message JSONL", () => {
    const msgs: StoredMessage[] = [
      {
        id: "1",
        sessionId: "s",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        createdAt: 1,
      },
    ]
    const out = renderSingleExport({
      format: "jsonl",
      session,
      messages: msgs,
      labels,
      exportedAt: date,
    })
    expect(out.filename.endsWith(".jsonl")).toBe(true)
    expect(out.mimeType).toBe("application/x-ndjson")
    expect(JSON.parse(out.content).role).toBe("user")
  })

  it("renders per-conversation JSONL with .chat.jsonl suffix", () => {
    const msgs: StoredMessage[] = [
      {
        id: "1",
        sessionId: "s",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        createdAt: 1,
      },
    ]
    const out = renderSingleExport({
      format: "jsonl-chat",
      session,
      messages: msgs,
      labels,
      exportedAt: date,
      includeAllBranches: true,
    })
    expect(out.filename.endsWith(".chat.jsonl")).toBe(true)
    expect(out.mimeType).toBe("application/x-ndjson")
    expect(JSON.parse(out.content).messages[0]).toEqual({ role: "user", content: "hi" })
  })

  it("bounds a long title in bytes", () => {
    const out = renderSingleExport({
      format: "json",
      session: { id: "x", title: "X".repeat(400) } as unknown as ChatSession,
      messages,
      labels,
    })
    expect(out.filename).toBe(`${"X".repeat(180)}.json`)
  })

  it("names a conversation titled in Chinese after its title, not 'conversation' (N2)", () => {
    const named = (title: string) =>
      renderSingleExport({
        format: "markdown",
        session: { id: "x", title } as unknown as ChatSession,
        messages,
        labels,
        exportedAt: date,
      }).filename
    expect(named("项目 计划")).toBe("项目-计划.md")
    expect(named("周会纪要")).toBe("周会纪要.md")
  })
})
