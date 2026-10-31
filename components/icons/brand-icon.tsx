import Image from "next/image"
import { brandIconAsset } from "@cognia/brand-assets"

export { brandIconAsset, hasBrandIcon } from "@cognia/brand-assets"

import { cn } from "@/lib/utils"

export interface BrandIconProps {
  id: string
  className?: string
  decorative?: boolean
  fallback?: string
  label?: string
  size?: number
}

function fallbackLetter(value: string): string {
  return value.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase() ?? "?"
}

export function BrandIcon({
  id,
  className,
  decorative = true,
  fallback,
  label,
  size = 24,
}: BrandIconProps) {
  const asset = brandIconAsset(id)
  const accessibleLabel = label ?? id
  const style = { height: size, width: size }

  if (!asset) {
    return (
      <span
        role={decorative ? undefined : "img"}
        aria-hidden={decorative || undefined}
        aria-label={decorative ? undefined : accessibleLabel}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-[0.28em] bg-muted text-[0.52em] font-semibold uppercase leading-none text-muted-foreground ring-1 ring-border/70",
          className
        )}
        style={style}
      >
        {fallbackLetter(fallback ?? accessibleLabel)}
      </span>
    )
  }

  return (
    // A white tile keeps monochrome brand marks legible in both themes while
    // preserving the vendor-provided colors for multicolor marks.
    <Image
      src={asset.src}
      alt={decorative ? "" : accessibleLabel}
      aria-hidden={decorative || undefined}
      height={size}
      width={size}
      className={cn(
        "inline-block shrink-0 rounded-[0.28em] bg-white object-contain p-[0.12em] ring-1 ring-black/10",
        className
      )}
      style={style}
    />
  )
}
