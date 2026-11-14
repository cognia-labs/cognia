import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { UIMessage } from "ai"
import messages from "@/i18n/messages/en/contextWorkbench.json"
import { summarizeAsideInheritance } from "@/lib/chat/session-aside-context"
import { useAsideInheritance } from "@/hooks/chat/use-aside-inheritance"
import { AsideInheritance } from "./aside-inheritance"

jest.mock("@/hooks/chat/use-aside-inheritance", () => ({ useAsideInheritance: jest.fn() }))
const parent = Array.from({ length: 30 }, (_, i) => ({
  id: `p${i}`,
  role: "user",
  parts: [{ type: "text", text: `Main message ${i}` }],
})) as UIMessage[]
parent[0].parts.push({
  type: "file",
  filename: "photo.png",
  mediaType: "image/png",
  url: "data:image/png;base64,YQ==",
})
parent[1].parts.push({
  type: "file",
  filename: "gone.pdf",
  mediaType: "application/pdf",
  url: "https://unavailable.invalid/file",
})
const setIncluded = jest.fn().mockResolvedValue(undefined)
const attach = jest.fn().mockResolvedValue(undefined)
function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ contextWorkbench: messages }}>
      <AsideInheritance sessionId="aside" parentId="main" />
    </NextIntlClientProvider>
  )
}
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useAsideInheritance).mockReturnValue({
    data: {
      sessionId: "aside",
      parentId: "main",
      messages: parent,
      summary: summarizeAsideInheritance(parent),
      attachments: [
        {
          messageId: "p0",
          partIndex: 0,
          filename: "photo.png",
          mediaType: "image/png",
          unavailable: undefined,
        },
        {
          messageId: "p1",
          partIndex: 0,
          filename: "gone.pdf",
          mediaType: "application/pdf",
          unavailable: "missingBytes",
        },
      ],
      hidden: 1,
    },
    failed: false,
    setIncluded,
    attach,
  })
})

it("renders ICU counts and exposes a keyboard-accessible list and inclusion toggle", async () => {
  const user = userEvent.setup()
  mount()
  expect(
    screen.getByRole("button", { name: "Review inherited main-conversation context" })
  ).toHaveTextContent("24 recent messages · 6 earlier not included · 2 attachments not carried")
  expect(screen.getByRole("button")).toHaveTextContent("1 hidden")
  await user.tab()
  await user.keyboard("{Enter}")
  const toggle = await screen.findByRole("checkbox", {
    name: "Pin main-conversation message 1 for context",
  })
  await user.click(toggle)
  expect(setIncluded).toHaveBeenCalledWith("p0", true)
  expect(screen.getAllByText("Not included")).toHaveLength(6)
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
})

it("only attaches when picked and explains unavailable local bytes", async () => {
  const user = userEvent.setup()
  mount()
  expect(attach).not.toHaveBeenCalled()
  await user.click(screen.getByRole("button"))
  await user.click(screen.getByRole("button", { name: "Attach photo.png" }))
  expect(attach).toHaveBeenCalledWith("p0", 0)
  expect(screen.getByRole("button", { name: "Attach gone.pdf" })).toBeDisabled()
  expect(
    screen.getByText("Unavailable: the original file is not stored locally or has been removed.")
  ).toBeVisible()
})
