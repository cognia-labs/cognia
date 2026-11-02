import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-transparent bg-[var(--control-bg,var(--control-fill))] px-3 py-2 text-base transition-[color,background-color,border-color,box-shadow] duration-200 ease-ink outline-none hover:bg-(--control-fill-hover) placeholder:text-muted-foreground focus-visible:border-(--control-edge-focus) focus-visible:ring-4 focus-visible:ring-(--control-halo) disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive/60 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
