/**
 * The Feishu/Lark endpoints the two Lark providers use, over the shared
 * `LarkAuthedApi` (spec 2026-09-06 D10). Pure request builders and
 * normalisers, so the providers stay about reconciliation and this file is
 * the one place the wire shapes are spelled.
 *
 * Task v2:
 *   GET   /open-apis/task/v2/tasklists                       tasklists the identity can see
 *   GET   /open-apis/task/v2/sections?resource_type=tasklist  sections of one tasklist
 *   GET   /open-apis/task/v2/tasklists/{guid}/tasks           task summaries in a tasklist
 *   GET   /open-apis/task/v2/tasks/{guid}                     one task in full
 *   POST  /open-apis/task/v2/tasks                            create
 *   PATCH /open-apis/task/v2/tasks/{guid}                     update (`update_fields` names the keys)
 *
 * Bitable v1:
 *   GET   /open-apis/bitable/v1/apps/{app}/tables                       tables
 *   GET   /open-apis/bitable/v1/apps/{app}/tables/{table}/fields        columns
 *   POST  /open-apis/bitable/v1/apps/{app}/tables/{table}/records/search rows
 *   POST  /open-apis/bitable/v1/apps/{app}/tables/{table}/records        create
 *   PUT   /open-apis/bitable/v1/apps/{app}/tables/{table}/records/{id}  update
 *
 * Timestamps on the Task API are millisecond strings. Bitable dates are
 * millisecond numbers. Both are normalised to epoch ms numbers here.
 */

import { LarkApiError, readAllLarkPages, type LarkPage } from "@cognia/feishu-protocol"
import { withLarkAuthedApi, type LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { ExternalSyncRateLimited } from "@/lib/external-services/sync/types"
import { isTauri } from "@/lib/tauri"
import { assertIssueSyncSource } from "../kept-copy-source"
import { KeptCopySourceError } from "@/lib/docs-providers/kept-copy-source"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import type { IssueSyncBinding } from "../types"

/** Preserve retry headers before the shared harness projects them into LarkApiError. */
export async function issueLarkHttpRequest(input: Parameters<typeof connectorsHttpRequest>[0]) {
  const response = await connectorsHttpRequest(input)
  let code: unknown
  try {
    code = JSON.parse(response.body).code
  } catch {
    /* Status still applies to non-JSON responses. */
  }
  if (response.status === 429 || code === 99991400) {
    const headers = Object.fromEntries(
      Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value])
    )
    const retry = headers["retry-after"]
    const delay = retry
      ? /^\d+(?:\.\d+)?$/.test(retry.trim())
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now()
      : NaN
    const reset = Number(headers["x-ogw-ratelimit-reset"]) * 1000
    throw new ExternalSyncRateLimited(
      Number.isFinite(delay) && delay >= 0
        ? delay
        : Number.isFinite(reset) && reset >= 0
          ? reset
          : 60_000
    )
  }
  return response
}

export function issueLarkError(error: unknown): unknown {
  return error instanceof LarkApiError && (error.status === 429 || error.code === 99991400)
    ? new ExternalSyncRateLimited(error.retryAfterMs ?? 60_000)
    : error
}

export function withIssueLarkApi<T>(
  adapterId: string,
  fn: (api: LarkAuthedApi) => Promise<T>,
  signal?: AbortSignal,
  expectedAuthorizationEpoch?: string,
  credentialContext?: PersonalCredentialContext
): Promise<T> {
  return withLarkAuthedApi(
    {
      adapterId,
      identity: "user",
      credentialContext,
      signal,
      expectedAuthorizationEpoch,
      ...(isTauri() ? { httpImpl: issueLarkHttpRequest } : {}),
      mapError: issueLarkError,
    },
    (api) => fn(api)
  )
}

