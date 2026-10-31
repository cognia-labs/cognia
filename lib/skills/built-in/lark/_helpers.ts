/**
 * Shared helpers for Lark skill families (ADR-0026).
 *
 * Each skill file in this directory uses these helpers to:
 *   1. Compose `execLarkCli` argv from validated args without spaghetti.
 *   2. Build the standard A2UI confirm card for HITL writes/destructives.
 *   3. Surface a uniform error envelope when lark-cli fails.
 *
 * Skill bodies stay focused on the lark-cli argv shape; the trust gate
 * lives in `dispatcher.ts`.
 */

import { z } from "zod"
import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill, BuiltInSkillContext } from "../types"
import { resolveLarkAdapter } from "./auth-bridge"
import { execLarkCli, type ExecLarkCliInput, type LarkCliResult } from "./exec-lark-cli"
import { assertLarkCliCommandAvailable } from "./capabilities"

// The confirm card moved to the shared tier when the platform-neutral `im.*`
// family landed (W2) — re-exported here so every lark skill file keeps its
// original import path.
export { buildConfirmSurface } from "../_shared/confirm-surface"

/**
 * Resolve the Lark adapter a skill invocation should authenticate as.
 * An explicit tool selection is carried separately from the IM binding.
 * The auth bridge validates it against the authoritative session binding;
 * choosing an account never grants permission to redirect an IM invocation.
 */
export function larkAdapterIdFromCtx(ctx: BuiltInSkillContext): string | undefined {
  return (
    ctx.larkAdapterId ?? (ctx.imBinding?.platform === "lark" ? ctx.imBinding.adapterId : undefined)
  )
}

/**
 * Add account routing once for every Lark skill. safeExtend retains the
 * original object's strictness and refinements. Routing stays in validated
 * args for confirmation replay, but never reaches the CLI argument builder.
 */
export function registerLarkSkill<S extends z.ZodObject>(skill: BuiltInSkill<S>): void {
  const accountLabels = new WeakMap<object, string>()
  const schema = skill.inputSchema.safeExtend({
    adapterId: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Lark connection id from im_list_connections. Select it explicitly when multiple Lark accounts are enabled. An IM session may only use its own connection."
      ),
  })
  const splitRoute = (args: z.infer<typeof schema>) => {
    const { adapterId, ...body } = args
    // Generic safeExtend erases the added field's output type; the schema
    // above still validates it before the dispatcher invokes these hooks.
    return { adapterId: adapterId as string | undefined, body: body as z.infer<S> }
  }
  const routedContext = (ctx: BuiltInSkillContext, adapterId: string | undefined) => ({
    ...ctx,
    ...(adapterId ? { larkAdapterId: adapterId } : {}),
  })

  const routedSkill: BuiltInSkill<typeof schema> = {
    ...skill,
    inputSchema: schema,
    execute: (args, ctx) => {
      const { adapterId, body } = splitRoute(args)
      return skill.execute(body, routedContext(ctx, adapterId))
    },
    preflight: async (args, ctx) => {
      const selected = await resolveLarkAdapter({
        adapterId: splitRoute(args).adapterId,
        context: ctx,
      })
      if (!selected.ok) throw new Error(selected.message)
      // The dispatcher persists this same validated object for HITL replay.
      // Pin even a sole/default account before approval so later connection
      // changes cannot silently redirect an already-approved operation.
      args.adapterId = selected.adapter.id
      accountLabels.set(args, selected.adapter.displayName || selected.adapter.id)
      const { body } = splitRoute(args)
      await skill.preflight?.(body, routedContext(ctx, selected.adapter.id))
      Object.assign(args, body)
      args.adapterId = selected.adapter.id
    },
    hitlSurface: skill.hitlSurface
      ? (args: z.infer<typeof schema>) => {
          const { adapterId, body } = splitRoute(args)
          const surface = skill.hitlSurface!(body)
          if (!adapterId) return surface
          const accountRowId = `${surface.rootId}_lark_account`
          const label = accountLabels.get(args)
          const text = `**Lark connection**: ${label && label !== adapterId ? `${label} (${adapterId})` : adapterId}`
          const card = surface.components[surface.rootId] as {
            children: string[]
          }
          return {
            ...surface,
            components: {
              ...surface.components,
              [accountRowId]: { component: "Text", text, props: { text } },
              [surface.rootId]: {
                ...card,
                children: [accountRowId, ...card.children],
              },
            },
          }
        }
      : undefined,
  }
  registerBuiltInSkill(routedSkill)
}

