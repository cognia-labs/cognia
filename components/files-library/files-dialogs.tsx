"use client"

/**
 * The Files page's dialogs (ADR-0223), mounted once per page whichever layout
 * draws it. Each opens from a target in the Files store (move, rename, save as
 * template, share, delete forever / empty Trash, folder create / rename,
 * folder delete), so a menu item anywhere on the page only sets the target.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
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
import { Label } from "@/components/ui/label"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import {
  LIBRARY_ITEM_MAX_TAGS,
  LIBRARY_TAG_MAX_LENGTH,
  normalizeLibraryTag,
  normalizeLibraryTags,
  type LibraryFolder,
} from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

import { FilesDeleteFolderDialog } from "./files-delete-folder-dialog"
import { FilesFolderDialog } from "./files-folder-dialog"
import { FilesMoveDialog, FilesMoveFolderDialog } from "./files-move-dialog"
import { FilesRenameDialog } from "./files-rename-dialog"
import { FilesSaveTemplateDialog } from "./files-save-template-dialog"
import { FilesShareDialog } from "./files-share-dialog"
import { FilesTrashDialogs } from "./files-trash-dialogs"

export interface FilesDialogsProps {
  entries: readonly FilesEntry[]
  folders: readonly LibraryFolder[]
  actions: FilesActions
  /** Items were deleted forever: the selection they were in is gone. */
  onDeleted: () => void
}

