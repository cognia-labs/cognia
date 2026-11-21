/**
 * The plugin contract's share of `lib/prompts/plugin-prompts.ts`, which re-exports these.
 */
import type { PromptGroup, PromptVariableSpec } from "./types"

/** A scope a user may override a plugin prompt at. */
export type PluginPromptScope = "account" | "workspace"

/** What a plugin declares for one prompt. */
export interface PluginPromptDeclaration {
  /** Unique within the plugin. */
  id: string
  /** Shown in the Prompt Center; plugins localize it themselves. */
  title: string
  description?: string
  /** The plugin's own default, exactly as it sends it with no override. */
  defaultBody: string
  /** Bump when the variables, fragments or output contract change. Defaults to 1. */
  contractVersion?: number
  variables?: readonly PromptVariableSpec[]
  requiredFragments?: readonly string[]
  outputContract?: string
  maxChars?: number
  /** Where the entry is grouped; `agents` when omitted. */
  group?: PromptGroup
  /**
   * Where a user may override it, as a subset of what the host offers (the
   * account and a workspace). Declare `["account"]` for a prompt you resolve
   * without a `sessionId`: a workspace override is only applied for a chat's
   * session, so without one it could never take effect. It can only remove
   * scopes; naming one the host does not offer fails the registration.
   */
  scopes?: readonly PluginPromptScope[]
}
