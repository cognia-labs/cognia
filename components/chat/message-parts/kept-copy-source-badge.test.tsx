import { render, screen } from "@testing-library/react"
import { KeptCopySourceBadge } from "./kept-copy-source-badge"
import en from "@/i18n/messages/en/cloudDocPreview.json"
import zh from "@/i18n/messages/zh-CN/cloudDocPreview.json"

it.each(["source-disconnected", "source-deleted", "not-on-this-device"] as const)(
  "renders the localized %s status and has both locales",
  (status) => {
    render(<KeptCopySourceBadge status={status} />)
    expect(screen.getByRole("status")).toHaveTextContent(en.sourceStatus[status])
    expect(zh.sourceStatus[status]).toBeTruthy()
  }
)
it.each([undefined, "unknown", "available"] as const)("omits a badge for %s", (status) => {
  const { container } = render(<KeptCopySourceBadge status={status} />)
  expect(container).toBeEmptyDOMElement()
})