function FilesTagsDialog({
  entries,
  actions,
}: {
  entries: readonly FilesEntry[]
  actions: Pick<FilesActions, "setTags">
}) {
  const t = useTranslations("files")
  const tagTarget = useFilesLibraryStore((s) => s.tagTarget)
  const closeTags = useFilesLibraryStore((s) => s.closeTags)
  const targets = tagTarget ? entries.filter((entry) => tagTarget.includes(entry.key)) : []
  const targetSig = tagTarget ? tagTarget.join("\0") : ""
  const initialTags = normalizeLibraryTags(targets.flatMap((entry) => entry.tags ?? []))
  const allKnownTags = normalizeLibraryTags(entries.flatMap((entry) => entry.tags ?? []))

  const [draft, setDraft] = useState<{ for: string; tags: string[]; input: string } | null>(null)
  const tags = draft?.for === targetSig ? draft.tags : initialTags
  const input = draft?.for === targetSig ? draft.input : ""
  const [busy, setBusy] = useState(false)

  const setTagsState = (nextTags: string[], nextInput = input) => {
    setDraft({ for: targetSig, tags: normalizeLibraryTags(nextTags), input: nextInput })
  }

  const addCurrentInput = () => {
    const pieces = input
      .split(",")
      .map((piece) => normalizeLibraryTag(piece))
      .filter(Boolean)
    if (pieces.length === 0) return
    setTagsState([...tags, ...pieces], "")
  }

  const removeTag = (tagToRemove: string) => {
    setTagsState(
      tags.filter((tag) => tag.toLowerCase() !== tagToRemove.toLowerCase()),
      input
    )
  }

  const submit = async () => {
    if (targets.length === 0) {
      closeTags()
      return
    }
    const pending = input
      .split(",")
      .map((piece) => normalizeLibraryTag(piece))
      .filter(Boolean)
    const finalTags = normalizeLibraryTags([...tags, ...pending])
    setBusy(true)
    try {
      const ok = await actions.setTags(targets, finalTags)
      if (ok) {
        closeTags()
        setDraft(null)
      }
    } finally {
      setBusy(false)
    }
  }

  const suggestions = allKnownTags.filter(
    (candidate) => !tags.some((existing) => existing.toLowerCase() === candidate.toLowerCase())
  )

  return (
    <Dialog open={tagTarget !== null} onOpenChange={(next) => (next ? undefined : closeTags())}>
      <DialogContent data-testid="files-tags-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>{t("tagsDialog.title")}</DialogTitle>
            <DialogDescription>{t("tagsDialog.retentionHint")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            <Label htmlFor="files-tags-input">{t("tagsDialog.label")}</Label>
            <div className="flex gap-2">
              <Input
                id="files-tags-input"
                autoFocus
                value={input}
                maxLength={LIBRARY_TAG_MAX_LENGTH}
                placeholder={t("tagsDialog.placeholder")}
                onChange={(event) => setDraft({ for: targetSig, tags, input: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && input.trim()) {
                    event.preventDefault()
                    addCurrentInput()
                  }
                }}
                disabled={tags.length >= LIBRARY_ITEM_MAX_TAGS}
                data-testid="files-tags-input"
              />
              <Button
                type="button"
                variant="outline"
                onClick={addCurrentInput}
                disabled={!input.trim() || tags.length >= LIBRARY_ITEM_MAX_TAGS}
                data-testid="files-tags-add"
              >
                <PlusIcon className="size-4" aria-hidden />
                {t("tagsDialog.add")}
              </Button>
            </div>
          </div>

          {tags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5" data-testid="files-tags-selected">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                  <span>{tag}</span>
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    aria-label={t("tagsDialog.remove", { tag })}
                    className="rounded-sm p-0.5 hover:bg-muted"
                    data-testid={`files-tags-remove-${tag}`}
                  >
                    <XIcon className="size-3" aria-hidden />
                  </button>
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("tagsDialog.empty")}</p>
          )}

          {suggestions.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                {t("tagsDialog.suggestions")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.slice(0, 12).map((tag) => (
                  <Button
                    key={tag}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => setTagsState([...tags, tag], input)}
                    disabled={tags.length >= LIBRARY_ITEM_MAX_TAGS}
                    data-testid={`files-tags-suggest-${tag}`}
                  >
                    + {tag}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeTags}>
              {t("tagsDialog.cancel")}
            </Button>
            <Button type="submit" disabled={busy} data-testid="files-tags-save">
              {t("tagsDialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function FilesCollectionDialog({ actions }: { actions: Pick<FilesActions, "saveCollection"> }) {
  const t = useTranslations("files")
  const dialog = useFilesLibraryStore((s) => s.collectionDialog)
  const close = useFilesLibraryStore((s) => s.closeCollectionDialog)
  const applyCollection = useFilesLibraryStore((s) => s.applyCollection)
  const search = useFilesLibraryStore((s) => s.search)
  const lens = useFilesLibraryStore((s) => s.lens)
  const filters = useFilesLibraryStore((s) => s.filters)
  const projectScope = useFilesLibraryStore((s) => s.projectScope)

  const dialogKey = dialog ? (dialog.mode === "edit" ? `e:${dialog.collectionId}` : "c") : ""
  const [draft, setDraft] = useState<{ for: string; name: string } | null>(null)
  const name = draft?.for === dialogKey ? draft.name : dialog?.mode === "edit" ? dialog.name : ""
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!dialog || !name.trim()) return
    setBusy(true)
    try {
      const saved = await actions.saveCollection({
        ...(dialog.mode === "edit" ? { id: dialog.collectionId } : {}),
        name: name.trim(),
        query: {
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(lens !== "suggested" ? { lens } : {}),
          ...(filters.formats.length > 0 ? { formats: [...filters.formats] } : {}),
          ...(filters.modified !== "any" ? { modified: filters.modified } : {}),
          ...(filters.size !== "any" ? { size: filters.size } : {}),
          ...(filters.tags && filters.tags.length > 0 ? { tags: [...filters.tags] } : {}),
          projectScope,
        },
      })
      if (saved) {
        if (dialog.mode === "create") applyCollection(saved)
        close()
        setDraft(null)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={dialog !== null} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent data-testid="files-collection-dialog">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "edit"
                ? t("collectionDialog.editTitle")
                : t("collectionDialog.createTitle")}
            </DialogTitle>
            <DialogDescription>{t("collectionDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="files-collection-name">{t("collectionDialog.nameLabel")}</Label>
            <Input
              id="files-collection-name"
              autoFocus
              value={name}
              onChange={(event) => setDraft({ for: dialogKey, name: event.target.value })}
              placeholder={t("collectionDialog.placeholder")}
              maxLength={120}
              data-testid="files-collection-name"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("collectionDialog.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={busy || !name.trim()}
              data-testid="files-collection-submit"
            >
              {dialog?.mode === "edit" ? t("collectionDialog.save") : t("collectionDialog.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function FilesDialogs({ entries, folders, actions, onDeleted }: FilesDialogsProps) {
  return (
    <>
      <FilesMoveDialog entries={entries} folders={folders} actions={actions} />
      <FilesRenameDialog entries={entries} actions={actions} />
      <FilesSaveTemplateDialog entries={entries} />
      <FilesShareDialog entries={entries} folders={folders} />
      <FilesTrashDialogs entries={entries} actions={actions} onDeleted={onDeleted} />
      <FilesFolderDialog />
      <FilesMoveFolderDialog folders={folders} actions={actions} />
      <FilesDeleteFolderDialog folders={folders} />
      <FilesTagsDialog entries={entries} actions={actions} />
      <FilesCollectionDialog actions={actions} />
    </>
  )
}