/** Direct publish/update calls need the same captured identity as prepared syncs. */
export async function withIssueLarkBindingApi<T>(
  binding: IssueSyncBinding,
  fn: (api: LarkAuthedApi) => Promise<T>,
  options: {
    credentialContext?: PersonalCredentialContext
    signal?: AbortSignal
    expectedAuthorizationEpoch?: string
    withApi?: <R>(
      adapterId: string,
      read: (api: LarkAuthedApi) => Promise<R>,
      credentialContext?: PersonalCredentialContext
    ) => Promise<R>
  } = {}
): Promise<T> {
  const source = await assertIssueSyncSource(binding)
  const resource = binding.resource
  if (resource.kind !== "lark-tasklist" && resource.kind !== "lark-bitable")
    throw new Error("Invalid Lark binding")
  const adapterId = source?.hostMetadata?.adapterId ?? resource.adapterId
  const epoch = source?.hostMetadata?.authorizationEpoch ?? options.expectedAuthorizationEpoch
  if (
    source &&
    (!source.hostMetadata?.adapterId ||
      !epoch ||
      (options.expectedAuthorizationEpoch && options.expectedAuthorizationEpoch !== epoch))
  )
    throw new KeptCopySourceError("source-disconnected")
  const assertCurrent = async () => {
    options.signal?.throwIfAborted()
    if (!source) return
    const current = await assertIssueSyncSource(binding, source.id)
    if (
      current?.identityKey !== source.identityKey ||
      current?.revision !== source.revision ||
      current?.hostMetadata?.authorizationEpoch !== epoch
    )
      throw new KeptCopySourceError("source-disconnected")
    options.signal?.throwIfAborted()
  }
  const guarded = async (api: LarkAuthedApi) => {
    await assertCurrent()
    return fn(api)
  }
  const result = await (options.withApi
    ? options.withApi(adapterId, guarded, options.credentialContext)
    : withIssueLarkApi(adapterId, guarded, options.signal, epoch, options.credentialContext))
  await assertCurrent()
  return result
}

const PAGE = 100

/** The harness always binds the write verbs. A fake that omits one is a bug, not a mode. */
function writer(
  api: LarkAuthedApi,
  verb: "patch" | "put"
): NonNullable<LarkAuthedApi[typeof verb]> {
  const fn = api[verb]
  if (!fn) throw new Error(`LarkAuthedApi has no ${verb.toUpperCase()} verb`)
  return fn.bind(api) as NonNullable<LarkAuthedApi[typeof verb]>
}
/** Hard ceiling on tasks read per tasklist in one pass. */
export const MAX_LARK_TASKS = 500
/** Bitable's own maximum for `records/search`. */
export const MAX_BITABLE_PAGE = 500

export interface LarkTasklistSummary {
  guid: string
  name: string
  url?: string
}

export interface LarkSectionSummary {
  guid: string
  name: string
  isDefault?: boolean
}

export interface LarkTaskMember {
  id: string
  type?: string
  role?: string
  name?: string
}

/** A task as `GET /task/v2/tasks/{guid}` returns it, already normalised. */
export interface LarkTask {
  guid: string
  summary: string
  description?: string
  /** Epoch ms, or undefined when the task has no due date. */
  dueAt?: number
  dueIsAllDay?: boolean
  /** Epoch ms when completed, undefined when open. */
  completedAt?: number
  members: LarkTaskMember[]
  /** `{ tasklistGuid, sectionGuid }` per tasklist the task is in. */
  tasklists: Array<{ tasklistGuid: string; sectionGuid?: string }>
  url?: string
  createdAt?: number
  updatedAt?: number
}

function msString(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value && value !== "0") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

interface RawTask {
  guid?: string
  summary?: string
  description?: string
  due?: { timestamp?: string; is_all_day?: boolean } | null
  completed_at?: string
  members?: Array<{ id?: string; type?: string; role?: string; name?: string }>
  tasklists?: Array<{ tasklist_guid?: string; section_guid?: string }>
  url?: string
  created_at?: string
  updated_at?: string
}

