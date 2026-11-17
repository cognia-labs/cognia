"use client"

/**
 * Plugin-contributed context-menu items for the `chat:message` zone
 * (`ctx.contextMenu.register`), drawn inside the message's own "…" menu and
 * its long-press sheet (D10) rather than in a menu of their own beside it.
 * Nothing renders when no plugin contributed items.
 *
 * Click dispatch goes through the `plugin-context-menu:<id>` CustomEvent
 * contract — the handlers plugins attached at registration fire unchanged.
 */

import { useMemo } from "react"

import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import {
  firePluginContextMenuItem,
  isContextMenuItemDisabled,
  usePluginContextMenuItems,
} from "@/hooks/plugins/use-plugin-context-menu-items"
import type { ContextMenuClickContext } from "@/types/plugin"

export interface MessagePluginItemTarget {
  messageId: string
  sessionId?: string
  selection?: string
}

export interface MessagePluginItem {
  id: string
  label: string
  disabled: boolean
  run: () => void
}

/** The contributed items for one message, ready to draw on any surface. */
export function useMessagePluginItems({
  messageId,
  sessionId,
  selection,
}: MessagePluginItemTarget): MessagePluginItem[] {
  const entries = usePluginContextMenuItems("chat:message")
  return useMemo(() => {
    const context: ContextMenuClickContext = {
      target: "chat:message",
      messageId,
      sessionId,
      selection,
    }
    return entries.map((entry) => ({
      id: entry.id,
      label: entry.item.label,
      disabled: isContextMenuItemDisabled(entry, context),
      run: () => firePluginContextMenuItem(entry, context),
    }))
  }, [entries, messageId, sessionId, selection])
}

/**
 * The items as `DropdownMenuItem`s, after a separator when `separated` and
 * there is anything above them. For the host's "…" menu.
 */
export function MessagePluginMenuItems({
  items,
  separated = false,
}: {
  items: readonly MessagePluginItem[]
  separated?: boolean
}) {
  if (items.length === 0) return null
  return (
    <>
      {separated ? <DropdownMenuSeparator /> : null}
      {items.map((item) => (
        <DropdownMenuItem
          key={item.id}
          disabled={item.disabled}
          onSelect={item.run}
          data-testid="message-plugin-menu-item"
        >
          {item.label}
        </DropdownMenuItem>
      ))}
    </>
  )
}
