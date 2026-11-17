import type { UIMessage } from "ai"

import { composeTurnText } from "@/lib/chat/prompt-preamble"
import {
  buildMessageShareContent,
  copyMessageContent,
  messageTypedText,
  shareMessageContent,
  writeMessageToClipboard,
} from "./message-share"

describe("buildMessageShareContent", () => {
  it("materializes files from an immutable transcript without mutating its parts", () => {
    const parts: UIMessage["parts"] = [
      {
        type: "file" as const,
        url: "data:image/png;base64,YQ==",
        mediaType: "image/png",
        filename: "image.png",
      },
    ]
    Object.freeze(parts)
    const content = buildMessageShareContent({ id: "immutable", role: "assistant", parts })
    expect(content.shareFiles).toHaveLength(1)
    expect(content.shareFiles[0].name).toBe("image.png")
    expect(parts).toHaveLength(1)
  })
  it("does not decode screenshots while rendering action availability", () => {
    const decode = jest.spyOn(globalThis, "atob")
    try {
      const content = buildMessageShareContent({
        id: "screenshot-stream",
        role: "assistant",
        parts: [{ type: "file", url: "data:image/png;base64,YQ==", mediaType: "image/png" }],
      })
      expect(content.hasContent).toBe(true)
      expect(decode).not.toHaveBeenCalled()
      expect(content.shareFiles).toHaveLength(1)
      expect(content.shareFiles).toBe(content.shareFiles)
      expect(decode).toHaveBeenCalledTimes(1)
    } finally {
      decode.mockRestore()
    }
  })
  it("preserves ordered text, multiple images, files, and source links", () => {
    const message: UIMessage = {
      id: "mixed",
      role: "assistant",
      parts: [
        { type: "text", text: "See [docs](https://example.com/a_(b))." },
        {
          type: "file",
          url: "data:image/png;base64,YQ==",
          mediaType: "image/png",
          filename: "first.png",
        },
        {
          type: "file",
          url: "https://cdn.example.com/second.jpg",
          mediaType: "image/jpeg",
          filename: "second.jpg",
        },
        {
          type: "file",
          url: "https://files.example.com/report.pdf",
          mediaType: "application/pdf",
          filename: "report.pdf",
        },
        { type: "source-url", url: "https://source.example.com", title: "Source" },
      ] as UIMessage["parts"],
    }

    const content = buildMessageShareContent(message)

    expect(content.plainText).toBe(
      [
        "See [docs](https://example.com/a_(b)).",
        "![first.png](data:image/png;base64,YQ==)",
        "![second.jpg](https://cdn.example.com/second.jpg)",
        "[report.pdf](https://files.example.com/report.pdf)",
        "[Source](https://source.example.com)",
      ].join("\n\n")
    )
    expect(content.nativeShareText).toContain("See [docs](https://example.com/a_(b)).")
    expect(content.nativeShareText).toContain("first.png")
    expect(content.nativeShareText).not.toContain("data:image/png;base64")
    expect(content.nativeShareText).toContain("[Source](https://source.example.com)")
    expect(content.html).toContain('<img src="data:image/png;base64,YQ==" alt="first.png"')
    expect(content.html).toContain('<a href="https://example.com/a_(b)"')
    expect(content.html).toContain(">docs</a>.")
    expect(content.html).toContain('<img src="https://cdn.example.com/second.jpg" alt="second.jpg"')
    expect(content.html).toContain('<a href="https://files.example.com/report.pdf">report.pdf</a>')
    expect(content.shareFiles).toHaveLength(1)
    expect(content.shareFiles[0]).toMatchObject({ name: "first.png", type: "image/png" })
  })

  it("reports content for an image-only message", () => {
    const message: UIMessage = {
      id: "image-only",
      role: "user",
      parts: [
        {
          type: "file",
          url: "data:image/png;base64,YQ==",
          mediaType: "image/png",
          filename: "photo.png",
        },
      ],
    }

    expect(buildMessageShareContent(message).hasContent).toBe(true)
  })

  it("copies and shares the typed text without the composer's context envelope", () => {
    // Copy hands over what the user wrote. The referenced snapshot rides in the
    // persisted text for the model, but pasting it elsewhere would leak a
    // document the user only pointed at, under their name.
    const { text } = composeTurnText(
      "typed words",
      [{ kind: "references", text: "SECRET SNAPSHOT" }],
      { nonce: "abcdef0123" }
    )
    const content = buildMessageShareContent({
      id: "with-envelope",
      role: "user",
      parts: [{ type: "text", text }],
    })

    for (const out of [content.plainText, content.nativeShareText, content.html]) {
      expect(out).toContain("typed words")
      expect(out).not.toContain("SECRET SNAPSHOT")
      expect(out).not.toContain("cognia_context_")
    }
  })

  it("keeps malformed image data copyable without crashing message rendering", () => {
    const message: UIMessage = {
      id: "malformed-image",
      role: "user",
      parts: [
        {
          type: "file",
          url: "data:image/png;base64,%%%",
          mediaType: "image/png",
          filename: "broken.png",
        },
      ],
    }

    expect(() => buildMessageShareContent(message)).not.toThrow()
    expect(buildMessageShareContent(message)).toMatchObject({ hasContent: true, shareFiles: [] })
  })

  it("writes one rich clipboard item containing every image", async () => {
    const write = jest.fn().mockResolvedValue(undefined)
    const writeText = jest.fn().mockResolvedValue(undefined)
    class TestClipboardItem {
      constructor(readonly entries: Record<string, Blob>) {}
    }
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { write, writeText } },
    })
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: TestClipboardItem,
    })
    const content = buildMessageShareContent({
      id: "two-images",
      role: "user",
      parts: [
        { type: "file", url: "data:image/png;base64,YQ==", mediaType: "image/png" },
        { type: "file", url: "data:image/png;base64,Yg==", mediaType: "image/png" },
      ],
    })

    await expect(writeMessageToClipboard(content)).resolves.toBe(true)
    expect(write).toHaveBeenCalledTimes(1)
    const item = write.mock.calls[0][0][0] as TestClipboardItem
    await expect(item.entries["text/html"].text()).resolves.toContain("data:image/png;base64,Yg==")
    expect(writeText).not.toHaveBeenCalled()
  })

  it("falls back to plain text when rich clipboard writing fails", async () => {
    const write = jest.fn().mockRejectedValue(new Error("unsupported"))
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { write, writeText } },
    })
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: class {
        constructor(_entries: Record<string, Blob>) {}
      },
    })
    const content = buildMessageShareContent({
      id: "text",
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    })

    await expect(writeMessageToClipboard(content)).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("hello")
  })
})

