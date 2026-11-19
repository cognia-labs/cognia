/**
 * Shared toolkit for per-platform A2UI → native rich-content mappers.
 *
 * Each platform owns its own mapper file (Slack `block-kit.ts`, Lark
 * `card.ts`, Telegram `a2ui-mapper.ts`, Discord `a2ui-mapper.ts`, OneBot
 * `a2ui-mapper.ts`) because the destination payloads are wildly different
 * shapes. What every mapper does need, though, is:
 *
 *   1. Walk the A2UI surface tree in render order (rootId → children).
 *   2. Generate a deterministic `actionId` for every interactive component
 *      so inbound callbacks round-trip back to the right surface/component.
 *   3. Persist a `ConnectorCallbackBindingRow` for each generated actionId
 *      so the parser side can recover surface/component context when the
 *      platform delivers the callback.
 *   4. Produce a `plainTextMirror` as fallback when the platform cannot
 *      render some components.
 *
 * Those four concerns live here so the five platform mappers stay focused
 * on platform-specific node shapes only.
 */

import {
  CALLBACK_PREFIXES,
  namespacedCallbackAction,
} from "@/lib/ai/agent/execution/hitl/callback-prefixes"
import { getDb } from "@/lib/db/schema"
import type {
  CallbackActorScope,
  ConnectorCallbackBindingRow,
} from "@/types/connectors/interaction"
import type { A2UIComponentKind } from "@/types/connectors/capability"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { A2UIComponent } from "@/types/a2ui/schema"
import { getComponentChildReferences } from "@cognia/a2ui-core/component-tree"
import { getValueByPath } from "@cognia/a2ui-core/data-model"
import { escapeMarkdown, markdownLinkDestination } from "./inbound-markdown"

/**
 * A component node as the mapper sees it. We accept the unknown-typed
 * `components` map from A2UISegmentContent and re-narrow to the per-node
 * fields we care about — full A2UI typing belongs to `types/a2ui/schema.ts`,
 * the mapper only needs `id`, `component`, plus children references.
 */
export interface A2UIWalkNode {
  id: string
  component: A2UIComponentKind | string
  /** Node payload with display bindings resolved; callback metadata is preserved. */
  raw: Record<string, unknown>
  /** Child ids from all component collection slots and required references. */
  childIds: string[]
}

/**
 * Walk a surface tree in render order starting from `rootId`. The visitor
 * is called for every node exactly once (cycles are short-circuited).
 *
 * Yields nodes via a callback rather than returning an array so platform
 * mappers can emit native payloads incrementally without buffering the
 * entire tree.
 */
export function walkA2UISurface(
  surface: A2UISegmentContent,
  visit: (node: A2UIWalkNode, depth: number) => void
): void {
  const { components, rootId } = surface
  const visited = new Set<string>()

  const recurse = (id: string, depth: number): void => {
    if (visited.has(id)) return
    visited.add(id)
    const raw = components[id]
    if (!raw || typeof raw !== "object") return
    const node = resolveDisplayBindings(raw as Record<string, unknown>, surface.dataModel)
    if (node.visible === false) return
    const childIds = extractChildIds(node)
    visit(
      {
        id,
        component: (typeof node.component === "string" ? node.component : "Text") as
          A2UIComponentKind | string,
        raw: node,
        childIds,
      },
      depth
    )
    for (const childId of childIds) recurse(childId, depth + 1)
  }

  recurse(rootId, 0)
}

/**
 * Recover the child id list from an A2UI node. The shape differs per
 * component kind:
 *
 * Reuse the renderer's structural references, including footer/actions,
 * nested tab/accordion bodies and step content. Keep legacy Dialog.body
 * before its actions for existing connector-generated surfaces.
 */
function extractChildIds(node: Record<string, unknown>): string[] {
  const legacyBody =
    node.component === "Dialog" && Array.isArray(node.body)
      ? node.body.filter((id): id is string => typeof id === "string")
      : []
  return [
    ...new Set([
      ...legacyBody,
      ...getComponentChildReferences(node as unknown as A2UIComponent).map((ref) => ref.id),
    ]),
  ]
}

