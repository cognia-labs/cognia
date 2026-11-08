/**
 * What the connectors contribute to the prompt catalog (ADR-0250 §14 prompt
 * contributions): the per-channel capability wording the send path tells an
 * IM-bound run (`./a2ui-bridge/capability-evaluator.ts`, beside the code that
 * resolves it).
 */

import type { ModulePromptsModule } from "@/lib/modules/manifest-types"
import { CONNECTOR_CAPABILITY_PROMPTS } from "./a2ui-bridge/capability-evaluator"

export const prompts: ModulePromptsModule["prompts"] = Object.values(CONNECTOR_CAPABILITY_PROMPTS)
