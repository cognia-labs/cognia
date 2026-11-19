"use client"

/**
 * Name a folder before it is made — for "Move to folder → New folder…" while
 * a search holds the list.
 *
 * Everywhere else the folder is created under its placeholder name and its
 * header opens for renaming in place (`useChannelListActions`). A search
 * flattens the list into one result section with no folder headers, so that
 * rename had nowhere to open: the rows were filed into "New folder" and the
 * name only surfaced once the query was cleared (sidebar audit item 11). Asking
 * first keeps the one trip the menu promises.
 */

import { useState, type FormEvent } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

export interface NewFolderNameDialogProps {
  /** How many conversations the folder is made for; `0` = closed. */
  count: number
  /** What the field starts with — the placeholder name the folder would get. */
  defaultName: string
  /** Create the folder under `name` and file the conversations. */
  onConfirm: (name: string) => void
  onCancel: () => void
}

export function NewFolderNameDialog({
  count,
  defaultName,
  onConfirm,
  onCancel,
}: NewFolderNameDialogProps) {
  const open = count > 0
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      {open ? (
        <NewFolderNameForm
          count={count}
          defaultName={defaultName}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}
    </Dialog>
  )
}

/** Mounted per opening, so the field always starts from the default name. */
function NewFolderNameForm({ count, defaultName, onConfirm, onCancel }: NewFolderNameDialogProps) {
  const t = useTranslations("desktop.channelList.newFolderDialog")
  const tList = useTranslations("desktop.channelList")
  const [name, setName] = useState(defaultName)
  const trimmed = name.trim()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (trimmed) onConfirm(trimmed)
  }
  return (
    <DialogContent className="sm:max-w-sm" data-testid="new-folder-name-dialog">
      <form onSubmit={submit} className="grid gap-4">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { count })}</DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          aria-label={t("nameLabel")}
          data-testid="new-folder-name-input"
        />
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {tList("cancel")}
          </Button>
          <Button type="submit" disabled={!trimmed} data-testid="new-folder-name-confirm">
            {t("confirm")}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
