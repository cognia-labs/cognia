import { fireEvent, render, screen } from "@testing-library/react"
import { CreatedDocumentAction } from "./created-document-action"
import { openChatDocument } from "@/lib/artifacts/open-chat-document"
jest.mock("@/lib/artifacts/open-chat-document", () => ({ openChatDocument: jest.fn() }))
const part = {
  type: "tool-lark.doc.create",
  state: "output-available",
  output: {
    ok: true,
    data: { document: { url: "https://team.feishu.cn/docx/abcdefghijklmnop1234" } },
  },
}
it("offers an explicit action only after success; it never auto-opens", () => {
  const { rerender } = render(
    <CreatedDocumentAction sessionId="owner" part={{ ...part, state: "input-streaming" }} />
  )
  expect(screen.queryByRole("button")).not.toBeInTheDocument()
  rerender(<CreatedDocumentAction sessionId="owner" part={part} />)
  expect(openChatDocument).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "openDock" }))
  expect(openChatDocument).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: "owner", entry: "tool-result", view: "live" })
  )
})

import en from "@/i18n/messages/en/cloudDocPreview.json"
import zh from "@/i18n/messages/zh-CN/cloudDocPreview.json"
it("defines every entry and attach action string in both split locales", () => {
  for (const key of [
    "openDock",
    "preview",
    "previewDocument",
    "modelView",
    "attachToChat",
    "attachUnavailable",
  ] as const) {
    expect(typeof en[key]).toBe("string")
    expect(typeof zh[key]).toBe("string")
  }
})
