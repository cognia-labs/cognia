/**
 * @jest-environment jsdom
 *
 * Tests for the chat-message plugin context-menu items: nothing when empty,
 * zone filtering, CustomEvent dispatch with the message click context,
 * disabled handling, drawn inside a host menu.
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { renderHook } from "@testing-library/react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import {
  MessagePluginMenuItems,
  useMessagePluginItems,
  type MessagePluginItemTarget,
} from "./message-plugin-menu"
import {
  __resetContextMenuRegistryForTesting,
  registerContextMenuItem,
} from "@/lib/plugin/context-menu/registry"

const messages = {}

/** A host "…" menu with one item of its own and the plugin items after it. */
function HostMenu(target: MessagePluginItemTarget) {
  const items = useMessagePluginItems(target)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger>More</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Share</DropdownMenuItem>
        <MessagePluginMenuItems items={items} separated />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  __resetContextMenuRegistryForTesting()
})

describe("message plugin items", () => {
  it("has nothing to draw when no plugin contributed chat:message items", () => {
    const { result } = renderHook(() => useMessagePluginItems({ messageId: "m1" }))
    expect(result.current).toEqual([])
    const { container } = wrap(<MessagePluginMenuItems items={[]} separated />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists chat:message items in the host menu and dispatches the click context", async () => {
    const user = userEvent.setup()
    const handler = jest.fn()
    window.addEventListener("plugin-context-menu:p:translate", ((e: CustomEvent) =>
      handler(e.detail)) as EventListener)
    registerContextMenuItem({
      id: "p:translate",
      pluginId: "p",
      item: { id: "p:translate", label: "Translate", when: "chat:message", onClick: () => {} },
    })
    registerContextMenuItem({
      id: "p:canvas-only",
      pluginId: "p",
      item: { id: "p:canvas-only", label: "Canvas only", when: "canvas", onClick: () => {} },
    })
    wrap(<HostMenu messageId="m1" sessionId="s1" selection="hello" />)

    await user.click(screen.getByRole("button", { name: "More" }))
    expect(screen.getByRole("menuitem", { name: "Share" })).toBeInTheDocument()
    expect(screen.getByRole("separator")).toBeInTheDocument()
    expect(screen.queryByText("Canvas only")).not.toBeInTheDocument()
    await user.click(await screen.findByText("Translate"))

    expect(handler).toHaveBeenCalledWith({
      target: "chat:message",
      messageId: "m1",
      sessionId: "s1",
      selection: "hello",
    })
  })

  it("renders disabled items as disabled", async () => {
    const user = userEvent.setup()
    registerContextMenuItem({
      id: "p:off",
      pluginId: "p",
      item: {
        id: "p:off",
        label: "Disabled item",
        when: "chat:message",
        disabled: true,
        onClick: () => {},
      },
    })
    wrap(<HostMenu messageId="m1" />)

    await user.click(screen.getByRole("button", { name: "More" }))

    const item = await screen.findByText("Disabled item")
    expect(item.closest("[role='menuitem']")).toHaveAttribute("aria-disabled", "true")
  })
})