// Only declarative display properties support bindings. In particular, an
// action's bindingPayload may contain a literal file `path` and must survive.
const BOUND_DISPLAY_FIELDS = new Set([
  "visible",
  "disabled",
  "text",
  "loading",
  "value",
  "error",
  "options",
  "checked",
  "title",
  "description",
  "image",
  "items",
  "src",
  "data",
  "selectedRows",
  "open",
  "label",
  "message",
  "activeTab",
  "pressed",
  "profileId",
  "content",
  "fallbackContent",
  "steps",
  "currentStep",
  "tableRows",
  "chartData",
  "networkNodes",
  "networkEdges",
  "plotPoints",
  "simulationConfig",
  "scenePrompt",
  "audioPrompt",
  "caption",
  "detail",
  "actionLabel",
])

function resolveDisplayBindings(
  node: Record<string, unknown>,
  dataModel: Record<string, unknown>
): Record<string, unknown> {
  const resolved = { ...node }
  for (const [key, value] of Object.entries(node)) {
    if (
      BOUND_DISPLAY_FIELDS.has(key) &&
      value &&
      typeof value === "object" &&
      "path" in value &&
      typeof value.path === "string"
    ) {
      resolved[key] = getValueByPath(dataModel, value.path)
    }
  }
  return resolved
}

/**
 * Generate a deterministic, namespaced action id. Used as the value the
 * platform delivers back on callback (Slack `action_id`, Telegram
 * `callback_data`, Discord `custom_id`, Lark `value.tag`).
 *
 *   `a2ui:<surfaceId>:<componentId>:<action>`
 *
 * Telegram caps `callback_data` at 64 bytes — `truncateActionId` below
 * is provided for adapters that must squeeze under that limit; new generic
 * bindings must store the wire ID. Author-owned namespaced bindings retain
 * their full ID and resolve through the compact-ID fallback.
 */
export function buildActionId(surfaceId: string, componentId: string, action: string): string {
  return `a2ui:${surfaceId}:${componentId}:${action}`
}

/** Reuse author-owned approval bindings instead of replacing their dispatch kind. */
export function resolveButtonWireAction(
  surfaceId: string,
  node: A2UIWalkNode
): { actionId: string; recordBinding: boolean } {
  const value = node.raw.value
  if (node.component === "Button" && typeof value === "string" && namespacedCallbackAction(value)) {
    return { actionId: value, recordBinding: false }
  }
  return {
    actionId: buildActionId(surfaceId, node.id, stringValue(node.raw.action) || node.id),
    recordBinding: true,
  }
}

/**
 * Telegram-specific helper: callback_data is capped at 64 bytes. We
 * sha1-hash the long id when it exceeds the cap; the parser side uses
 * `connectorCallbackBindings.actionId` to recover
 * surface/component context.
 */
