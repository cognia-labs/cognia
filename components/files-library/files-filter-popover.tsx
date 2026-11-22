"use client"

/**
 * The Files filter (ADR-0223): file format (any of several), when an item was
 * last modified, its size, and whether the view spans every workspace. The
 * trigger shows how many filters are on; "Reset" clears them and the search.
 * The workspace scope is a remembered preference, so it is not counted and
 * not reset.
 */

import { useTranslations } from "next-intl"
import { BookmarkPlusIcon, ListFilterIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { FILES_FORMATS } from "@/lib/files-library/format"
import {
  FILES_MODIFIED_WITHIN,
  FILES_SIZE_BANDS,
  type FilesModifiedWithin,
  type FilesSizeBand,
} from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

function isModified(value: string): value is FilesModifiedWithin {
  return (FILES_MODIFIED_WITHIN as readonly string[]).includes(value)
}

function isSizeBand(value: string): value is FilesSizeBand {
  return (FILES_SIZE_BANDS as readonly string[]).includes(value)
}

function FilterHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium text-muted-foreground">{children}</p>
}

export function FilesFilterPopover({
  compact = false,
  availableTags = [],
}: {
  compact?: boolean
  availableTags?: readonly string[]
} = {}) {
  const t = useTranslations("files")
  const filters = useFilesLibraryStore((s) => s.filters)
  const setFilters = useFilesLibraryStore((s) => s.setFilters)
  const resetFilters = useFilesLibraryStore((s) => s.resetFilters)
  const projectScope = useFilesLibraryStore((s) => s.projectScope)
  const setProjectScope = useFilesLibraryStore((s) => s.setProjectScope)
  const search = useFilesLibraryStore((s) => s.search)
  const lens = useFilesLibraryStore((s) => s.lens)
  const openCollectionDialog = useFilesLibraryStore((s) => s.openCollectionDialog)
  const selectedTags = filters.tags ?? []
  const tagOptions = Array.from(
    new Map(
      [...availableTags, ...selectedTags].map((tag) => [tag.toLowerCase(), tag] as const)
    ).values()
  )
  const active =
    (filters.formats.length > 0 ? 1 : 0) +
    (filters.modified !== "any" ? 1 : 0) +
    (filters.size !== "any" ? 1 : 0) +
    (selectedTags.length > 0 ? 1 : 0)
  const canSaveCollection = active > 0 || search.trim().length > 0 || lens !== "suggested"

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          // The phone layout: a 40px target beside the 40px search field.
          className={compact ? "h-10" : undefined}
          aria-label={active > 0 ? t("filter.labelActive", { count: active }) : t("filter.label")}
          data-testid="files-filter"
        >
          <ListFilterIcon aria-hidden />
          {t("filter.button")}
          {active > 0 ? (
            <Badge variant="secondary" className="h-4 px-1 text-[10px]" aria-hidden>
              {active}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0" data-testid="files-filter-popover">
        <div className="flex flex-col gap-3 p-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2">
              <FilterHeading>{t("filter.format")}</FilterHeading>
            </legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {FILES_FORMATS.map((format) => {
                const id = `files-filter-format-${format}`
                const checked = filters.formats.includes(format)
                return (
                  <div key={format} className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={checked}
                      onCheckedChange={(next) =>
                        setFilters({
                          formats: next
                            ? [...filters.formats, format]
                            : filters.formats.filter((value) => value !== format),
                        })
                      }
                      data-testid={id}
                    />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {t(`formats.${format}`)}
                    </Label>
                  </div>
                )
              })}
            </div>
          </fieldset>
          <Separator />
          <div className="flex flex-col gap-2">
            <FilterHeading>{t("filter.modified")}</FilterHeading>
            <RadioGroup
              value={filters.modified}
              onValueChange={(value) => {
                if (isModified(value)) setFilters({ modified: value })
              }}
              aria-label={t("filter.modified")}
              className="grid grid-cols-2 gap-2"
            >
              {FILES_MODIFIED_WITHIN.map((value) => {
                const id = `files-filter-modified-${value}`
                return (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem id={id} value={value} data-testid={id} />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {t(`filter.modifiedWithin.${value}`)}
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>
          <Separator />
          <div className="flex flex-col gap-2">
            <FilterHeading>{t("filter.size")}</FilterHeading>
            <RadioGroup
              value={filters.size}
              onValueChange={(value) => {
                if (isSizeBand(value)) setFilters({ size: value })
              }}
              aria-label={t("filter.size")}
              className="grid grid-cols-2 gap-2"
            >
              {FILES_SIZE_BANDS.map((value) => {
                const id = `files-filter-size-${value}`
                return (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem id={id} value={value} data-testid={id} />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {t(`filter.sizes.${value}`)}
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>
          <Separator />
          <div className="flex flex-col gap-2">
            <FilterHeading>{t("scope.label")}</FilterHeading>
            <RadioGroup
              value={projectScope}
              onValueChange={(value) => {
                if (value === "current" || value === "all") setProjectScope(value)
              }}
              aria-label={t("scope.label")}
              className="flex flex-col gap-2"
            >
              {(["current", "all"] as const).map((value) => {
                const id = `files-filter-scope-${value}`
                return (
                  <div key={value} className="flex items-center gap-2">
                    <RadioGroupItem id={id} value={value} data-testid={id} />
                    <Label htmlFor={id} className="text-sm font-normal">
                      {t(`scope.${value}`)}
                    </Label>
                  </div>
                )
              })}
            </RadioGroup>
          </div>
          {tagOptions.length > 0 ? (
            <>
              <Separator />
              <fieldset className="flex flex-col gap-2" data-testid="files-filter-tags">
                <legend className="mb-1">
                  <FilterHeading>{t("filter.tags")}</FilterHeading>
                </legend>
                <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                  {tagOptions.map((tag) => {
                    const checked = selectedTags.some(
                      (existing) => existing.toLowerCase() === tag.toLowerCase()
                    )
                    return (
                      <Button
                        key={tag}
                        type="button"
                        variant={checked ? "secondary" : "outline"}
                        size="sm"
                        className="h-6 px-2 text-xs"
                        aria-pressed={checked}
                        onClick={() =>
                          setFilters({
                            tags: checked
                              ? selectedTags.filter(
                                  (existing) => existing.toLowerCase() !== tag.toLowerCase()
                                )
                              : [...selectedTags, tag],
                          })
                        }
                        data-testid={`files-filter-tag-${tag}`}
                      >
                        {tag}
                      </Button>
                    )
                  })}
                </div>
              </fieldset>
            </>
          ) : null}
        </div>
        <div className="flex items-center justify-between gap-2 border-t p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openCollectionDialog({ mode: "create" })}
            disabled={!canSaveCollection}
            data-testid="files-filter-save-collection"
          >
            <BookmarkPlusIcon className="size-3.5" aria-hidden />
            {t("filter.saveCollection")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={resetFilters}
            disabled={active === 0}
            data-testid="files-filter-reset"
          >
            {t("filter.reset")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