export function normalizeLarkTask(raw: RawTask): LarkTask | null {
  if (!raw.guid) return null
  return {
    guid: raw.guid,
    summary: raw.summary ?? "",
    ...(raw.description ? { description: raw.description } : {}),
    ...(msString(raw.due?.timestamp) !== undefined ? { dueAt: msString(raw.due?.timestamp) } : {}),
    ...(raw.due?.is_all_day !== undefined ? { dueIsAllDay: raw.due.is_all_day } : {}),
    ...(msString(raw.completed_at) !== undefined
      ? { completedAt: msString(raw.completed_at) }
      : {}),
    members: (raw.members ?? [])
      .filter((member): member is { id: string } & typeof member => Boolean(member?.id))
      .map((member) => ({
        id: member.id,
        ...(member.type ? { type: member.type } : {}),
        ...(member.role ? { role: member.role } : {}),
        ...(member.name ? { name: member.name } : {}),
      })),
    tasklists: (raw.tasklists ?? [])
      .filter((entry) => entry?.tasklist_guid)
      .map((entry) => ({
        tasklistGuid: entry.tasklist_guid as string,
        ...(entry.section_guid ? { sectionGuid: entry.section_guid } : {}),
      })),
    ...(raw.url ? { url: raw.url } : {}),
    ...(msString(raw.created_at) !== undefined ? { createdAt: msString(raw.created_at) } : {}),
    ...(msString(raw.updated_at) !== undefined ? { updatedAt: msString(raw.updated_at) } : {}),
  }
}

function readAll<T>(
  api: LarkAuthedApi,
  path: string,
  cap: number,
  pageSize: number = PAGE
): Promise<{ items: T[]; truncated: boolean }> {
  return readAllLarkPages<T>(api, path, { cap, pageSize })
}

export async function listLarkTasklists(api: LarkAuthedApi): Promise<LarkTasklistSummary[]> {
  const { items } = await readAll<{ guid?: string; name?: string; url?: string }>(
    api,
    "/open-apis/task/v2/tasklists",
    200,
    50
  )
  return items
    .filter((row) => row.guid)
    .map((row) => ({
      guid: row.guid as string,
      name: row.name ?? (row.guid as string),
      ...(row.url ? { url: row.url } : {}),
    }))
}

export async function listLarkSections(
  api: LarkAuthedApi,
  tasklistGuid: string
): Promise<LarkSectionSummary[]> {
  const { items } = await readAll<{ guid?: string; name?: string; is_default?: boolean }>(
    api,
    `/open-apis/task/v2/sections?resource_type=tasklist&resource_id=${encodeURIComponent(tasklistGuid)}`,
    200,
    50
  )
  return items
    .filter((row) => row.guid)
    .map((row) => ({
      guid: row.guid as string,
      name: row.name ?? (row.guid as string),
      ...(row.is_default !== undefined ? { isDefault: row.is_default } : {}),
    }))
}

/**
 * Every task of a tasklist, in full. The list endpoint returns summaries
 * without a body or an update time, so each task is read once more. Bounded
 * by `MAX_LARK_TASKS`, reported through `truncated`.
 */
export async function listLarkTasklistTasks(
  api: LarkAuthedApi,
  tasklistGuid: string
): Promise<{ tasks: LarkTask[]; truncated: boolean }> {
  const { items, truncated } = await readAll<{ guid?: string }>(
    api,
    `/open-apis/task/v2/tasklists/${encodeURIComponent(tasklistGuid)}/tasks?user_id_type=open_id`,
    MAX_LARK_TASKS
  )
  const tasks: LarkTask[] = []
  for (const summary of items) {
    if (!summary.guid) continue
    const task = await getLarkTask(api, summary.guid)
    if (task) tasks.push(task)
  }
  return { tasks, truncated }
}

/** One complete page, including completed tasks. No per-run cap. */
export async function listLarkTasklistTasksPage(
  api: LarkAuthedApi,
  tasklistGuid: string,
  token?: string
): Promise<{ tasks: LarkTask[]; nextPage?: string }> {
  const page = await api.get<LarkPage<{ guid?: string }>>(
    `/open-apis/task/v2/tasklists/${encodeURIComponent(tasklistGuid)}/tasks?user_id_type=open_id&page_size=${PAGE}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`
  )
  if (page.has_more && !page.page_token) throw new Error("Lark task page token missing")
  const tasks: LarkTask[] = []
  for (const summary of page.items ?? []) {
    if (!summary.guid) throw new Error("Lark task id missing")
    const task = await getLarkTask(api, summary.guid)
    if (!task) throw new Error("Lark task read incomplete")
    tasks.push(task)
  }
  return { tasks, ...(page.has_more ? { nextPage: page.page_token } : {}) }
}

