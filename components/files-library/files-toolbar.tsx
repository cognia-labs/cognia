"use client"

/**
 * Filter and layout for the Files page (ADR-0223): the right end of the
 * header's view bar. The search box is the header's own `search` field
 * (`files-library.tsx`), which writes straight to the store; the view defers
 * the filter pass (`useDeferredValue`) so typing never waits on a large list.
 * Sorting moved to the list's column headers.
 */

import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, LayoutGridIcon, ListIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { nextFilesSort } from "@/lib/files-library/column-sort"
import { FILES_SORT_KEYS, type FilesSortKey } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

import { FilesFilterPopover } from "./files-filter-popover"

const DEFAULT_SORT_VALUE = "__default__"

function isSortKey(value: string): value is FilesSortKey {
  return (FILES_SORT_KEYS as readonly string[]).includes(value)
}

/**
 * Cross-layout sort control for Grid, narrow List viewports, and Mobile,
 * sharing the exact `sort` store state as List column headers.
 */
export function FilesSortMenu({ compact = false }: { compact?: boolean } = {}) {
  const t = useTranslations("files")
  const sort = useFilesLibraryStore((s) => s.sort)
  const setSort = useFilesLibraryStore((s) => s.setSort)
  const trash = useFilesLibraryStore((s) => s.section.kind === "trash")

  const labelForKey = (key: FilesSortKey) =>
    key === "activity" && trash ? t("columns.deleted") : t(`columns.${key}`)

  const ariaLabel = sort
    ? t("sort.labelActive", {
        column: labelForKey(sort.key),
        direction: t(`sort.${sort.dir}`),
      })
    : t("sort.label")

  const DirectionIcon = !sort ? ArrowUpDownIcon : sort.dir === "asc" ? ArrowUpIcon : ArrowDownIcon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={compact ? "h-10" : undefined}
          aria-label={ariaLabel}
          data-testid="files-sort-menu"
        >
          <DirectionIcon aria-hidden />
          {sort ? labelForKey(sort.key) : t("sort.button")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48" data-testid="files-sort-menu-content">
        <DropdownMenuRadioGroup
          value={sort?.key ?? DEFAULT_SORT_VALUE}
          onValueChange={(value) => {
            if (value === DEFAULT_SORT_VALUE) {
              setSort(null)
              return
            }
            if (!isSortKey(value)) return
            if (sort?.key === value) {
              setSort(nextFilesSort(sort, value))
              return
            }
            setSort(nextFilesSort(null, value))
          }}
        >
          <DropdownMenuRadioItem value={DEFAULT_SORT_VALUE} data-testid="files-sort-option-default">
            {t("sort.default")}
          </DropdownMenuRadioItem>
          {FILES_SORT_KEYS.map((key) => (
            <DropdownMenuRadioItem key={key} value={key} data-testid={`files-sort-option-${key}`}>
              {labelForKey(key)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {sort ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t("sort.direction")}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={sort.dir}
              onValueChange={(dir) => {
                if (dir === "asc" || dir === "desc") setSort({ key: sort.key, dir })
              }}
            >
              <DropdownMenuRadioItem value="asc" data-testid="files-sort-dir-asc">
                {t("sort.asc")}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="desc" data-testid="files-sort-dir-desc">
                {t("sort.desc")}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function FilesToolbar({
  availableTags = [],
}: {
  availableTags?: readonly string[]
} = {}) {
  const t = useTranslations("files")
  const viewMode = useFilesLibraryStore((s) => s.viewMode)
  const setViewMode = useFilesLibraryStore((s) => s.setViewMode)

  return (
    <div className="flex items-center gap-2" data-testid="files-toolbar">
      <FilesSortMenu />
      <FilesFilterPopover availableTags={availableTags} />

      <ToggleGroup
        type="single"
        size="sm"
        value={viewMode}
        onValueChange={(value) => {
          if (value === "grid" || value === "list") setViewMode(value)
        }}
        aria-label={t("view.toggleAria")}
      >
        <ToggleGroupItem value="grid" aria-label={t("view.grid")} data-testid="files-view-grid">
          <LayoutGridIcon className="size-3.5" />
        </ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label={t("view.list")} data-testid="files-view-list">
          <ListIcon className="size-3.5" />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}
