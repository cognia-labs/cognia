/** QQ projection and per-delivery callback receipts, separate from the pure serializer. */
import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import { buildConversationKey } from "@/types/connectors/event"
import {
  bindingHintFields,
  generateMarkdownMirror,
  generatePlainTextMirror,
  resolveButtonWireAction,
  resolveCallbackBinding,
  walkA2UISurface,
} from "../_shared/a2ui-mapper"
import { namespacedCallbackAction } from "@/lib/ai/agent/execution/hitl/callback-prefixes"
import { getDb } from "@/lib/db/schema"
import { escapeMarkdown } from "../_shared/inbound-markdown"
import { QQKeyboardValidationError, validateQQKeyboard, type QQKeyboardButton } from "./keyboard"
import { evaluateFetchTarget } from "@cognia/network-guard"
import { hasNoLeakingPii } from "@cognia/redact"

export function qqResourceUrl(value: string, kind: "image" | "link"): string | undefined {
  if (kind === "image" && /^qqbot-media:\/\/image\/v1\/[A-Za-z0-9_=+-]+$/.test(value)) return value
  try {
    const url = new URL(value)
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      /[\u0000-\u0020\u007f]/.test(value) ||
      !evaluateFetchTarget(url.href).allowed
    )
      return undefined
    return url.href
  } catch {
    return undefined
  }
}