export async function getLarkTask(api: LarkAuthedApi, guid: string): Promise<LarkTask | null> {
  const data = await api.get<{ task?: RawTask }>(
    `/open-apis/task/v2/tasks/${encodeURIComponent(guid)}?user_id_type=open_id`
  )
  return data.task ? normalizeLarkTask(data.task) : null
}

export interface LarkTaskPatch {
  summary?: string
  description?: string
  /** Epoch ms, or null to clear. */
  dueAt?: number | null
  /** True to complete now, false to reopen. */
  completed?: boolean
}

/** Body for `PATCH /task/v2/tasks/{guid}`: the task fields plus their names. */
export function buildLarkTaskPatch(
  patch: LarkTaskPatch,
  now: number = Date.now()
): { task: Record<string, unknown>; update_fields: string[] } {
  const task: Record<string, unknown> = {}
  const update_fields: string[] = []
  if (patch.summary !== undefined) {
    task.summary = patch.summary
    update_fields.push("summary")
  }
  if (patch.description !== undefined) {
    task.description = patch.description
    update_fields.push("description")
  }
  if (patch.dueAt !== undefined) {
    task.due = patch.dueAt === null ? null : { timestamp: String(patch.dueAt), is_all_day: true }
    update_fields.push("due")
  }
  if (patch.completed !== undefined) {
    task.completed_at = patch.completed ? String(now) : "0"
    update_fields.push("completed_at")
  }
  return { task, update_fields }
}

export async function updateLarkTask(
  api: LarkAuthedApi,
  guid: string,
  patch: LarkTaskPatch,
  now: number = Date.now()
): Promise<LarkTask | null> {
  const body = buildLarkTaskPatch(patch, now)
  if (body.update_fields.length === 0) return getLarkTask(api, guid)
  const data = await writer(api, "patch")<{ task?: RawTask }>(
    `/open-apis/task/v2/tasks/${encodeURIComponent(guid)}?user_id_type=open_id`,
    body
  )
  return data.task ? normalizeLarkTask(data.task) : null
}

export async function createLarkTask(
  api: LarkAuthedApi,
  input: {
    tasklistGuid: string
    sectionGuid?: string
    summary: string
    description?: string
    dueAt?: number
  }
): Promise<LarkTask | null> {
  const data = await api.post<{ task?: RawTask }>("/open-apis/task/v2/tasks?user_id_type=open_id", {
    summary: input.summary,
    ...(input.description ? { description: input.description } : {}),
    ...(input.dueAt !== undefined
      ? { due: { timestamp: String(input.dueAt), is_all_day: true } }
      : {}),
    tasklists: [
      {
        tasklist_guid: input.tasklistGuid,
        ...(input.sectionGuid ? { section_guid: input.sectionGuid } : {}),
      },
    ],
  })
  return data.task ? normalizeLarkTask(data.task) : null
}

// ---------------------------------------------------------------------------
// Bitable
// ---------------------------------------------------------------------------

export interface BitableTableSummary {
  tableId: string
  name: string
}

export interface BitableFieldSummary {
  fieldId: string
  name: string
  /** Bitable field type code (1 text, 2 number, 3 single select, 5 date, 11 person, …). */
  type: number
}

export interface BitableRecord {
  recordId: string
  fields: Record<string, unknown>
  /** Epoch ms when present on the wire. */
  lastModifiedAt?: number
}

