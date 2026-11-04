import type { AgentRuntimePolicy } from "@cognia/agent-contracts/runtime-policy"
import { validateCodexWritableRoots } from "./app-server-client"
export const codexRuntimePolicy: AgentRuntimePolicy = {
  scopeLabel: "Codex",
  serializeConnections: true,
  ownsConnectionTimeout: true,
  ownsExecutionRetries: true,
  processWriteScope: true,
  requestedWritableRoots: (config, mode, report) =>
    mode === "acceptEdits" && config.codexOptions?.sandboxMode !== "readOnly"
      ? validateCodexWritableRoots(config.codexOptions?.writableRoots, report)
      : [],
  connectionConfig: (config, scope) => ({
    ...config,
    defaultPermissionMode: scope?.permissionMode ?? config.defaultPermissionMode,
    metadata: { ...config.metadata, cogniaCodexWritableCeiling: scope?.ceiling },
    codexOptions: { ...config.codexOptions, writableRoots: scope?.roots ?? [] },
  }),
  sessionMetadata: (config, options, scope) => ({
    codexOptions: { ...config.codexOptions, writableRoots: scope?.roots ?? [] },
    selectedModel:
      options?.model ??
      (config.protocol === "codex-siwc-app-server" &&
      typeof config.metadata?.selectedModel === "string"
        ? config.metadata.selectedModel
        : undefined),
  }),
}
