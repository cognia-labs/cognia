/** Platform-neutral management contracts. These are not arbitrary HTTP requests. */
export interface ConnectorAssetSource {
  /** Explicit bytes or a public URL; never a host path or an upload destination. */
  url?: string
  dataBase64?: string
}

export interface ConnectorAsset {
  adapterId: string
  id: string
  reference: string
  name?: string
  expiresAt?: number
}

/** Provider-issued invitation; generation does not send it to a recipient. */
export interface ConnectorLink {
  purpose: "add-contact"
  url: string
}

export interface ConnectorMenuItem {
  key: string
  label: string
  action?: { type: "prompt" | "slash" | "link"; value: string }
  children?: ConnectorMenuItem[]
  toggle?: { enabled: boolean }
}

export interface ConnectorCommandPanel {
  scope: "private" | "group" | "channel" | "direct"
  audience: "all" | "specific"
  name: string
  remarks?: string
  items: Array<{ name: string; description: string; url?: string; adminOnly?: boolean }>
}

export interface ConnectorManagementInputs {
  "links.create": {
    purpose: ConnectorLink["purpose"]
    /** Opaque referral data, never credentials or delivery authorization. */
    state?: string
  }
  "assets.upload": { name: string; mimeType: string; source: ConnectorAssetSource }
  "assets.list": { cursor?: string }
  "assets.delete": { id: string }
  "menus.get": Record<string, never>
  "menus.set": { items: ConnectorMenuItem[] }
  "commands.list": { scope: ConnectorCommandPanel["scope"]; cursor?: string; limit?: number }
  "commands.get": { id: string }
  "commands.create": { panel: ConnectorCommandPanel }
  "commands.update": { id: string; panel: ConnectorCommandPanel }
  "commands.delete": { id: string }
  "commands.targets": { id: string; action: "add" | "remove"; targetIds: string[] }
  "members.list": { chatId: string; cursor?: string }
  "members.get": { chatId: string; memberId: string }
  "members.remove": { chatId: string; memberIds: string[]; blockRejoin?: boolean }
  "blacklist.list": { chatId: string; cursor?: string; limit?: number }
  "blacklist.update": { chatId: string; action: "add" | "remove"; memberIds: string[] }
  "moderation.get": { chatId: string }
  "moderation.set": {
    chatId: string
    members: Array<{ memberId: string; action: "add" | "update" | "remove"; expiresAt?: number }>
  }
  "joinRequests.list": { chatId: string; cursor?: string; limit?: number }
  "joinRequests.decide": {
    chatId: string
    memberId: string
    requestId: string
    decision: "approve" | "decline"
    reason?: string
    blockRejoin?: boolean
  }
  "joinPolicies.list": { cursor?: string; limit?: number }
  "joinPolicies.create": {
    chatIds: string[]
    enabled: boolean
    expiresAt?: string
    remarks?: string
  }
  "joinPolicies.update": {
    id: string
    enabled?: boolean
    expiresAt?: string
    remarks?: string
    groups?: { action: "add" | "remove"; chatIds: string[] }
  }
  "joinPolicies.delete": { id: string }
  "joinPolicies.allowlist": { id: string; action: "add" | "remove"; accountIds: string[] }
  "joinPolicies.execute": { id: string }
}

export type ConnectorManagementOperation = keyof ConnectorManagementInputs
export type ConnectorManagementRequest = {
  [K in ConnectorManagementOperation]: { operation: K; input: ConnectorManagementInputs[K] }
}[ConnectorManagementOperation]

/** Adapter responses contain reviewed data only, never credentials or signed upload URLs. */
export interface ConnectorManagementResult {
  status: "ok" | "accepted"
  link?: ConnectorLink
  asset?: ConnectorAsset
  assets?: ConnectorAsset[]
  items?: Array<Record<string, unknown>>
  resource?: Record<string, unknown>
  nextCursor?: string
  total?: number
  succeeded?: string[]
  failed?: Array<{ id: string; reason?: string }>
}

export interface ConnectorManagement {
  operations: readonly ConnectorManagementOperation[]
  execute(request: ConnectorManagementRequest): Promise<ConnectorManagementResult>
}
