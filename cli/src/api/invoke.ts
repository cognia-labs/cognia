/**
 * One command call, from a validated body to a result.
 *
 * Three things happen here that the transport deliberately does not do:
 *
 *   - The wire is checked against the command. `authorize_transport` refuses a
 *     non-`execution` target on the device wire, so sending one is a
 *     guaranteed 403 and is refused locally instead.
 *   - An idempotency key is minted. The host requires a UUID header for the
 *     1090 commands the manifest marks `required`, and a caller who has to
 *     invent one by hand will eventually reuse one.
 *   - An approval the CLI cannot satisfy is named before the call. The host
 *     answers `interactive_approval_required` and `signed_policy_required`
 *     with the right status, but not with the command that fixes it.
 */

import { randomUUID } from "node:crypto"

import type { CliFailure } from "../cli/errors"
import type { ApiCommandEntry } from "./types"
import {
  operationPath,
  failureFromResponse,
  type CommandOutcome,
  type HostTransport,
  type RequestOptions,
} from "./transport"

/**
 * The command that mints an approval lease cannot be asked to present one.
 * `authorize_approval` carves out exactly this name, so the CLI must not
 * refuse it for the reason the host would waive.
 */
export const LEASE_ISSUING_COMMAND = "host_admin_lease_issue"

/** The field names the host reads a lease and a policy out of. */
const LEASE_FIELDS = ["adminLease", "admin_lease"]
const POLICY_FIELDS = ["policyId", "policy_id"]

function hasAnyField(body: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => typeof body[field] === "string" && body[field] !== "")
}

export interface PreflightInput {
  entry: ApiCommandEntry
  transport: HostTransport
  body: Record<string, unknown>
}

/**
 * Refuse a call the host is certain to reject, with the remedy attached.
 * Returns undefined when the call is worth making.
 */
export function preflight(input: PreflightInput): CliFailure | undefined {
  const { entry, transport, body } = input

  if (!entry.wires.includes(transport.wire)) {
    const other = transport.wire === "http" ? "internal" : "http"
    return {
      error: `${entry.name} is not carried on the ${transport.wire} wire`,
      details: [
        `target ${entry.target}, reachable on: ${entry.wires.join(", ")}`,
        transport.wire === "http"
          ? "the paired-device wire admits only execution and host-admin commands"
          : "this command is only exposed to paired devices",
      ],
      cause: "unknown-command",
      fix: entry.wires.includes(other)
        ? [`use a ${other === "internal" ? "headless" : "device"} host for this command`]
        : ["this command has no wire the CLI can reach"],
      inspect: [`cognia-agent api describe ${entry.name}`],
    }
  }

  // Approvals only bind the device wire. A loopback service principal is the
  // policy authority for the Brain plane, so the internal wire skips them.
  if (transport.wire !== "http") return undefined

  if (entry.approval === "interactive" && entry.name !== LEASE_ISSUING_COMMAND) {
    if (!hasAnyField(body, LEASE_FIELDS)) {
      return {
        error: `${entry.name} needs an approval lease a human granted on the host`,
        cause: "refused",
        fix: [
          `cognia-agent api call host_admin_lease_issue --operations '["${entry.name}"]'`,
          "then pass the lease as --admin-lease <lease>",
        ],
        inspect: [`cognia-agent api describe ${entry.name}`],
      }
    }
  }

  if (entry.approval === "signed-policy" && !hasAnyField(body, POLICY_FIELDS)) {
    return {
      error: `${entry.name} needs an active host policy`,
      details: [`capability ${entry.capability}, risk ${entry.risk}`],
      cause: "refused",
      fix: [
        "pass --policy-id <id> naming a policy the host has signed for this capability",
        "a policy is authored on the host, not by this CLI",
      ],
      inspect: [`cognia-agent api describe ${entry.name}`],
    }
  }

  return undefined
}

export interface InvokeInput {
  entry: ApiCommandEntry
  body: Record<string, unknown>
  transport: HostTransport
  timeoutMs: number
  /** Poll an accepted command until its receipt settles. */
  wait?: boolean
  all?: boolean
  maxPages?: number
  totalTimeoutMs?: number
  signal?: AbortSignal
  /** Overrides the minted key. Only useful when retrying a specific call. */
  idempotencyKey?: string
  /** Injected so the wait loop does not really sleep in tests. */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  newId?: () => string
}

export const WAIT_POLL_INTERVAL_MS = 500

/** How `--all` follows one command's pages. */
export interface PaginationPlan {
  /** The request field the continuation goes back in. */
  request: "pageToken" | "cursor"
  /** The result field carrying the next continuation. */
  continuation: "nextPageToken" | "nextCursor"
  /** The array each page adds to. */
  list: string
}

