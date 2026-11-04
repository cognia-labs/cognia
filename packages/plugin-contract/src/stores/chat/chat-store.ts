/**
 * The plugin contract's share of `stores/chat/chat-store.ts`, which re-exports these.
 */
import type { SendOptions } from "@cognia/plugin-contract/types/agent-config/index"

export type ChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

export type PermissionMode = NonNullable<SendOptions["permissionMode"]>
