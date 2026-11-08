// The `interactive-page` capability port (ADR-0250 §14): turn an execution, a
// workflow run or a conversation, into an interactive A2UI page the person
// can save, edit and share. The a2ui module provides it
// (`lib/a2ui/ports/interactive-page.ts`). Workflow's run detail opens a page
// through it rather than importing a2ui, which builds those pages from
// workflow's run helpers; with no provider the run detail offers no page.

import type { ComponentType, ReactNode } from "react"
import type { ExecutionPageSource } from "@/types/a2ui/execution-page"

/** A source given directly, or a (possibly async) resolver run when the dialog opens. */
export type InteractivePageSourceInput =
  ExecutionPageSource | (() => ExecutionPageSource | Promise<ExecutionPageSource>)

export interface InteractivePageDialogProps {
  source: InteractivePageSourceInput
  /** The control that opens the dialog. */
  trigger: ReactNode
}

export interface InteractivePagePort {
  /** The dialog that builds, previews, saves and shares the page. */
  Dialog: ComponentType<InteractivePageDialogProps>
}

declare module "@/lib/modules/ports" {
  interface PortMap {
    "interactive-page": InteractivePagePort
  }
}
