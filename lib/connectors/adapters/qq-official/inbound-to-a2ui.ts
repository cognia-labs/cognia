/**
 * QQ Official Bot gateway dispatch → InboundA2UIBlock projection.
 *
 * Reuses parser-owned attachment normalization so cached media matches the
 * original node exactly once. Channel mentions are stripped only in the
 * channel @ scene. References remain read-only message context.
 */

import type { InboundA2UIBlock } from "../_shared/inbound-a2ui-types"
import { qqMessageProjection, type QQDispatch } from "./parse"

export function qqOfficialInboundToA2UI(dispatch: QQDispatch): InboundA2UIBlock | null {
  if (!dispatch || typeof dispatch !== "object") return null
  const d = dispatch.d
  if (!d) return null

  const projection = qqMessageProjection(dispatch)
  if (projection.nodes.length === 0) return null
  return { v: 1, source: "qq-official", body: projection.nodes, raw: projection.raw }
}
