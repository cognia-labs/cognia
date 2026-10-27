"use client"

/**
 * Help → Keyboard Shortcuts: the reference table of chords the desktop chrome
 * answers. Its rows are derived from the application menu
 * (`shortcutReferenceRows` in `lib/desktop/app-menu.ts`) and print through the
 * same resolver as the menus, so a rebound app shortcut reads the same in the
 * menu and here.
 */

import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useAppMenuShortcutText } from "@/components/desktop/title-bar-app-menu"
import { shortcutReferenceRows } from "@/lib/desktop/app-menu"

const ROWS = shortcutReferenceRows()

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const tMenu = useTranslations("desktop.menu")
  const shortcutText = useAppMenuShortcutText()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="keyboard-shortcuts-dialog">
        <DialogHeader>
          <DialogTitle>{tMenu("help.keyboardShortcutsTitle")}</DialogTitle>
          <DialogDescription>{tMenu("help.keyboardShortcutsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <ul className="divide-y text-sm">
            {ROWS.map((row) => {
              const chord = shortcutText(row.shortcut)
              if (!chord) return null
              return (
                <li key={row.labelKey} className="flex items-center justify-between gap-4 py-1.5">
                  <span className="text-foreground">{tMenu(row.labelKey)}</span>
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                    {chord}
                  </kbd>
                </li>
              )
            })}
          </ul>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{tMenu("help.keyboardShortcutsClose")}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