const videoDescription = {
  type: "text" as const,
  text: "[video demo.mp4: storyboard of 3 frames]",
  videoAttachment: {
    groupId: "att-1",
    filename: "demo.mp4",
    sourceMediaType: "video/mp4",
    kind: "video",
    durationSec: 42,
    width: 1920,
    height: 1080,
    delivery: "storyboard",
    strategy: "scene",
    range: null,
    frameTimes: [2, 8.5, 20],
    engine: "browser",
  },
}

describe("buildMessageShareContent and block Markdown (D11)", () => {
  it("copies a reply's lists and headings as HTML blocks, and its raw HTML as text", () => {
    const content = buildMessageShareContent({
      id: "md",
      role: "assistant",
      parts: [{ type: "text", text: "## Plan\n\n1. Read\n2. Write\n\n<b>raw</b>" }],
    } as UIMessage)
    expect(content.html).toContain("<h2>Plan</h2>")
    expect(content.html).toContain("<li>Read</li>")
    expect(content.html).toContain("&lt;b&gt;raw&lt;/b&gt;")
    expect(content.plainText).toBe("## Plan\n\n1. Read\n2. Write\n\n<b>raw</b>")
  })

  it("has nothing to copy for a reply made only of cards", () => {
    const content = buildMessageShareContent({
      id: "cards",
      role: "assistant",
      parts: [{ type: "artifact", artifactId: "a", title: "Plan", kind: "document" }],
    } as unknown as UIMessage)
    expect(content.hasContent).toBe(false)
  })
})

describe("messageTypedText", () => {
  it("is the typed text only: no reasoning, envelope or video description", () => {
    const { text } = composeTurnText("typed words", [{ kind: "references", text: "SNAPSHOT" }], {
      nonce: "abcdef0123",
    })
    const message = {
      id: "m",
      role: "user",
      parts: [
        { type: "reasoning", text: "thinking" },
        { type: "text", text },
        videoDescription,
        { type: "text", text: "second" },
      ],
    } as UIMessage
    expect(messageTypedText(message)).toBe("typed words\n\nsecond")
  })
})

