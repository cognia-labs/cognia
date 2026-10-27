/** QQ projection and per-delivery callback receipts, separate from the pure serializer. */
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import { buildConversationKey } from "@/types/connectors/event"
import {
  bindingHintFields,
  generatePlainTextMirror,
  resolveButtonWireAction,
  resolveCallbackBinding,
  walkA2UISurface,
} from "../_shared/a2ui-mapper"
import { namespacedCallbackAction } from "@/lib/connectors/hitl/callback-prefixes"
import { getDb } from "@/lib/db/schema"
import { QQKeyboardValidationError, validateQQKeyboard, type QQKeyboardButton } from "./keyboard"

export interface QQKeyboardReceipt {
  bindingActionId: string
  action: string
  buttonId: string
  scene: "group" | "c2c"
  sceneId: string
  messageId: string
}

export interface PreparedQQKeyboards {
  request: OutboundRequest
  bindings: Map<string, ConnectorCallbackBindingRow>
}

export async function prepareQQKeyboards(req: OutboundRequest): Promise<PreparedQQKeyboards> {
  const { scene, sceneId, adapterId } = req.conversationRef
  const bindings = new Map<string, ConnectorCallbackBindingRow>()
  if ((scene !== "group" && scene !== "c2c") || typeof sceneId !== "string")
    return { request: req, bindings }
  const conversationKey = buildConversationKey("qq-official", adapterId, sceneId)
  const segments: MessageSegment[] = []
  const bind = async (
    button: QQKeyboardButton,
    input: {
      surfaceId?: string
      componentId?: string
      actionId: string
      action: string
      recordBinding: boolean
      hints?: ReturnType<typeof bindingHintFields>
    }
  ) => {
    const author = input.recordBinding
      ? undefined
      : await resolveCallbackBinding(adapterId, input.actionId)
    if (!input.recordBinding && (!author || author.conversationKey !== conversationKey))
      throw new QQKeyboardValidationError(
        "QQ callback button requires a live binding in this conversation"
      )
    const token = `qqkb:${crypto.randomUUID()}`
    const now = Date.now()
    const hints = input.hints ?? {}
    const receipt: QQKeyboardReceipt = {
      bindingActionId: author?.actionId ?? token,
      action: input.action,
      buttonId: button.id,
      scene,
      sceneId,
      messageId: "",
    }
    bindings.set(token, {
      id: `${adapterId}:${token}`,
      adapterId,
      actionId: token,
      kind: author ? "block_action" : (hints.kind ?? "callback_query"),
      surfaceId: author?.surfaceId ?? input.surfaceId!,
      componentId: author?.componentId ?? input.componentId,
      conversationKey,
      createdAt: now,
      expiresAt: Math.min(
        author?.expiresAt ?? Infinity,
        hints.expiresAt ?? now + 30 * 24 * 60 * 60_000
      ),
      ...(!author ? hints : {}),
      payload: { ...(!author ? hints.payload : {}), qqKeyboard: receipt },
    })
    button.action.data = token
  }

  for (const segment of req.segments) {
    if (segment.type === "card" && segment.card.kind === "qq-keyboard") {
      const payload = segment.card.payload as Record<string, unknown>
      const keyboard = validateQQKeyboard(payload?.keyboard, scene)
      for (const row of keyboard.content?.rows ?? [])
        for (const button of row.buttons) {
          if (button.action.type === 1)
            await bind(button, {
              actionId: button.action.data,
              action: namespacedCallbackAction(button.action.data) ?? button.action.data,
              recordBinding: false,
            })
        }
      segments.push({
        type: "card",
        card: { kind: "qq-keyboard", payload: { ...payload, keyboard } },
      })
      continue
    }
    if (segment.type !== "a2ui") {
      segments.push(segment)
      continue
    }
    if (
      !segment.content ||
      typeof segment.content.rootId !== "string" ||
      !segment.content.components ||
      typeof segment.content.components !== "object" ||
      Array.isArray(segment.content.components)
    )
      throw new QQKeyboardValidationError("QQ A2UI surface requires a root and components")
    const buttons: QQKeyboardButton[] = []
    const nodes: Parameters<Parameters<typeof walkA2UISurface>[1]>[0][] = []
    walkA2UISurface(segment.content, (node) => {
      nodes.push(node)
    })
    for (const node of nodes) {
      if (node.component !== "Button" || node.raw.disabled === true) continue
      const label = String(node.raw.text ?? node.raw.action ?? node.id)
      const href = node.raw.href ?? node.raw.url
      const command = node.raw.qqCommand
      const { actionId, recordBinding } = resolveButtonWireAction(segment.surfaceId, node)
      const button: QQKeyboardButton = {
        id: `b${buttons.length}`,
        render_data: {
          label: [...label].length > 10 ? [...label].slice(0, 9).join("") + "…" : label,
          style: 1,
        },
        action: {
          type: typeof href === "string" ? 0 : typeof command === "string" ? 2 : 1,
          data: typeof href === "string" ? href : typeof command === "string" ? command : actionId,
          permission: { type: 2 },
        },
      }
      if (button.action.type === 1)
        await bind(button, {
          surfaceId: segment.surfaceId,
          componentId: node.id,
          actionId,
          action: namespacedCallbackAction(actionId) ?? String(node.raw.action ?? node.id),
          recordBinding,
          hints: bindingHintFields(node.raw),
        })
      buttons.push(button)
    }
    if (!buttons.length) {
      segments.push(segment)
      continue
    }
    const rows = Array.from({ length: Math.ceil(buttons.length / 5) }, (_, i) => ({
      buttons: buttons.slice(i * 5, i * 5 + 5),
    }))
    const keyboard = validateQQKeyboard({ content: { rows } }, scene)
    segments.push({
      type: "card",
      card: {
        kind: "qq-keyboard",
        payload: {
          content: generatePlainTextMirror(segment.content) || segment.plainTextMirror,
          fallback: nodes.some(
            (node) =>
              !["Button", "ButtonGroup", "Text", "Row", "Column", "Card"].includes(node.component)
          ),
          keyboard,
        },
      },
    })
  }
  return { request: { ...req, segments }, bindings }
}

/** Commit only buttons in this confirmed part; failed/ambiguous sends grant nothing. */
export async function recordQQKeyboardReceipts(
  bindings: Map<string, ConnectorCallbackBindingRow>,
  keyboard: unknown,
  messageId: string
): Promise<void> {
  const rows =
    (keyboard as { content?: { rows?: { buttons: QQKeyboardButton[] }[] } } | undefined)?.content
      ?.rows ?? []
  const records: ConnectorCallbackBindingRow[] = []
  for (const row of rows)
    for (const button of row.buttons) {
      const binding = bindings.get(button.action.data)
      if (!binding) continue
      records.push({
        ...binding,
        payload: {
          ...binding.payload,
          qqKeyboard: {
            ...(binding.payload!.qqKeyboard as QQKeyboardReceipt),
            messageId,
          },
        },
      })
    }
  if (records.length) await getDb().connectorCallbackBindings.bulkPut(records)
}