export async function truncateActionId(
  fullId: string,
  maxBytes = 64
): Promise<{ wireId: string; isHashed: boolean }> {
  const bytes = new TextEncoder().encode(fullId)
  if (bytes.length <= maxBytes) return { wireId: fullId, isHashed: false }
  // Use Web Crypto so this works in both browser-renderer and Node test
  // environments. SHA-1 keeps the wire short (40 hex chars = 40 bytes).
  const digest = await crypto.subtle.digest("SHA-1", bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
  const prefix = CALLBACK_PREFIXES.find((prefix) => fullId.startsWith(prefix)) ?? "a2ui:"
  return { wireId: `${prefix}#${hex}`, isHashed: true }
}

/**
 * Persist (or update) the action_id ⇄ surface/component mapping so the
 * parser can recover context when the platform delivers a callback. Safe
 * to call multiple times for the same actionId — Dexie's `put` semantics
 * upsert by primary key.
 *
 * `conversationKey` is optional but recommended — it lets the bus scope
 * the assistant's next turn to the right ChatSession without re-deriving
 * from the callback payload.
 *
 * `kind` was added at schema v41 so the bus can distinguish ordinary
 * button/select callbacks (Slack `block_actions`, Discord
 * `MESSAGE_COMPONENT`, Lark `action_triggered_v1`, Telegram
 * `callback_query`) from ForceReply replies (Telegram) and Discord
 * modal-open buttons. Defaults to `"callback_query"` so callers in the
 * v18-v40 code path don't need to change.
 */
/**
 * Default TTL applied to callback bindings when the caller does not pass
 * an explicit `expiresAt`. 30 days is long enough that an A2UI surface
 * the operator left open across a weekend still resolves its callbacks,
 * but short enough that the table stops growing without bound. The
 * cross-adapter daily cleanup in `callback-binding-cleanup.ts` reaps
 * any binding whose `expiresAt` has passed.
 */
export const DEFAULT_CALLBACK_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Binding hints a surface author may put on a raw interactive component, so
 * the platform mapper records the component's binding under a specific kind
 * the bus short-circuits on (`help_quick_command`, `issue_action`,
 * `ask_user`, …) instead of the default `callback_query`. Mappers spread the
 * result into `recordCallbackBinding`. Absent hints yield `{}` — every
 * existing component keeps working.
 *
 *   - `bindingKind`           → `kind`
 *   - `bindingPayload`        → `payload`
 *   - `bindingActorScope`     → `actorScope`    ({mode, allowedUserIds?})
 *   - `bindingAllowedActions` → `allowedActions` (string[])
 *   - `bindingAccountId`      → `accountId`     (string)
 *   - `bindingExpiresAt`      → `expiresAt`     (epoch ms)
 *
 * The guard fields matter for kinds whose presses mutate state: without
 * `bindingActorScope` the authorization guard falls back to per-kind legacy
 * scopes (usually "conversation"), which may be wider than intended.
 *
 * NOTE on `bindingAllowedActions`: `authorizeConnectorCallback` compares it
 * against `normalizeRequestedAction(event)` — which is platform-dependent
 * (Slack sends the action verb, Telegram/Discord echo the wire action id,
 * personal-WeChat numeric replies carry the digit). A fixed verb list is only
 * correct on verb-carrying platforms; surfaces that must work across all of
 * them (e.g. `ask_user`) should leave the hint unset and lean on actorScope.
 */
export function bindingHintFields(raw: Record<string, unknown> | undefined): {
  kind?: ConnectorCallbackBindingRow["kind"]
  payload?: Record<string, unknown>
  accountId?: string
  actorScope?: CallbackActorScope
  allowedActions?: string[]
  expiresAt?: number
} {
  if (!raw) return {}
  const kind =
    typeof raw.bindingKind === "string"
      ? (raw.bindingKind as ConnectorCallbackBindingRow["kind"])
      : undefined
  const payload =
    raw.bindingPayload &&
    typeof raw.bindingPayload === "object" &&
    !Array.isArray(raw.bindingPayload)
      ? (raw.bindingPayload as Record<string, unknown>)
      : undefined
  const connectorAccountId =
    typeof raw.bindingAccountId === "string" && raw.bindingAccountId.length > 0
      ? raw.bindingAccountId
      : undefined
  const scopeRaw = raw.bindingActorScope
  let actorScope: CallbackActorScope | undefined =
    scopeRaw &&
    typeof scopeRaw === "object" &&
    !Array.isArray(scopeRaw) &&
    ["initiator", "operators", "conversation", "anyone"].includes(
      String((scopeRaw as { mode?: unknown }).mode)
    )
      ? {
          mode: (scopeRaw as { mode: "initiator" | "operators" | "conversation" | "anyone" }).mode,
          ...(Array.isArray((scopeRaw as { allowedUserIds?: unknown }).allowedUserIds)
            ? {
                allowedUserIds: (scopeRaw as { allowedUserIds: unknown[] }).allowedUserIds.filter(
                  (v): v is string => typeof v === "string"
                ),
              }
            : {}),
        }
      : undefined
  if (
    scopeRaw &&
    typeof scopeRaw === "object" &&
    (scopeRaw as { mode?: unknown }).mode === "marked-person"
  ) {
    const persons = (scopeRaw as { persons?: unknown }).persons
    actorScope = {
      mode: "marked-person",
      persons: Array.isArray(persons)
        ? persons.filter(
            (person) =>
              person &&
              typeof person === "object" &&
              ["local-person", "platform"].includes(person.kind)
          )
        : [],
    }
  }
  const allowedActions = Array.isArray(raw.bindingAllowedActions)
    ? (raw.bindingAllowedActions.filter(
        (v): v is string => typeof v === "string" && v.length > 0
      ) as string[])
    : undefined
  const expiresAt =
    typeof raw.bindingExpiresAt === "number" && Number.isFinite(raw.bindingExpiresAt)
      ? raw.bindingExpiresAt
      : undefined
  return {
    ...(kind ? { kind } : {}),
    ...(payload ? { payload } : {}),
    ...(connectorAccountId ? { accountId: connectorAccountId } : {}),
    ...(actorScope ? { actorScope } : {}),
    ...(allowedActions && allowedActions.length > 0 ? { allowedActions } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  }
}

export async function recordCallbackBinding(input: {
  adapterId: string
  actionId: string
  surfaceId: string
  componentId?: string
  conversationKey?: string
  /** Optional override for the createdAt stamp — defaults to `Date.now()`. */
  createdAt?: number
  /**
   * Explicit expiry. If omitted, defaults to `createdAt + 30d` so the
   * cross-adapter cleanup task can reap dead rows without the caller
   * having to think about retention.
   */
  expiresAt?: number
  /** Defaults to `"callback_query"` — see `ConnectorCallbackBindingKind`. */
  kind?: ConnectorCallbackBindingRow["kind"]
  /**
   * Free-form structured payload the bus passes to the kind-specific
   * dispatcher (schema v43). The `"skill_invoke"` kind carries
   * `{skillId, args}` here so the callback can re-fire the skill with
   * HITL bypass; `"modal_open"` may carry the platform view payload.
   */
  payload?: Record<string, unknown>
  /** Only the built-in skill dispatcher issues this; not a component hint. */
  skillConfirmationNonce?: string
  // Callback authorization guard fields (plan 2026-07-24 Phase 2). Optional
  // pass-throughs — absent fields leave the guard on its per-kind legacy
  // fallbacks (see lib/connectors/callback-authorization.ts).
  accountId?: string
  actorScope?: CallbackActorScope
  allowedActions?: string[]
}): Promise<void> {
  const createdAt = input.createdAt ?? Date.now()
  const row: ConnectorCallbackBindingRow = {
    id: `${input.adapterId}:${input.actionId}`,
    adapterId: input.adapterId,
    actionId: input.actionId,
    kind: input.kind ?? "callback_query",
    surfaceId: input.surfaceId,
    componentId: input.componentId,
    conversationKey: input.conversationKey,
    createdAt,
    expiresAt: input.expiresAt ?? createdAt + DEFAULT_CALLBACK_BINDING_TTL_MS,
    payload: input.payload,
    skillConfirmationNonce: input.skillConfirmationNonce,
    accountId: input.accountId,
    actorScope: input.actorScope,
    allowedActions: input.allowedActions,
  }
  const db = getDb()
  await db.transaction("rw", db.connectorCallbackBindings, async () => {
    const existing = await db.connectorCallbackBindings.get(row.id)
    // A redraw must never resurrect a used decision or erase its recovery receipt.
    if (existing?.consumedAt !== undefined || existing?.workflowDispatch) return
    await db.connectorCallbackBindings.put(row)
  })
}

/**
 * Reverse lookup: given the actionId the platform sent back, return the
 * surface/component context. Adapters call this from `parse.ts` when an
 * inbound callback arrives.
 *
 * A binding whose `expiresAt` has passed resolves as `undefined`: expiry is
 * enforced at read time, not only by the daily cleanup sweep, so a click on
 * a stale card cannot fire through a binding that is already scheduled for
 * reaping. Rows without `expiresAt` (pre-TTL legacy) never expire here.
 */
export async function resolveCallbackBinding(
  adapterId: string,
  actionId: string
): Promise<ConnectorCallbackBindingRow | undefined> {
  let row = await getDb()
    .connectorCallbackBindings.where("[adapterId+actionId]")
    .equals([adapterId, actionId])
    .first()
  // Long author-owned IDs keep their single original row. A compact wire ID
  // is resolved against that adapter's namespace, including after a restart.
  if (!row) {
    const prefix = CALLBACK_PREFIXES.find((prefix) => actionId.startsWith(`${prefix}#`))
    if (prefix && /^[a-f0-9]{40}$/.test(actionId.slice(prefix.length + 1))) {
      const candidates = await getDb()
        .connectorCallbackBindings.where("adapterId")
        .equals(adapterId)
        .filter((binding) => binding.actionId.startsWith(prefix))
        .toArray()
      for (const candidate of candidates) {
        const { wireId } = await truncateActionId(candidate.actionId, 0)
        if (wireId === actionId) {
          row = candidate
          break
        }
      }
    }
  }
  if (row?.expiresAt !== undefined && row.expiresAt <= Date.now()) return undefined
  return row
}

/**
 * Produce a plain-text projection of a surface — used as the
 * `plainTextMirror` on the outbound A2UI segment when the assistant
 * forgets to bake one in. Adapters can also call this at send-time as
 * the ultimate fallback when the platform cannot render any component
 * natively.
 *
 * Keeps a deliberately simple style — bullet list per leaf, action verbs
 * in [brackets] — so the result is legible across every channel
 * (Telegram, OneBot, raw email body, etc.).
 */
interface MirrorOptions {
  omitButtonIds?: ReadonlySet<string>
  maxHeadingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  /** Opt-in per-platform resource admission; absent preserves legacy text mirrors. */
  resourceUrl?: (value: string, kind: "image" | "link") => string | undefined
  resourcesOnly?: boolean
  /** Read-only, bounded data alternatives; absent preserves legacy widget placeholders. */
  dataWidgets?: boolean
}

export function generatePlainTextMirror(
  surface: A2UISegmentContent,
  options: MirrorOptions = {}
): string {
  return generateTextMirror(surface, false, options)
}

/** Semantic Markdown for channels with rich text; plain node values stay literal. */
export function generateMarkdownMirror(
  surface: A2UISegmentContent,
  options: MirrorOptions = {}
): string {
  return generateTextMirror(surface, true, options)
}

function generateTextMirror(
  surface: A2UISegmentContent,
  markdown: boolean,
  {
    omitButtonIds,
    maxHeadingLevel = 6,
    resourceUrl,
    resourcesOnly,
    dataWidgets,
  }: MirrorOptions = {}
): string {
  // Plain-text mirror is content-driven, not layout-driven — we don't
  // indent based on tree depth because pure layout containers (Column /
  // Row / Card body) are invisible in a chat channel. Visual hierarchy
  // is conveyed by semantic markers (`#` for Card titles, `[Button]` for
  // interactive verbs, `[!]` for Alerts, etc.) rather than whitespace.
  const lines: string[] = []
  const literal = markdown ? escapeMarkdown : (value: string) => value
  const image = (source: unknown, alt: string) => {
    const url = typeof source === "string" ? resourceUrl?.(source, "image") : undefined
    if (url)
      lines.push(
        markdown ? `![${literal(alt)}](${markdownLinkDestination(url)})` : `[${alt}] ${url}`
      )
    return Boolean(url)
  }
  walkA2UISurface(surface, (node) => {
    if (resourcesOnly && !["Image", "Link", "Card"].includes(node.component)) return
    switch (node.component) {
      case "Text": {
        const text = stringValue(node.raw.text)
        const heading = markdown && /^heading([1-6])$/.exec(stringValue(node.raw.variant))
        if (text)
          lines.push(
            heading && Number(heading[1]) > maxHeadingLevel
              ? `**${literal(text)}**`
              : `${heading ? "#".repeat(Number(heading[1])) + " " : ""}${literal(text)}`
          )
        break
      }
      case "Button": {
        if (omitButtonIds?.has(node.id)) break
        const text = stringValue(node.raw.text)
        const action = stringValue(node.raw.action)
        const href = stringValue(node.raw.href) || stringValue(node.raw.url)
        const url = href && node.raw.disabled !== true ? resourceUrl?.(href, "link") : undefined
        const command =
          resourceUrl && node.raw.disabled !== true ? stringValue(node.raw.qqCommand) : ""
        if (text || action)
          lines.push(
            literal(`[${text || action}]${url ? ` ${url}` : command ? ` ${command}` : ""}`)
          )
        break
      }
      case "Link": {
        const text = stringValue(node.raw.text) || (!resourceUrl ? stringValue(node.raw.href) : "")
        const url =
          node.raw.disabled !== true && !node.raw.action && typeof node.raw.href === "string"
            ? resourceUrl?.(node.raw.href, "link")
            : undefined
        if (url)
          lines.push(
            markdown
              ? `[${literal(text || url)}](${markdownLinkDestination(url)})`
              : text && text !== url
                ? `${text} (${url})`
                : url
          )
        else if (text && !resourcesOnly) lines.push(literal(text))
        break
      }
      case "Image": {
        const alt = stringValue(node.raw.alt) || "image"
        if (!image(node.raw.src, alt) && !resourcesOnly) lines.push(literal(`[${alt}]`))
        break
      }
      case "Divider":
        lines.push("---")
        break
      case "Alert": {
        const title = stringValue(node.raw.title)
        const text = stringValue(node.raw.message) || stringValue(node.raw.text)
        if (title || text)
          lines.push(literal(`[!] ${title || ""}${title && text ? ": " : ""}${text || ""}`))
        break
      }
      case "Card": {
        const title = stringValue(node.raw.title)
        if (title && !resourcesOnly)
          lines.push(
            `${markdown ? "#".repeat(Math.min(2, maxHeadingLevel)) : "#"} ${literal(title)}`
          )
        const description = stringValue(node.raw.description)
        if (description && !resourcesOnly) lines.push(literal(description))
        image(node.raw.image, title || "image")
        break
      }
      case "Table":
      case "Chart":
        lines.push(...(dataWidgets ? dataWidgetMirror(node) : [`[${node.component}]`]).map(literal))
        break
      case "Row":
      case "Column":
      case "ButtonGroup":
      case "List":
      case "Tabs":
      case "Accordion":
      case "Sheet":
      case "Drawer":
      case "Sidebar":
      case "Collapsible":
        // Layout-only — children handle the visible content.
        break
      case "TextField":
      case "TextArea": {
        const label = stringValue(node.raw.label) || stringValue(node.raw.placeholder) || "input"
        lines.push(literal(`[${label}: __________]`))
        break
      }
      case "Checkbox": {
        const label = stringValue(node.raw.label) || "checkbox"
        lines.push(literal(`[ ] ${label}`))
        break
      }
      case "Select":
      case "RadioGroup": {
        const label = stringValue(node.raw.label) || "select"
        const options = Array.isArray(node.raw.options)
          ? (node.raw.options as Array<Record<string, unknown>>).map(
              (o) => stringValue(o.label) || stringValue(o.value) || ""
            )
          : []
        lines.push(literal(`${label}: ${options.filter(Boolean).join(" / ")}`))
        break
      }
      default: {
        // Unknown / specialised kinds — emit a best-effort placeholder so
        // the user can see something happened.
        lines.push(literal(`[${node.component}]`))
      }
    }
  })
  return lines.join(markdown ? "\n\n" : "\n")
}

/** Scalar display values only: never enumerate object cells or execute column renderers. */
function dataMirrorCell(value: unknown): string {
  const text = stringValue(value)
  // Slice before iterating Unicode so hostile long strings cannot expand an
  // unbounded code-point array. Keep cell truncation visible to the reader.
  const prefix = text.slice(0, 512)
  const normalized = prefix.replace(/[\r\n]+/g, " ↵ ").replace(/\t/g, " ")
  const points = [...normalized]
  return text.length > prefix.length || points.length > 256
    ? points.slice(0, 255).join("") + "…"
    : normalized
}

/** Source-order summary of fields the canonical Table/Chart actually selects. */
function dataWidgetMirror(node: A2UIWalkNode): string[] {
  const raw = node.raw
  const title = dataMirrorCell(raw.title)
  const lines = [`[${node.component}]${title ? ` ${title}` : ""}`]
  const description = node.component === "Table" ? dataMirrorCell(raw.description) : ""
  if (description) lines.push(description)
  const data = Array.isArray(raw.data) ? raw.data : []
  let columns: Array<{ key: string; header: string }> = []
  let omittedColumns = 0
  if (node.component === "Table" && Array.isArray(raw.columns)) {
    columns = raw.columns.slice(0, 12).flatMap((column) =>
      column &&
      typeof column === "object" &&
      Object.hasOwn(column, "key") &&
      typeof column.key === "string"
        ? [
            {
              key: column.key,
              header:
                dataMirrorCell(Object.hasOwn(column, "header") ? column.header : undefined) ||
                dataMirrorCell(column.key),
            },
          ]
        : []
    )
    omittedColumns = Math.max(0, raw.columns.length - 12)
  } else if (node.component === "Chart") {
    const xKey = typeof raw.xKey === "string" && raw.xKey ? raw.xKey : "name"
    const yKeys = Array.isArray(raw.yKeys) ? raw.yKeys : ["value"]
    // Pie/donut consume only the first series; scatter renders all yKeys.
    const selected = ["pie", "donut"].includes(String(raw.chartType)) ? yKeys.slice(0, 1) : yKeys
    columns = [
      { key: xKey, header: dataMirrorCell(xKey) },
      ...selected
        .slice(0, 11)
        .flatMap((key) => (typeof key === "string" ? [{ key, header: dataMirrorCell(key) }] : [])),
    ]
    omittedColumns = Math.max(0, selected.length - 11)
  }
  if (omittedColumns) lines.push(`[… +${omittedColumns} columns]`)
  if (!data.length) {
    lines.push(
      Array.isArray(raw.data)
        ? (node.component === "Table" ? dataMirrorCell(raw.emptyMessage) : "") || "[0 rows]"
        : "[data unavailable]"
    )
    return lines
  }
  if (!columns.length) return [...lines, `[${data.length} rows; no display columns]`]
  let size = lines.join("\n").length
  let shown = 0
  for (let index = 0; index < Math.min(data.length, 50); index++) {
    const row = data[index]
    const fields =
      row && typeof row === "object" && !Array.isArray(row)
        ? columns
            .map(
              ({ key, header }) =>
                `${header}: ${dataMirrorCell(Object.hasOwn(row, key) ? row[key] : undefined)}`
            )
            .join("; ")
        : "[data unavailable]"
    const line = `${index + 1}. ${fields}`
    // Reserve space for an explicit omitted-row count; do not send a
    // truncated row or an unbounded expansion of an already large surface.
    if (size + line.length + 1 > 11_936) break
    lines.push(line)
    size += line.length + 1
    shown++
  }
  if (shown < data.length) lines.push(`[… +${data.length - shown} rows]`)
  return lines
}

function stringValue(v: unknown): string {
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return ""
}
