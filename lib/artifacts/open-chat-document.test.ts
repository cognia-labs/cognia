import {
  openAttachedDocument,
  openCloudDocumentLink,
  isDocumentPrimaryClick,
} from "./open-chat-document"
import { openDockDocument } from "./dock-documents"
jest.mock("./dock-documents", () => ({ openDockDocument: jest.fn() }))
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ activeSessionId: "visible" }) },
}))
const provenance = {
  v: 1,
  providerId: "google",
  resourceKind: "doc",
  resourceId: "abcdefghijklmnop1234",
  url: "https://docs.google.com/document/d/abcdefghijklmnop1234/edit",
  title: "Plan",
  fetchedAt: 1,
  completeness: { status: "complete" },
}
beforeEach(() => jest.clearAllMocks())
it("opens a background owner's tab without revealing it", () => {
  expect(openCloudDocumentLink(provenance.url, "owner", "link")).toBe(true)
  expect(openDockDocument).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: "owner", reveal: false, view: "live" })
  )
  expect(openCloudDocumentLink(provenance.url, "visible", "source")).toBe(true)
  expect(openDockDocument).toHaveBeenLastCalledWith(expect.objectContaining({ reveal: true }))
})
it("rejects spoofed hosts and missing owners", () => {
  expect(
    openCloudDocumentLink(
      provenance.url.replace("docs.google.com", "docs.google.com.evil.test"),
      "owner",
      "link"
    )
  ).toBe(false)
  expect(openCloudDocumentLink(provenance.url, undefined, "link")).toBe(false)
  expect(openDockDocument).not.toHaveBeenCalled()
})
it("never resurrects part text for a missing or tombstoned asset", () => {
  openAttachedDocument({
    provenance,
    sessionId: "owner",
    text: "removed body",
    assetId: "deleted",
    messageId: "m",
    origin: "sent",
  })
  expect(openDockDocument).toHaveBeenCalledWith(
    expect.objectContaining({ snapshot: { kind: "asset", assetId: "deleted", messageId: "m" } })
  )
  expect(JSON.stringify(jest.mocked(openDockDocument).mock.calls)).not.toContain("removed body")
})
it.each(["sent", "staged"] as const)("uses inline text only when %s has no asset id", (origin) => {
  openAttachedDocument({ provenance, sessionId: "visible", text: "body", origin })
  expect(openDockDocument).toHaveBeenCalledWith(
    expect.objectContaining({
      snapshot: { kind: "inline", content: expect.objectContaining({ text: "body", origin }) },
    })
  )
})
it.each([
  { metaKey: true },
  { ctrlKey: true },
  { altKey: true },
  { shiftKey: true },
  { button: 1 },
])("leaves modified clicks alone: %j", (change) => {
  expect(
    isDocumentPrimaryClick({
      button: 0,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...change,
    })
  ).toBe(false)
})
it("reopens an addressless Lark search hit with its source type, so it can be read again", () => {
  expect(
    openAttachedDocument({
      provenance: {
        ...provenance,
        providerId: "lark",
        resourceId: "Z1FjAbCdEfGh1234567890",
        url: "",
        sourceType: "docx",
      },
      sessionId: "owner",
      text: "body",
      origin: "staged",
    })
  ).toBe(true)
  expect(openDockDocument).toHaveBeenCalledWith(
    expect.objectContaining({
      target: expect.objectContaining({
        providerId: "lark",
        resourceId: "Z1FjAbCdEfGh1234567890",
        url: "",
        sourceType: "docx",
      }),
    })
  )
})