describe("buildMessageShareContent and a video description", () => {
  it("leaves the model's reading of a video out of what is copied or shared", () => {
    const message = {
      id: "m",
      role: "user",
      parts: [videoDescription, { type: "text", text: "what happens here?" }],
    } as UIMessage
    expect(buildMessageShareContent(message).plainText).toBe("what happens here?")
    const only = { id: "v", role: "user", parts: [videoDescription] } as UIMessage
    expect(buildMessageShareContent(only).hasContent).toBe(false)
  })
})

/** The page's clipboard for one test; `undefined` takes it away. */
function setClipboard(clipboard: Partial<Clipboard> | undefined) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard } })
}

describe("copyMessageContent", () => {
  const plain = { id: "p", role: "assistant", parts: [{ type: "text", text: "hi" }] } as UIMessage
  const withImage = {
    id: "i",
    role: "assistant",
    parts: [
      { type: "text", text: "look" },
      { type: "file", url: "https://x.test/a.png", mediaType: "image/png", filename: "a.png" },
    ],
  } as UIMessage

  afterEach(() => setClipboard(undefined))

  it("copies plain text through the shell's clipboard when that is all there is", async () => {
    const writePlain = jest.fn(async () => true)
    await expect(
      copyMessageContent(buildMessageShareContent(plain), "hi", writePlain)
    ).resolves.toEqual({
      ok: true,
      rich: false,
    })
    expect(writePlain).toHaveBeenCalledWith("hi")
  })

  it("copies rich content when the message carries more than its text", async () => {
    const write = jest.fn(async () => undefined)
    setClipboard({ write })
    Object.defineProperty(globalThis, "ClipboardItem", {
      configurable: true,
      value: class {
        constructor(_entries: Record<string, Blob>) {}
      },
    })
    const writePlain = jest.fn(async () => true)
    const out = await copyMessageContent(buildMessageShareContent(withImage), "look", writePlain)
    expect(out).toEqual({ ok: true, rich: true })
    expect(write).toHaveBeenCalledTimes(1)
    expect(writePlain).not.toHaveBeenCalled()
  })

  it("falls back to the plain clipboard where the rich write is unavailable", async () => {
    const writePlain = jest.fn(async () => true)
    const content = buildMessageShareContent(withImage)
    const out = await copyMessageContent(content, "look", writePlain)
    expect(out).toEqual({ ok: true, rich: false })
    expect(writePlain).toHaveBeenCalledWith(content.plainText)
  })

  it("copies nothing for a message with no content", async () => {
    const writePlain = jest.fn(async () => true)
    const empty = { id: "e", role: "assistant", parts: [] } as UIMessage
    expect(await copyMessageContent(buildMessageShareContent(empty), "", writePlain)).toEqual({
      ok: false,
      rich: false,
    })
    expect(writePlain).not.toHaveBeenCalled()
  })
})

describe("shareMessageContent", () => {
  const message = {
    id: "s",
    role: "assistant",
    parts: [{ type: "text", text: "hey" }],
  } as UIMessage

  afterEach(() => setClipboard(undefined))

  it("passes the outcome of the share sheet through", async () => {
    for (const kind of ["shared", "cancelled"] as const) {
      const share = jest.fn(async () => ({ kind }))
      await expect(
        shareMessageContent(buildMessageShareContent(message), { share, dialogTitle: "Via" })
      ).resolves.toEqual({ kind })
      expect(share).toHaveBeenCalledWith({ text: "hey", files: [], dialogTitle: "Via" })
    }
    const failing = jest.fn(async () => ({ kind: "error" as const, message: "boom" }))
    await expect(
      shareMessageContent(buildMessageShareContent(message), { share: failing })
    ).resolves.toEqual({ kind: "failed", message: "boom" })
  })

  it("hands the message to the clipboard where there is no share surface", async () => {
    const writeText = jest.fn(async () => undefined)
    setClipboard({ writeText })
    const share = jest.fn(async () => ({ kind: "unsupported" as const }))
    await expect(
      shareMessageContent(buildMessageShareContent(message), { share })
    ).resolves.toEqual({ kind: "copied" })
    expect(writeText).toHaveBeenCalledWith("hey")
  })

  it("fails when neither a share surface nor a clipboard is there", async () => {
    const share = jest.fn(async () => ({ kind: "unsupported" as const }))
    await expect(
      shareMessageContent(buildMessageShareContent(message), { share })
    ).resolves.toEqual({ kind: "failed" })
  })
})
