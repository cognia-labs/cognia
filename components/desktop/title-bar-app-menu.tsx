"use client"

/**
 * The Windows / Linux in-window application menu.
 *
 * One table (`lib/desktop/app-menu.ts`), two shapes: a Menubar of top-level
 * triggers on a wide window, and a single hamburger dropdown with one labelled
 * section per menu when the bar is narrow or the conversation rail's header
 * occupies the leading stretch of the bar. Both render the same nodes through
 * the menu kits (`components/shared/menu-kit.tsx`), so the two can no longer
 * offer different items, separators or key hints. macOS never mounts this —
 * the native menu (`src-tauri/src/menu.rs`) owns it there.
 */

import { Fragment, useCallback, useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { MenuIcon } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Menubar, MenubarContent, MenubarMenu, MenubarTrigger } from "@/components/ui/menubar"
import { GoMenuItems } from "@/components/desktop/go-menu-items"
import {
  DROPDOWN_MENU_CHOICE_KIT,
  DROPDOWN_MENU_KIT,
  MENU_CONTENT_PERF,
  MENUBAR_MENU_CHOICE_KIT,
  MENUBAR_MENU_KIT,
  type MenuChoiceKit,
  type MenuKit,
} from "@/components/shared/menu-kit"
import type { AppMenuController } from "@/hooks/desktop/use-app-menu-controller"
import { useAppShortcutLabels } from "@/hooks/shortcuts/use-app-shortcut-label"
import {
  APP_MENU_SHORTCUT_IDS,
  APP_MENUS,
  type AppMenuNode,
  type AppMenuShortcut,
  type AppMenuSpec,
} from "@/lib/desktop/app-menu"
import { cn } from "@/lib/utils"

type Surface = "menubar" | "dropdown"

/**
 * Resolves an {@link AppMenuShortcut} to the text a menu row prints: the
 * effective (possibly rebound) chord for an app shortcut, the fixed label
 * otherwise. Shared with the keyboard-shortcuts dialog so the reference and
 * the menus print the same thing.
 */
export function useAppMenuShortcutText(): (shortcut: AppMenuShortcut | undefined) => string {
  const tMenu = useTranslations("desktop.menu")
  const labels = useAppShortcutLabels(APP_MENU_SHORTCUT_IDS)
  const byId = useMemo(
    () => new Map(APP_MENU_SHORTCUT_IDS.map((id, index) => [id, labels[index]?.label ?? ""])),
    [labels]
  )
  return useCallback(
    (shortcut) => {
      if (!shortcut) return ""
      if ("app" in shortcut) return byId.get(shortcut.app) ?? ""
      return tMenu(`shortcut.${shortcut.label}`)
    },
    [byId, tMenu]
  )
}

