"use client"

/**
 * What an empty Files view says (ADR-0223). A search or filter that hid
 * everything offers to clear it; the Trash, a lens and each kind of place
 * explain what would appear there. The Workspace files group says what lands
 * in it, or, where this device lists none, that the desktop app does.
 */

import { useTranslations } from "next-intl"
import {
  AlertCircleIcon,
  BotIcon,
  ClockIcon,
  FolderOpenIcon,
  HardDriveIcon,
  SearchXIcon,
  StarIcon,
  Trash2Icon,
  UserIcon,
  Users2Icon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { useFilesOps } from "@/hooks/files-library/files-backend"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import type { FilesLens, FilesSection } from "@/lib/files-library/types"

export type FilesEmptyCopy =
  | "search"
  | "searchFailed"
  | "trash"
  | "favorites"
  | "mine"
  | "ai"
  | "shared"
  | "recent"
  | "folder"
  | "group"
  | "workspace"
  | "workspaceHeldBack"
  | "all"

const ICONS: Record<FilesEmptyCopy, LucideIcon> = {
  search: SearchXIcon,
  searchFailed: AlertCircleIcon,
  trash: Trash2Icon,
  favorites: StarIcon,
  mine: UserIcon,
  ai: BotIcon,
  shared: Users2Icon,
  recent: ClockIcon,
  folder: FolderOpenIcon,
  group: FolderOpenIcon,
  workspace: HardDriveIcon,
  workspaceHeldBack: HardDriveIcon,
  all: FolderOpenIcon,
}

/**
 * Which copy an empty view gets: failed search first, filters next, then the
 * Trash, a Workspace files group this device lists none for, a lens, the place.
 */
export function filesEmptyCopy(
  section: FilesSection,
  lens: FilesLens,
  filtered: boolean,
  workspaceHeldBack = false,
  searchFailed = false
): FilesEmptyCopy {
  if (filtered && searchFailed) return "searchFailed"
  if (filtered) return "search"
  if (section.kind === "trash") return "trash"
  const workspace = section.kind === "group" && section.group === "workspace"
  if (workspace && workspaceHeldBack) return "workspaceHeldBack"
  if (lens !== "suggested") return lens
  return workspace ? "workspace" : section.kind
}

export function FilesEmpty({
  section,
  lens,
  filtered,
  onClear,
  searchError,
  onRetrySearch,
  touch = false,
}: {
  section: FilesSection
  lens: FilesLens
  filtered: boolean
  onClear: () => void
  /** Set when a remote body search failed, so an empty state never claims "No matches". */
  searchError?: string
  onRetrySearch?: () => void
  /** The phone layout: nothing drags there, so an empty folder says how to fill it by tap. */
  touch?: boolean
}) {
  const t = useTranslations("files.empty")
  const heldBack = useFilesOps().capabilities.workspaceFiles !== true
  const copy = filesEmptyCopy(section, lens, filtered, heldBack, Boolean(searchError))
  const Icon = ICONS[copy]
  return (
    <Empty className="border-0 py-16" data-testid={`files-empty-${copy}`}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{t(`${copy}.title`)}</EmptyTitle>
        <EmptyDescription>
          {touch && copy === "folder" ? t("folder.descriptionTouch") : t(`${copy}.description`)}
        </EmptyDescription>
      </EmptyHeader>
      {filtered ? (
        <EmptyContent className="flex flex-wrap justify-center gap-2">
          {searchError && onRetrySearch ? (
            <Button
              variant="default"
              size="sm"
              onClick={onRetrySearch}
              data-testid="files-empty-retry-search"
            >
              {t("retrySearch")}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={onClear} data-testid="files-empty-clear">
            {t("clear")}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}
