import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * No `py-*` here on purpose. This control is single-line and always carries an
 * explicit height, and a native input centres its value inside the *content*
 * box and clips what will not fit. Vertical padding therefore changes nothing
 * visually and only narrows the room the text has: at `h-7` the old `py-1`
 * left an 18px content box for a 20px line box, so descenders were shaved.
 *
 * The layout that would have read the base padding is `InputGroup`'s
 * block-start / block-end alignment, where the group goes `h-auto` and stacks
 * the addon above or below the control. No call site reaches it with an
 * `input`: every such addon in the repo stacks around a textarea, which brings
 * its own padding. Any call site that wants padding sets `py-*` itself and
 * tailwind-merge lets it win.
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-transparent bg-[var(--control-bg,var(--control-fill))] px-3 py-0 text-base transition-[color,background-color,border-color,box-shadow] duration-200 ease-ink outline-none hover:bg-(--control-fill-hover) selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-(--control-edge-focus) focus-visible:ring-4 focus-visible:ring-(--control-halo)",
        "aria-invalid:border-destructive/60 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