function schemaProperties(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const properties = schema?.properties
  return properties && typeof properties === "object" ? (properties as Record<string, unknown>) : {}
}

/**
 * The page convention a command's own schemas declare, or null when it has
 * none `--all` can follow: `pageToken` → `nextPageToken` (the Page shape) or
 * `cursor` → `nextCursor` (with `hasMore`), the two the Rust wrapper follows
 * too. Decided from the contract before anything is sent, so a command that
 * cannot be paged is refused instead of run once and then refused.
 */
export function paginationPlan(entry: ApiCommandEntry): PaginationPlan | null {
  const input = schemaProperties(entry.inputSchema)
  const output = schemaProperties(entry.outputSchema)
  const convention =
    "pageToken" in input && "nextPageToken" in output
      ? ({ request: "pageToken", continuation: "nextPageToken" } as const)
      : "cursor" in input && "nextCursor" in output
        ? ({ request: "cursor", continuation: "nextCursor" } as const)
        : null
  if (!convention) return null
  const arrays = Object.entries(output)
    .filter(([, schema]) => (schema as { type?: unknown } | undefined)?.type === "array")
    .map(([name]) => name)
  const list = arrays.includes("items") ? "items" : arrays.length === 1 ? arrays[0] : undefined
  return list ? { ...convention, list } : null
}

export interface InvokeResult {
  outcome: CommandOutcome
  /** Present when the call was accepted rather than completed. */
  operationId?: string
  /** True when `--wait` polled the receipt to a settled state. */
  waited?: boolean
}

export async function invokeCommand(input: InvokeInput): Promise<InvokeResult> {
  if (input.signal?.aborted)
    return { outcome: { ok: false, cause: "timeout", message: "command stopped before dispatch" } }
  const now = input.now ?? Date.now
  const deadline = now() + (input.totalTimeoutMs ?? input.timeoutMs)
  const options: RequestOptions = {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    // A required key is minted below, and the host's idempotency ledger is
    // shared by every route; structural reads repeat harmlessly. Only these
    // may be sent again another way after the first attempt may have arrived.
    replaySafe: input.entry.idempotency === "required" || input.entry.idempotency === "structural",
    ...(input.entry.idempotency === "required"
      ? { idempotencyKey: input.idempotencyKey ?? (input.newId ?? randomUUID)() }
      : input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : {}),
  }
  if (
    options.idempotencyKey &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.idempotencyKey)
  )
    return {
      outcome: {
        ok: false,
        cause: "invalid-request",
        message:
          "--idempotency-key must be a UUID (use --body-idempotency-key for business intents)",
      },
    }
  const maxPages = input.maxPages ?? 1000
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10000)
    return {
      outcome: {
        ok: false,
        cause: "invalid-request",
        message: "--max-pages must be between 1 and 10000",
      },
    }
  const plan = input.all ? paginationPlan(input.entry) : null
  if (input.all && !plan)
    return {
      outcome: {
        ok: false,
        cause: "invalid-request",
        code: "pagination_unsupported",
        message:
          `${input.entry.name} declares no page token --all can follow ` +
          "(pageToken→nextPageToken or cursor→nextCursor); drop --all or page through it by hand",
      },
    }
  const execute = (body: Record<string, unknown>) =>
    input.transport.execute(input.entry.name, body, {
      ...options,
      timeoutMs: Math.max(1, Math.min(input.timeoutMs, deadline - now())),
    })
  let outcome = await execute(input.body)
  let operationId: string | undefined
  let waited: boolean | undefined
  if (outcome.ok && outcome.accepted) {
    operationId = outcome.operationId
    if (input.wait && !operationId)
      return {
        outcome: {
          ok: false,
          cause: "failed",
          message: "accepted command returned no operation id",
        },
      }
    if (input.wait && operationId) {
      outcome = await pollOperation({
        transport: input.transport,
        operationId,
        timeoutMs: input.timeoutMs,
        deadline,
        sleep: input.sleep,
        now: input.now,
        signal: input.signal,
      })
      waited = true
    }
  }
  if (plan && outcome.ok && !outcome.accepted) {
    const { request, continuation, list } = plan
    const pageOf = (
      result: unknown
    ): (Record<string, unknown> & Record<string, unknown[]>) | null =>
      result &&
      typeof result === "object" &&
      Array.isArray((result as Record<string, unknown>)[list])
        ? (result as Record<string, unknown> & Record<string, unknown[]>)
        : null
    const first = pageOf(outcome.result)
    if (!first)
      return {
        outcome: {
          ok: false,
          cause: "failed",
          message: `--all expected a page with ${list} and ${continuation}`,
        },
      }
    const items = [...first[list]!]
    const seen = new Set<string>(
      typeof input.body[request] === "string" ? [input.body[request] as string] : []
    )
    let page: Record<string, unknown> = first
    let count = 1
    for (;;) {
      const token = page[continuation]
      if (typeof token !== "string" || token.length === 0) {
        // A page that says more follow but names no way to get them would
        // otherwise end the walk early and look complete.
        if (page.hasMore === true)
          return {
            outcome: {
              ok: false,
              cause: "failed",
              code: "pagination_truncated",
              message: `host reported more pages but returned no ${continuation}`,
            },
          }
        break
      }
      if (input.signal?.aborted || now() >= deadline)
        return {
          outcome: { ok: false, cause: "timeout", message: "pagination exceeded its total budget" },
        }
      if (seen.has(token))
        return {
          outcome: {
            ok: false,
            cause: "failed",
            code: "pagination_stalled",
            message: "host repeated a page token",
          },
        }
      if (count >= maxPages)
        return {
          outcome: {
            ok: false,
            cause: "failed",
            code: "pagination_limit",
            message: "--max-pages reached before the final page",
          },
        }
      seen.add(token)
      const next = await execute({ ...input.body, [request]: token })
      if (!next.ok) return { outcome: next }
      const nextPage = next.accepted ? null : pageOf(next.result)
      if (!nextPage)
        return {
          outcome: {
            ok: false,
            cause: "failed",
            message: "host returned an invalid pagination page",
          },
        }
      items.push(...nextPage[list]!)
      page = nextPage
      count++
    }
    const { [continuation]: _continuation, ...metadata } = first
    outcome = {
      ...outcome,
      result: { ...metadata, ...("hasMore" in first ? { hasMore: false } : {}), [list]: items },
    }
  }
  return { outcome, ...(operationId ? { operationId } : {}), ...(waited ? { waited } : {}) }
}

