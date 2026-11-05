/**
 * The closed form of a Lark approval or question card, contributed to
 * `lib/connectors/hitl/approval-card-state.ts` through `./contribution.ts`.
 * Settling edits the original card into this one: its buttons go away and a
 * state header says how the request ended.
 */
import type { ApprovalCardState } from "@/lib/connectors/hitl/approval-card-state"
import type { MessageSegment } from "@/types/connectors/segment"
import { buildLarkCommandFrame } from "./command-cards"
import { LARK_ICON, larkMarkdown, larkNote, type LarkIcon } from "./card-kit"

/** How each closed state reads: title, icon and colour. */
const CLOSED_STATE: Record<
  ApprovalCardState,
  { title: string; icon: LarkIcon; tone: "success" | "warning" | "info" }
> = {
  approved: { title: "已批准", icon: LARK_ICON.success, tone: "success" },
  denied: { title: "已拒绝", icon: LARK_ICON.close, tone: "warning" },
  expired: { title: "已过期", icon: LARK_ICON.waiting, tone: "warning" },
  processed: { title: "已处理", icon: LARK_ICON.success, tone: "success" },
  failed: { title: "处理失败", icon: LARK_ICON.error, tone: "warning" },
  answered: { title: "已回答", icon: LARK_ICON.success, tone: "success" },
  skipped: { title: "已跳过", icon: LARK_ICON.done, tone: "info" },
  cancelled: { title: "已停止", icon: LARK_ICON.stop, tone: "warning" },
}

export function buildLarkClosedApprovalSegment(
  state: ApprovalCardState,
  detail?: string
): MessageSegment {
  const closed = CLOSED_STATE[state]
  const trimmed = detail?.trim()
  return {
    type: "card",
    card: {
      kind: "lark",
      payload: buildLarkCommandFrame(
        closed.title,
        [
          // The detail is markdown its producer wrote (the question in bold,
          // the answer quoted); only a mention in it is disarmed.
          ...(trimmed ? [larkMarkdown(trimmed.slice(0, 500).replace(/<at\b/gi, "<\u200Bat"))] : []),
          larkNote("此请求已结束，操作按钮已移除。"),
        ],
        closed.tone,
        { icon: closed.icon }
      ),
    },
  }
}