/** Convert the camelCase Zod arg shape into kebab-case `--flag value`. */
export function argsToFlags(
  args: Record<string, unknown>,
  /** Skip these keys — e.g. internal hints, "confirmed". */
  skip: readonly string[] = []
): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (skip.includes(key)) continue
    if (value === undefined || value === null) continue
    const flag = `--${camelToKebab(key)}`
    if (typeof value === "boolean") {
      if (value) out.push(flag)
      continue
    }
    if (Array.isArray(value)) {
      // lark-cli convention: repeat the flag for each value.
      for (const v of value) {
        out.push(flag, String(v))
      }
      continue
    }
    if (typeof value === "object") {
      out.push(flag, JSON.stringify(value))
      continue
    }
    out.push(flag, String(value))
  }
  return out
}

function camelToKebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())
}

/**
 * Display cap on the lark-cli result handed back to the model. lark-cli
 * list/search responses (pageSize up to 500) can serialize to ~1 MB of JSON —
 * the process `maxBuffer` bounds what we READ, this bounds what the MODEL sees.
 * Mirrors the capture-vs-display split the sidecar built-in tools use.
 */
export const MAX_RESULT_DISPLAY_CHARS = 24_000

/**
 * Bound a lark-cli result for model display. Small results (the common case)
 * pass through UNCHANGED so structured consumers still get the parsed value;
 * an oversized result is replaced with a truncation envelope carrying a JSON
 * preview and a "narrow the query" hint. Pure + serialization-based so it's
 * cheap to test.
 */
export function capLarkData(data: unknown): unknown {
  if (typeof data === "string") {
    return data.length > MAX_RESULT_DISPLAY_CHARS
      ? `${data.slice(0, MAX_RESULT_DISPLAY_CHARS)}\n… (output truncated — narrow the query or lower pageSize)`
      : data
  }
  let json: string
  try {
    json = JSON.stringify(data)
  } catch {
    return data // non-serializable (cycles) — hand back untouched
  }
  if (json.length <= MAX_RESULT_DISPLAY_CHARS) return data
  return {
    truncated: true,
    note: `lark-cli returned ${json.length} chars; truncated to ${MAX_RESULT_DISPLAY_CHARS}. Narrow the query, lower pageSize, or request a specific record/id.`,
    preview: `${json.slice(0, MAX_RESULT_DISPLAY_CHARS)}…`,
  }
}

/**
 * Run lark-cli and normalise the result into the skill execute() return
 * shape. On any non-ok result, throws an Error whose message the
 * dispatcher captures in the audit row + bubbles back to the assistant
 * tool-call.
 */
export async function runLarkCli(input: ExecLarkCliInput): Promise<unknown> {
  await assertLarkCliCommandAvailable(input.args)
  const result = await execLarkCli(input)
  if (result.status === "ok") return capLarkData(result.data)
  throw new Error(formatExecError(result))
}

function formatExecError(result: Extract<LarkCliResult, { status: "error" }>): string {
  const tail = result.stderr ? ` — ${truncate(result.stderr, 200)}` : ""
  const code = result.exitCode !== undefined ? ` (exit ${result.exitCode})` : ""
  return `lark-cli ${result.reason}${code}: ${result.message}${tail}`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s
}
