/**
 * OAuth scopes the host requests for its Feishu features. The exact set must
 * be enabled and approved for the app in the developer console (Permissions),
 * and the granted scopes must cover what a feature asks for.
 */

/**
 * Scopes requested for the send-as-user flow. `offline_access` is mandatory —
 * Feishu only issues a `refresh_token` when it is granted. Sending as a user
 * requires both `im:message` and `im:message.send_as_user`.
 */
export const LARK_SENDAS_SCOPES = "offline_access im:message im:message.send_as_user"

/** Read-only cloud-document consent, requested explicitly from the connection UI. */
export const LARK_DOC_READ_SCOPES = [
  "search:docs:read",
  "drive:drive:readonly",
  "docs:doc:readonly",
  "docx:document:readonly",
  "sheets:spreadsheet:readonly",
  "bitable:app:readonly",
  "wiki:wiki:readonly",
].join(" ")

/** Whether a grant includes one of the scopes document search accepts. */
export function hasLarkDocumentSearchScope(scopes: readonly string[]): boolean {
  return scopes.some((scope) =>
    ["drive:drive.search:readonly", "drive:drive", "search:docs:read"].includes(scope)
  )
}

/**
 * Scopes the issue tracker's Lark Task sync needs on the USER identity
 * (spec 2026-09-06 D10). Account-selected tracker resources explicitly use
 * this user identity; they do not switch to bot-owned tasklists when the
 * person's grant is absent. Requested when connecting a tracker account.
 */
export const LARK_TASK_SCOPES =
  "task:task:read task:task:write task:tasklist:read task:section:read"

/** Bitable read and write for the tracker's table binding. */
export const LARK_BITABLE_SCOPES = "bitable:app"

/** Merge scope strings, deduplicated, order preserved. */
export function mergeLarkScopes(...groups: Array<string | undefined>): string {
  const seen = new Set<string>()
  for (const group of groups) {
    for (const scope of (group ?? "").split(/\s+/)) {
      if (scope) seen.add(scope)
    }
  }
  return [...seen].join(" ")
}
