"use client"

/**
 * The lenses above the Files list (ADR-0223): Suggested, Favorites, Mine,
 * AI-generated and Shared with me. A lens narrows whichever place the sidebar
 * picked; the Trash has no lenses, so it shows none.
 */

import { useTranslations } from "next-intl"

import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { isFilesLens } from "@/lib/files-library/deep-link"
import { FILES_LENSES } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"

export function FilesLensTabs() {
  const t = useTranslations("files")
  const lens = useFilesLibraryStore((s) => s.lens)
  const setLens = useFilesLibraryStore((s) => s.setLens)
  const inTrash = useFilesLibraryStore((s) => s.section.kind === "trash")
  if (inTrash) return null

  return (
    <RadioGroup
      orientation="horizontal"
      aria-label={t("lenses.aria")}
      className="flex h-9 w-fit max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-(--control-fill) p-[3px]"
      value={lens}
      onValueChange={(value) => {
        if (isFilesLens(value)) setLens(value)
      }}
    >
      {FILES_LENSES.map((id) => (
        <RadioGroupItem
          key={id}
          value={id}
          data-testid={`files-lens-${id}`}
          className="inline-flex h-full w-auto flex-1 aspect-auto items-center justify-center rounded-md border-transparent bg-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm dark:data-[state=checked]:bg-foreground/10"
        >
          {t(`lenses.${id}`)}
        </RadioGroupItem>
      ))}
    </RadioGroup>
  )
}
