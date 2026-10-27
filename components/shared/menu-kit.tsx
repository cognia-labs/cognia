"use client"

/**
 * One item list, any menu: the primitives an items component renders into.
 *
 * The same actions show up in several menus — a row's "⋯" dropdown and its
 * right-click menu, the title bar's Menubar and its compact dropdown, a nav
 * item's context menu, the mobile action sheet. Each of those surfaces is a
 * different primitive family (Radix DropdownMenu / ContextMenu / Menubar, or a
 * sheet of buttons), but an item list only needs Item, Label, Separator, a
 * submenu and a trailing shortcut. An items component takes a `MenuKit` and
 * renders through it, so every surface offers the same things in the same
 * order from one list:
 *
 * - `components/chat/session-row-menu-items.tsx` — a conversation row
 * - `components/desktop/go-menu-items.tsx` — the Go menu
 * - `components/shell/nav-item-menu.tsx` — a navigation item
 *
 * The mobile sheet kit lives with the sheet
 * (`components/mobile/shell/session-row-sheet-kit.tsx`).
 */

import type { ComponentType, MouseEvent as ReactMouseEvent, ReactNode } from "react"

import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import {
  MenubarCheckboxItem,
  MenubarItem,
  MenubarLabel,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
} from "@/components/ui/menubar"

export interface MenuKitItemProps {
  children?: ReactNode
  disabled?: boolean
  className?: string
  title?: string
  onSelect?: (event: Event) => void
  onClick?: (event: ReactMouseEvent) => void
  /** The current choice in a list (the conversation's folder, its workspace). */
  "aria-current"?: "true"
  /** `destructive` tints an irreversible action; a surface without the variant ignores it. */
  variant?: "default" | "destructive"
  "data-testid"?: string
}

export interface MenuKit {
  Item: ComponentType<MenuKitItemProps>
  Label: ComponentType<{ children?: ReactNode; className?: string }>
  Separator: ComponentType
  Sub: ComponentType<{ children?: ReactNode }>
  SubTrigger: ComponentType<{
    children?: ReactNode
    disabled?: boolean
    "data-testid"?: string
  }>
  SubContent: ComponentType<{ children?: ReactNode; className?: string }>
  /** A trailing key hint; a surface without keyboard shortcuts renders nothing. */
  Shortcut: ComponentType<{ children?: ReactNode }>
}

/**
 * Classes for a chrome menu's content (title bar, its menus, its carets).
 *
 * The shadcn primitives ship `animate-in` / `animate-out` keyframes plus a
 * soft `shadow-md`, which on Windows WebView2 repaint a large area on every
 * open and every cross-menu hover switch. Killing the animations and dropping
 * the shadow weight removes that per-frame paint cost; tailwind-merge dedupes
 * against the vendor classes, so `components/ui` stays unforked.
 *
 * Do NOT add `will-change:transform` (or any transform / filter) here. Radix
 * positions submenu content with `position: fixed` without portalling it, so
 * a transform on the parent becomes that child's containing block and the
 * parent's `overflow-hidden` clips the second-level submenu out of view.
 */
export const MENU_CONTENT_PERF =
  "data-[state=open]:!animate-none data-[state=closed]:!animate-none shadow-sm"

/**
 * The stateful items a full application menu needs on top of {@link MenuKit}:
 * a checkbox and a radio group. Kept apart because the row-action surfaces
 * (and the mobile sheet kit) never draw either.
 */
export interface MenuChoiceKit {
  CheckboxItem: ComponentType<{
    children?: ReactNode
    checked?: boolean
    disabled?: boolean
    onCheckedChange?: (checked: boolean) => void
    "data-testid"?: string
  }>
  RadioGroup: ComponentType<{ children?: ReactNode; value?: string }>
  RadioItem: ComponentType<{
    children?: ReactNode
    value: string
    onSelect?: (event: Event) => void
    "data-testid"?: string
  }>
}

/** Trailing key hint, drawn the way the Radix menus' own `*Shortcut` parts draw it. */
export function MenuShortcut({ children }: { children?: ReactNode }) {
  return (
    <span className="ml-auto pl-4 text-xs tracking-widest text-muted-foreground" aria-hidden>
      {children}
    </span>
  )
}

export const DROPDOWN_MENU_KIT: MenuKit = {
  Item: DropdownMenuItem as ComponentType<MenuKitItemProps>,
  Label: DropdownMenuLabel,
  Separator: DropdownMenuSeparator,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Shortcut: MenuShortcut,
}

export const CONTEXT_MENU_KIT: MenuKit = {
  Item: ContextMenuItem as ComponentType<MenuKitItemProps>,
  Label: ContextMenuLabel,
  Separator: ContextMenuSeparator,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Shortcut: MenuShortcut,
}

export const MENUBAR_MENU_KIT: MenuKit = {
  Item: MenubarItem as ComponentType<MenuKitItemProps>,
  Label: MenubarLabel,
  Separator: MenubarSeparator,
  Sub: MenubarSub,
  SubTrigger: MenubarSubTrigger,
  SubContent: MenubarSubContent,
  Shortcut: MenuShortcut,
}

export const DROPDOWN_MENU_CHOICE_KIT: MenuChoiceKit = {
  CheckboxItem: DropdownMenuCheckboxItem,
  RadioGroup: DropdownMenuRadioGroup,
  RadioItem: DropdownMenuRadioItem,
}

export const CONTEXT_MENU_CHOICE_KIT: MenuChoiceKit = {
  CheckboxItem: ContextMenuCheckboxItem,
  RadioGroup: ContextMenuRadioGroup,
  RadioItem: ContextMenuRadioItem,
}

export const MENUBAR_MENU_CHOICE_KIT: MenuChoiceKit = {
  CheckboxItem: MenubarCheckboxItem,
  RadioGroup: MenubarRadioGroup,
  RadioItem: MenubarRadioItem,
}