interface PollInput {
  transport: HostTransport
  operationId: string
  timeoutMs: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  deadline?: number
  signal?: AbortSignal
}

/**
 * Poll an accepted command's receipt until it settles or the budget runs out.
 *
 * The budget is the same `--timeout` the call itself used, so `--wait` never
 * hangs longer than the operator asked a single command to take.
 */
export async function pollOperation(input: PollInput): Promise<CommandOutcome> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const now = input.now ?? Date.now
  const deadline = input.deadline ?? now() + input.timeoutMs
  const routePath = operationPath(input.transport.wire, input.operationId)

  while (now() < deadline) {
    if (input.signal?.aborted) break
    await sleep(Math.min(WAIT_POLL_INTERVAL_MS, Math.max(0, deadline - now())))
    if (input.signal?.aborted || now() >= deadline) break
    const outcome = await input.transport.request("GET", routePath, undefined, {
      timeoutMs: Math.max(1, Math.min(input.timeoutMs, deadline - now())),
      signal: input.signal,
    })
    if (!outcome.ok) return outcome
    // The route answers the Operation document (ADR-0175 B3): branch on
    // `done`, then on `error`.
    if (
      !outcome.result ||
      typeof outcome.result !== "object" ||
      typeof (outcome.result as { done?: unknown }).done !== "boolean"
    )
      return { ok: false, cause: "failed", message: "host returned an invalid operation" }
    const operation = outcome.result as Record<string, unknown> & { done: boolean }
    const status = typeof operation.status === "string" ? operation.status : undefined
    if (!operation.done) continue
    const error = operation.error
    if (error !== undefined && error !== null) {
      const detail =
        typeof error === "string"
          ? error
          : typeof error === "object" && typeof (error as { detail?: unknown }).detail === "string"
            ? (error as { detail: string }).detail
            : undefined
      return {
        ...failureFromResponse(
          typeof (error as { status?: unknown }).status === "number"
            ? (error as { status: number }).status
            : 500,
          error
        ),
        message: detail ?? `operation ${input.operationId} failed`,
      }
    }
    if (status === "cancelled")
      return {
        ok: false,
        cause: "failed",
        code: "operation_cancelled",
        operationId: input.operationId,
        message: `operation ${input.operationId} was cancelled`,
      }
    if (status === "failed" || status === "error") {
      return { ok: false, cause: "failed", message: `operation ${input.operationId} failed` }
    }
    return { ok: true, result: Object.hasOwn(operation, "result") ? operation.result : operation }
  }

  return {
    ok: false,
    cause: "timeout",
    message: `operation ${input.operationId} was still running when --timeout elapsed`,
  }
}
