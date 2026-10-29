import type { AgentPlan } from "@/types/agent/plan"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { sessionWorkspaceId } from "@/lib/workspace/session-workspace"
import { loggers } from "@cognia/logging"

/**
 * Optional repair client shared by plan run entry points. Provider resolution
 * stays in the renderer factory; missing configuration or a failed settings
 * read must not prevent the original plan from running without auto-repair.
 */
export async function buildPlanRepairClient(
  plan: Pick<AgentPlan, "sessionId" | "projectId"> | null | undefined,
  featureId: string,
  fallbackWorkspaceId?: string
): Promise<LlmClient | undefined> {
  if (!plan) return undefined
  try {
    const [{ getSession }, { useSettingsStore }, { buildRendererLlmClient }] = await Promise.all([
      import("@/lib/db/sessions"),
      import("@/stores/settings/settings-store"),
      import("@/lib/ai/renderer-llm-client"),
    ])
    const session = await getSession(plan.sessionId).catch(() => null)
    // The headless host does not hydrate the renderer's settings store.
    const appSettings =
      useSettingsStore.getState().settings ??
      (await import("@/lib/db/settings").then(({ getSettings }) => getSettings()))
    return (
      buildRendererLlmClient({
        session,
        appSettings,
        featureId,
        ledgerSurface: "agentsWorkflows",
        ledgerOrigin: "agent",
        workspaceId: sessionWorkspaceId(session) ?? plan.projectId ?? fallbackWorkspaceId ?? null,
      }) ?? undefined
    )
  } catch (err) {
    loggers.agent.warn("Plan repair client unavailable; continuing without auto-repair", {
      err: String(err),
    })
    return undefined
  }
}
