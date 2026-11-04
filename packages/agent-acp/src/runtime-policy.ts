import type { AgentRuntimePolicy } from "@cognia/agent-contracts/runtime-policy"
import { acpClientExtension } from "./client"
import { isolatedAcpExtension } from "./isolated-adapter"
import { gooseSessionExtension } from "./goose-session"
import { createKimiSessionCatalog } from "./session-catalog"
export const acpRuntimePolicy: AgentRuntimePolicy = {
  createSessionCatalog: (config) =>
    config.metadata?.preset === "kimi" ? createKimiSessionCatalog(() => Date.now()) : undefined,
  authoritativeSessions: (adapter) => Boolean(isolatedAcpExtension.resolve(adapter)),
  handleProcessExit: async (adapter, processId) =>
    isolatedAcpExtension.resolve(adapter)?.handleProcessExit(processId),
  prepareCachedSession: async (adapter, session, options) =>
    acpClientExtension.resolve(adapter)?.prepareForkSessionForExecution(session.id, options) ??
    session,
  nativeChildren: (adapter) => gooseSessionExtension.resolve(adapter),
}
