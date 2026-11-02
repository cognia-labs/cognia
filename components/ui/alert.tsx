import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border border-transparent bg-[color-mix(in_oklab,currentColor_6%,var(--surface-bg))] px-4 py-3 text-sm has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-3 [&>svg]:size-4 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        default: "text-card-foreground",
        destructive:
          "text-destructive *:data-[slot=alert-description]:text-destructive/90 [&>svg]:text-current",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * Both variants painted `bg-card`, so both are the `raised` tier (ADR-0148) and
 * the resolved colour is identical. Radius stays `inherit` — the variants' own
 * `rounded-lg` is the base step, not the `panel` step, and swapping it would
 * shift the default look by 2px.
 */
function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <Surface
      layer="raised"
      data-slot="alert"
      role="alert"
      // No drawn edge, whatever the caller tinted it: the alert reads by a
      // wash of its own text colour (an amber warning gets an amber wash),
      // unless the caller paints a background of its own.
      className={cn(alertVariants({ variant }), className, "border-transparent")}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn("col-start-2 line-clamp-1 min-h-4 font-medium tracking-tight", className)}
      {...props}
    />
  )
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-sm text-muted-foreground [&_p]:leading-relaxed",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
