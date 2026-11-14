/** @jest-environment jsdom */
import type { UIMessage } from "ai"
import { getMessageMedia } from "@/lib/db/message-media"
import { getSessionAsset, getSessionAssetMetadata } from "@/lib/db/session-assets"
import { parentAttachmentUnavailableReason, restoreParentAttachment } from "./parent"

jest.mock("@/lib/db/session-assets", () => ({
  getSessionAsset: jest.fn(),
  getSessionAssetMetadata: jest.fn(),
}))
jest.mock("@/lib/db/message-media", () => ({
  getMessageMedia: jest.fn(),
  isMediaRef: (value?: string) => value?.startsWith("cognia-media:") === true,
  parseMediaRef: (value: string) => value.slice("cognia-media:".length),
}))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    messageMedia: {
      get: (hash: string) => jest.requireMock("@/lib/db/message-media").getMessageMedia(hash),
    },
  }),
}))
const extraction = {
  attachmentId: "asset",
  contentHash: "a".repeat(64),
  status: "ready",
  processor: { id: "test", version: "1" },
  segments: [{ id: "s", text: "body", locator: { type: "text", start: 0, end: 4 } }],
}
const message = (parts: unknown[]) => ({ id: "parent", role: "user", parts }) as UIMessage
beforeEach(() => jest.resetAllMocks())

it("restores an original document through the existing composer helper and deduplicates derived parts", async () => {
  const parent = message(
    [0, 1].map(() => ({
      type: "file",
      filename: "report.pdf",
      mediaType: "application/pdf",
      extractedContent: extraction,
    }))
  )
  jest.mocked(getSessionAsset).mockResolvedValue({
    blob: new Blob(["%PDF"]),
    filename: "report.pdf",
    mediaType: "application/pdf",
  } as Awaited<ReturnType<typeof getSessionAsset>>)
  jest
    .mocked(getSessionAssetMetadata)
    .mockResolvedValue({ sourceAvailable: true } as Awaited<
      ReturnType<typeof getSessionAssetMetadata>
    >)
  expect(await parentAttachmentUnavailableReason("main", parent, 0)).toBeUndefined()
  const restored = await restoreParentAttachment("main", parent, 0)
  expect(restored.file).toBeInstanceOf(File)
  expect(restored.file?.name).toBe("report.pdf")
  expect(restored.file?.size).toBe(4)
  expect(getSessionAsset).toHaveBeenCalledWith("main", "asset")
})

it("restores inline and canonical cached image bytes as Files", async () => {
  const inline = message([
    { type: "file", filename: "a.png", mediaType: "image/png", url: "data:image/png;base64,YQ==" },
  ])
  expect((await restoreParentAttachment("main", inline, 0)).file?.size).toBe(1)
  const cached = message([
    { type: "file", filename: "b.png", mediaType: "image/png", url: "cognia-media:hash" },
  ])
  jest
    .mocked(getMessageMedia)
    .mockResolvedValue({ blob: new Blob(["bytes"]), mediaType: "image/png" } as Awaited<
      ReturnType<typeof getMessageMedia>
    >)
  expect((await restoreParentAttachment("main", cached, 0)).file?.name).toBe("b.png")
  expect(await parentAttachmentUnavailableReason("main", cached, 0)).toBeUndefined()
})

it("refuses purged bytes, thumbnails and remote URLs without inventing file contents", async () => {
  for (const url of ["cognia-media:gone", "https://paired.invalid/file.pdf"]) {
    const parent = message([
      { type: "file", filename: "lost.pdf", mediaType: "application/pdf", url },
    ])
    expect(await restoreParentAttachment("main", parent, 0)).toEqual({ reason: "missingBytes" })
    expect(await parentAttachmentUnavailableReason("main", parent, 0)).toBe("missingBytes")
  }
  jest
    .mocked(getMessageMedia)
    .mockResolvedValue({ canonicalAvailable: false, blob: new Blob(["thumbnail"]) } as Awaited<
      ReturnType<typeof getMessageMedia>
    >)
  const thumbnail = message([{ type: "file", url: "cognia-media:thumb", mediaType: "image/png" }])
  expect(await restoreParentAttachment("main", thumbnail, 0)).toEqual({ reason: "missingBytes" })
})