function AppMenuNodes({
  menu,
  kit,
  choiceKit,
  surface,
  controller,
}: {
  menu: AppMenuSpec
  kit: MenuKit
  choiceKit: MenuChoiceKit
  surface: Surface
  controller: AppMenuController
}) {
  const tMenu = useTranslations("desktop.menu")
  const shortcutText = useAppMenuShortcutText()
  const { Item, Separator, Sub, SubTrigger, SubContent, Shortcut } = kit
  const { CheckboxItem, RadioGroup, RadioItem } = choiceKit

  const hint = (text: string): ReactNode => (text ? <Shortcut>{text}</Shortcut> : null)

  const renderNode = (node: AppMenuNode, index: number): ReactNode => {
    switch (node.kind) {
      case "separator":
        return <Separator key={`sep-${index}`} />
      case "goDestinations":
        return (
          <GoMenuItems
            key="go"
            kit={kit}
            surface={surface}
            handlerFor={(id) => () => controller.go(id)}
          />
        )
      case "recentSessions":
        return (
          <Sub key="recent">
            <SubTrigger>{tMenu(node.labelKey)}</SubTrigger>
            <SubContent className={MENU_CONTENT_PERF}>
              {controller.recentSessions.length === 0 ? (
                <Item disabled>{tMenu("file.recentSessionsEmpty")}</Item>
              ) : (
                controller.recentSessions.map((s) => (
                  <Item key={s.id} onSelect={() => controller.openRecentSession(s.id)}>
                    {s.title || tMenu("file.recentSessionsEmpty")}
                  </Item>
                ))
              )}
            </SubContent>
          </Sub>
        )
      case "choice": {
        const { value, select } = controller.choice(node.setting)
        return (
          <Sub key={node.setting}>
            <SubTrigger>{tMenu(node.labelKey)}</SubTrigger>
            <SubContent className={MENU_CONTENT_PERF}>
              <RadioGroup value={value}>
                {node.options.map((option) => (
                  <RadioItem
                    key={option.value}
                    value={option.value}
                    onSelect={() => select(option.value)}
                  >
                    {tMenu(option.labelKey)}
                  </RadioItem>
                ))}
              </RadioGroup>
            </SubContent>
          </Sub>
        )
      }
      case "toggle": {
        const state = controller.state(node.command)
        return (
          <CheckboxItem
            key={node.command}
            checked={state.checked ?? false}
            disabled={state.disabled}
            onCheckedChange={() => controller.run(node.command)}
            data-testid={`app-menu-${surface}-${node.command}`}
          >
            {tMenu(state.labelKey ?? node.labelKey)}
            {hint(state.noteKey ? tMenu(state.noteKey) : shortcutText(node.shortcut))}
          </CheckboxItem>
        )
      }
      case "action": {
        const state = controller.state(node.command)
        return (
          <Item
            key={node.command}
            disabled={state.disabled}
            variant={node.destructive ? "destructive" : undefined}
            onSelect={() => controller.run(node.command)}
            data-testid={`app-menu-${surface}-${node.command}`}
          >
            {tMenu(state.labelKey ?? node.labelKey)}
            {hint(state.noteKey ? tMenu(state.noteKey) : shortcutText(node.shortcut))}
          </Item>
        )
      }
    }
  }

  return <>{menu.items.map(renderNode)}</>
}

export function TitleBarAppMenu({
  controller,
  folded,
  menus = APP_MENUS,
}: {
  controller: AppMenuController
  /** One hamburger dropdown instead of a Menubar. */
  folded: boolean
  menus?: readonly AppMenuSpec[]
}) {
  const t = useTranslations("desktop.titleBar")
  const tMenu = useTranslations("desktop.menu")

  if (folded) {
    const { Label } = DROPDOWN_MENU_KIT
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("openMenus")}
          data-testid="title-bar-hamburger"
          className="flex h-7 w-7 items-center justify-center rounded-sm hover:bg-accent"
        >
          <MenuIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} className={cn("w-64", MENU_CONTENT_PERF)}>
          {menus.map((menu, index) => (
            <Fragment key={menu.id}>
              {index > 0 ? <DropdownMenuSeparator /> : null}
              <Label>{tMenu(menu.labelKey)}</Label>
              <AppMenuNodes
                menu={menu}
                kit={DROPDOWN_MENU_KIT}
                choiceKit={DROPDOWN_MENU_CHOICE_KIT}
                surface="dropdown"
                controller={controller}
              />
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <Menubar className="h-7 gap-0 rounded-none border-0 bg-transparent p-0 shadow-none">
      {menus.map((menu) => (
        <MenubarMenu key={menu.id}>
          <MenubarTrigger className="px-2 py-0.5 text-xs">{tMenu(menu.labelKey)}</MenubarTrigger>
          <MenubarContent className={MENU_CONTENT_PERF}>
            <AppMenuNodes
              menu={menu}
              kit={MENUBAR_MENU_KIT}
              choiceKit={MENUBAR_MENU_CHOICE_KIT}
              surface="menubar"
              controller={controller}
            />
          </MenubarContent>
        </MenubarMenu>
      ))}
    </Menubar>
  )
}
