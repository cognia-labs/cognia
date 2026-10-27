import {
  buildA2UICapabilityMatrix,
  type A2UICapabilityMatrix,
  type Capability,
} from "@/types/connectors/capability"

/**
 * Capability flags for the QQ Official Bot adapter.
 *
 * QQ's open messaging API delivers plain text (`msg_type: 0`) for group / C2C /
 * channel / direct messages, with passive replies (`msg_id`) free inside the
 * reply window. Native custom Markdown (`msg_type: 2`) is supported for
 * group/C2C without approved templates. Channel/direct Markdown remains a
 * reported text fallback. Group/C2C keyboards project A2UI buttons natively.
 * Outbound media (rich media upload)
 * supports group/C2C images, video, SILK voice and files through URL uploads
 * or native binary/chunked uploads. Guild channel/direct supports URL images;
 * files and native byte uploads remain unsupported in those guild scenes.
 *
 * Scene-limited mutations (the flag is declared platform-wide; the adapter
 * throws `unsupported` outside the scene):
 *   - `delete`        — all four scenes (group / c2c / channel / direct recall).
 *   - `typing`        — C2C ONLY (`msg_type: 6 input_notify` passive reply);
 *                       silently no-ops elsewhere.
 *   - `send.reaction` — guild `channel` scene ONLY
 *                       (`PUT/DELETE /channels/{c}/messages/{m}/reactions/{type}/{id}`).
 * Absent on purpose: `edit` and `history.fetch` — the QQ bot API has neither
 * a message-edit nor a history-read endpoint.
 */
export const QQ_OFFICIAL_CAPS: readonly Capability[] = [
  "send.reply",
  "send.text",
  "send.markdown",
  "send.a2ui",
  "send.image",
  "send.video",
  "send.voice",
  "send.file",
  "delete",
  "typing",
  "send.reaction",
] as const

/**
 * Group/C2C button keyboards are native; unsupported input widgets retain
 * their plain-text mirror, and guild scenes retain the reported fallback.
 */
export const QQ_OFFICIAL_A2UI_CAPABILITY: A2UICapabilityMatrix = buildA2UICapabilityMatrix({
  Button: "native",
  Text: "native",
  Row: "native",
  Column: "native",
  Card: "native",
})