export async function listBitableTables(
  api: LarkAuthedApi,
  appToken: string
): Promise<BitableTableSummary[]> {
  const { items } = await readAll<{ table_id?: string; name?: string }>(
    api,
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables`,
    100
  )
  return items
    .filter((row) => row.table_id)
    .map((row) => ({ tableId: row.table_id as string, name: row.name ?? (row.table_id as string) }))
}

export async function listBitableFields(
  api: LarkAuthedApi,
  appToken: string,
  tableId: string
): Promise<BitableFieldSummary[]> {
  const { items } = await readAll<{ field_id?: string; field_name?: string; type?: number }>(
    api,
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/fields`,
    200
  )
  return items
    .filter((row) => row.field_id && row.field_name)
    .map((row) => ({
      fieldId: row.field_id as string,
      name: row.field_name as string,
      type: typeof row.type === "number" ? row.type : 0,
    }))
}

export async function listBitableRecords(
  api: LarkAuthedApi,
  appToken: string,
  tableId: string
): Promise<{ records: BitableRecord[]; truncated: boolean }> {
  const records: BitableRecord[] = []
  let token: string | undefined
  let truncated = false
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await api.post<
      LarkPage<{
        record_id?: string
        fields?: Record<string, unknown>
        last_modified_time?: number
      }>
    >(
      `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(
        tableId
      )}/records/search?page_size=${MAX_BITABLE_PAGE}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`,
      {}
    )
    for (const row of page.items ?? []) {
      if (!row.record_id) continue
      records.push({
        recordId: row.record_id,
        fields: row.fields ?? {},
        ...(typeof row.last_modified_time === "number"
          ? { lastModifiedAt: row.last_modified_time }
          : {}),
      })
    }
    if (!page.has_more || !page.page_token) break
    token = page.page_token
    if (guard === 19) truncated = true
  }
  return { records, truncated }
}

export async function listBitableRecordsPage(
  api: LarkAuthedApi,
  appToken: string,
  tableId: string,
  token?: string
): Promise<{ records: BitableRecord[]; nextPage?: string }> {
  const page = await api.post<
    LarkPage<{ record_id?: string; fields?: Record<string, unknown>; last_modified_time?: number }>
  >(
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(tableId)}/records/search?page_size=${MAX_BITABLE_PAGE}${token ? `&page_token=${encodeURIComponent(token)}` : ""}`,
    {}
  )
  if (page.has_more && !page.page_token) throw new Error("Bitable page token missing")
  const records = (page.items ?? []).map((row) => {
    if (!row.record_id) throw new Error("Bitable record id missing")
    return {
      recordId: row.record_id,
      fields: row.fields ?? {},
      ...(typeof row.last_modified_time === "number"
        ? { lastModifiedAt: row.last_modified_time }
        : {}),
    }
  })
  return { records, ...(page.has_more ? { nextPage: page.page_token } : {}) }
}

export async function updateBitableRecord(
  api: LarkAuthedApi,
  appToken: string,
  tableId: string,
  recordId: string,
  fields: Record<string, unknown>
): Promise<void> {
  await writer(api, "put")(
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(
      tableId
    )}/records/${encodeURIComponent(recordId)}`,
    { fields }
  )
}

export async function createBitableRecord(
  api: LarkAuthedApi,
  appToken: string,
  tableId: string,
  fields: Record<string, unknown>
): Promise<string | null> {
  const data = await api.post<{ record?: { record_id?: string } }>(
    `/open-apis/bitable/v1/apps/${encodeURIComponent(appToken)}/tables/${encodeURIComponent(
      tableId
    )}/records`,
    { fields }
  )
  return data.record?.record_id ?? null
}

/**
 * One cell as text. Bitable returns rich text as segments, people and
 * links as objects, and options as strings. Anything structured is flattened
 * to the text a person sees, and `null` stays `null`.
 */
export function bitableCellText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    const parts = value.map(bitableCellText).filter((part): part is string => part !== null)
    return parts.length > 0 ? parts.join(", ") : null
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of ["text", "name", "en_name", "link", "value"]) {
      const candidate = record[key]
      if (typeof candidate === "string") return candidate
    }
  }
  return null
}

/** A date cell as epoch ms, tolerating both numbers and numeric strings. */
export function bitableCellDate(value: unknown): number | null {
  const ms = msString(value)
  return ms === undefined ? null : ms
}

export function bitableCellNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
