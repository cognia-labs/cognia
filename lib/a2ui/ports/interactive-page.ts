// a2ui's `interactive-page` port (`types/modules/ports/interactive-page.ts`):
// the dialog that turns a workflow run or a conversation into a page.

import type { InteractivePagePort } from "@/types/modules/ports/interactive-page"
import { InteractivePageDialog } from "@/components/a2ui/from-execution/interactive-page-dialog"

export const port: InteractivePagePort = { Dialog: InteractivePageDialog }
