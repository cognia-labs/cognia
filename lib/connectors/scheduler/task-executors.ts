// The connectors' scheduled task executors (ADR-0250 §14 `taskExecutors`):
// `im-push` posts a hand-authored message into a bound IM conversation. The
// scheduler loads this file through the connectors' manifest when such a task
// comes due and never imports it itself.

import type { ModuleTaskExecutorsModule } from "@/lib/modules/manifest-types"
import { executeImPushTask } from "./im-push-executor"

export const taskExecutors: ModuleTaskExecutorsModule["taskExecutors"] = {
  "im-push": executeImPushTask,
}