export interface QQKeyboardReceipt {
  bindingActionId: string
  action: string
  buttonId: string
  scene: "group" | "c2c"
  sceneId: string
  messageId: string
  actionPayload?: { href?: string; title?: string; description?: string }
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
  const hasMedia = req.segments.some((segment) =>
    ["image", "video", "voice", "file"].includes(segment.type)
  )
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
      actionPayload?: QQKeyboardReceipt["actionPayload"]
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
      ...(input.actionPayload ? { actionPayload: input.actionPayload } : {}),
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
    const nativeButtonIds = new Set<string>()
    const nodes: Parameters<Parameters<typeof walkA2UISurface>[1]>[0][] = []
    walkA2UISurface(segment.content, (node) => {
      nodes.push(node)
    })
    const actionNodes = nodes.filter(
      (node) =>
        node.raw.disabled !== true &&
        (node.component === "Button" ||
          (node.component === "Link" &&
            typeof node.raw.action === "string" &&
            node.raw.action.length > 0) ||
          (node.component === "Card" &&
            typeof node.raw.clickAction === "string" &&
            node.raw.clickAction.length > 0))
    )
    const resourceOptions = { resourceUrl: qqResourceUrl }
    const labels = actionNodes.map((node) =>
      String(node.raw.text || node.raw.title || node.raw.action || node.raw.clickAction || node.id)
    )
    const numberLabels =
      labels.some((label) => [...label].length > 10) || new Set(labels).size !== labels.length
    const resourcesText = generatePlainTextMirror(segment.content, {
      ...resourceOptions,
      resourcesOnly: true,
    })
    const generatedMirror = generatePlainTextMirror(segment.content)
    const widget = segment.content.widget as { fallbackText?: unknown } | undefined
    const authoredMirror =
      typeof widget?.fallbackText === "string" ? widget.fallbackText.trim() : ""
    const customMirror = Boolean(
      authoredMirror || (segment.plainTextMirror && segment.plainTextMirror !== generatedMirror)
    )
    const fallbackText = customMirror
      ? segment.plainTextMirror || authoredMirror
      : generatePlainTextMirror(segment.content, { ...resourceOptions, dataWidgets: true })
    // Numeric cells were not strings at the original deep gate. Recheck the
    // rendered summary before bindings, quotas, uploads or provider delivery.
    if (!customMirror && !hasNoLeakingPii(fallbackText))
      throw new QQKeyboardValidationError("QQ generated A2UI summary failed the PII gate")
    const textAlternative = [fallbackText, customMirror ? resourcesText : ""]
      .filter((value, index, all) => value && all.indexOf(value) === index)
      .join("\n\n")
    if (actionNodes.length > 25) {
      // Never split exclusive groups across messages or create callback grants
      // for controls that cannot fit a native keyboard.
      const complete = generatePlainTextMirror(segment.content, {
        ...resourceOptions,
        dataWidgets: !customMirror,
      })
      segments.push({
        ...segment,
        plainTextMirror: [
          textAlternative,
          complete,
          ...actionNodes.flatMap((node, index) =>
            node.component !== "Button" && !node.raw.text && !node.raw.title
              ? [`[${labels[index]}]`]
              : []
          ),
        ]
          .filter((value, index, all) => value && all.indexOf(value) === index)
          .join("\n\n"),
      })
      continue
    }
    const labelDetails: string[] = []
    for (const source of actionNodes) {
      const node =
        source.component === "Card"
          ? { ...source, raw: { ...source.raw, action: source.raw.clickAction } }
          : source
      const label = labels[buttons.length]
      const href = node.component === "Button" ? (node.raw.href ?? node.raw.url) : undefined
      const command = node.component === "Button" ? node.raw.qqCommand : undefined
      const { actionId, recordBinding } = resolveButtonWireAction(segment.surfaceId, node)
      const number = `${buttons.length + 1}. `
      const displayedLabel = numberLabels ? number + label : label
      if (numberLabels) labelDetails.push(displayedLabel)
      const button: QQKeyboardButton = {
        id: `b${buttons.length}`,
        render_data: {
          label:
            [...displayedLabel].length > 10
              ? number + [...label].slice(0, 9 - number.length).join("") + "…"
              : displayedLabel,
          style: 1,
        },
        action: {
          type: typeof href === "string" ? 0 : typeof command === "string" ? 2 : 1,
          data: typeof href === "string" ? href : typeof command === "string" ? command : actionId,
          permission: { type: 2 },
        },
      }
      if (node.raw.confirmation !== undefined) {
        const confirmation = node.raw.confirmation as Record<string, unknown>
        if (!confirmation || typeof confirmation !== "object")
          throw new QQKeyboardValidationError("Invalid button confirmation")
        button.action.modal = {
          content: confirmation.message as string,
          ...(confirmation.confirmLabel !== undefined
            ? { confirm_text: confirmation.confirmLabel as string }
            : {}),
          ...(confirmation.cancelLabel !== undefined
            ? { cancel_text: confirmation.cancelLabel as string }
            : {}),
        }
      }
      if (node.raw.exclusiveGroup !== undefined) button.group_id = node.raw.exclusiveGroup as string
      if (button.action.type === 1)
        await bind(button, {
          surfaceId: segment.surfaceId,
          componentId: node.id,
          actionId,
          action: namespacedCallbackAction(actionId) ?? String(node.raw.action ?? node.id),
          recordBinding,
          hints: bindingHintFields(node.raw),
          ...(node.component === "Card"
            ? {
                actionPayload: {
                  title: typeof node.raw.title === "string" ? node.raw.title : "",
                  description: typeof node.raw.description === "string" ? node.raw.description : "",
                },
              }
            : {}),
          ...(node.component === "Link" &&
          typeof node.raw.href === "string" &&
          qqResourceUrl(node.raw.href, "link")
            ? { actionPayload: { href: qqResourceUrl(node.raw.href, "link")! } }
            : {}),
        })
      buttons.push(button)
      nativeButtonIds.add(node.id)
    }
    const fallback = nodes.some(
      (node) =>
        !["Button", "ButtonGroup", "Text", "Row", "Column", "Card", "Image", "Link"].includes(
          node.component
        )
    )
    // Unsupported widgets require their complete fallback, including data
    // absent from the component tree. Fully native surfaces retain their
    // semantic projection; their fallback may intentionally be plainer.
    let markdown = fallback
      ? [
          escapeMarkdown(fallbackText),
          generateMarkdownMirror(segment.content, { ...resourceOptions, resourcesOnly: true }),
        ]
          .filter(Boolean)
          .join("\n\n")
      : generateMarkdownMirror(segment.content, {
          omitButtonIds: nativeButtonIds,
          maxHeadingLevel: 2,
          ...resourceOptions,
        })
    if (labelDetails.length)
      markdown = [markdown, ...labelDetails.map(escapeMarkdown)].filter(Boolean).join("\n\n")
    if (!buttons.length) {
      // QQ cannot combine native Markdown with media. Keep existing text
      // captions coalesced so a format upgrade cannot spend another reply.
      segments.push(
        !fallback && !hasMedia && markdown
          ? { type: "markdown", md: markdown }
          : { ...segment, plainTextMirror: textAlternative }
      )
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
          markdown: {
            content:
              markdown ||
              generateMarkdownMirror(segment.content, { maxHeadingLevel: 2, ...resourceOptions }) ||
              escapeMarkdown(fallbackText || labels.join("\n")),
          },
          fallback,
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
