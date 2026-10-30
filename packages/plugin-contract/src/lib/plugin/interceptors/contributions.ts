/**
 * Reading `activate()`'s return value.
 *
 * Extracted from the plugin manager rather than left inline there: the split
 * and the per-contribution validation are pure decisions about a returned
 * object, and inside a 7000-line lifecycle class they were only reachable
 * through a full activation with its whole mock scaffold. Here they are three
 * functions with a co-located test, and the manager calls one of them.
 */

import { loggers } from "../core/logger"
import type { PluginHooks } from "../../../types/plugin"
import type { PluginInterceptorContribution } from "../../../types/plugin/plugin-interceptors"
import { getInterceptorPoint, isInterceptorPointLive } from "./points"
import { createInterceptorRegistration } from "./normalize"
import {
  registerInterceptor,
  unregisterInterceptorGeneration,
  unregisterInterceptorsForPluginSource,
} from "./registry"

export interface ActivationContributions {
  interceptors: PluginInterceptorContribution[]
  /** The historical hook bag, or undefined when the result carried only interceptors. */
  hookBag: PluginHooks | undefined
}

/**
 * Separate a `defineInterceptors` result from the historical hook bag.
 *
 * `activate()` has always returned "the hooks"; interceptors arrive on the same
 * return value under a reserved `interceptors` key. Reserving the key rather
 * than adding a second return channel means a plugin can adopt interceptors one
 * at a time instead of rewriting its activation.
 */
export function splitActivationContributions(result: PluginHooks): ActivationContributions {
  const candidate = result as PluginHooks & {
    interceptors?: readonly PluginInterceptorContribution[]
  }
  const interceptors = Array.isArray(candidate.interceptors) ? [...candidate.interceptors] : []
  const rest = { ...candidate } as Record<string, unknown>
  delete rest.interceptors
  const hookBag = Object.keys(rest).length > 0 ? (rest as PluginHooks) : undefined
  return { interceptors, hookBag }
}

export type ContributionRejection =
  "unknown-point" | "semantic-mismatch" | "handler-not-a-function" | "permission-denied"

export interface ContributionOutcome {
  registered: number
  rejected: Array<{ point: string; reason: ContributionRejection }>
  /** Declared on an unavailable point and excluded from executable registrations. */
  dormant: string[]
}

/**
 * Register the interceptors a plugin declared from `activate()`.
 *
 * A bad contribution is refused loudly rather than coerced: a silently dropped
 * interceptor looks exactly like one that ran and did nothing, which is the
 * hardest plugin bug to report. A contribution on a `virtual` point is reported
 * as dormant and excluded from the executable registry.
 */
export function registerDeclaredInterceptors(
  pluginId: string,
  contributions: readonly PluginInterceptorContribution[],
  options: { generation?: number; hasPermission?: (permission: string) => boolean } = {}
): ContributionOutcome {
  const outcome: ContributionOutcome = { registered: 0, rejected: [], dormant: [] }

  unregisterInterceptorsForPluginSource(pluginId, "interceptors")
  // Anything left from a superseded activation goes too, whatever surface it
  // came through: a disposer that never fired would otherwise leave a dead
  // generation's closure on a live chain.
  if (options.generation !== undefined) {
    unregisterInterceptorGeneration(pluginId, options.generation)
  }

  for (const contribution of contributions) {
    const point = getInterceptorPoint(contribution.point)
    if (!point) {
      loggers.hooks.error(
        `[interceptors] plugin ${pluginId} named unknown point "${contribution.point}"`
      )
      outcome.rejected.push({ point: contribution.point, reason: "unknown-point" })
      continue
    }
    if (contribution.semantic && contribution.semantic !== point.semantic) {
      loggers.hooks.error(
        `[interceptors] plugin ${pluginId} declared "${contribution.semantic}" on ` +
          `"${contribution.point}", which is a "${point.semantic}" point`
      )
      outcome.rejected.push({ point: contribution.point, reason: "semantic-mismatch" })
      continue
    }
    if (typeof contribution.handler !== "function") {
      loggers.hooks.error(
        `[interceptors] plugin ${pluginId} contributed a non-function handler on ` +
          `"${contribution.point}"`
      )
      outcome.rejected.push({ point: contribution.point, reason: "handler-not-a-function" })
      continue
    }
    if (!isInterceptorPointLive(contribution.point)) {
      loggers.hooks.warn(
        `[interceptors] plugin ${pluginId} declared unavailable point "${contribution.point}". ` +
          `The handler was not registered because the host has no consumer.`
      )
      outcome.dormant.push(contribution.point)
      continue
    }

    if (point.permission && !options.hasPermission?.(point.permission)) {
      loggers.hooks.error(
        `[interceptors] plugin ${pluginId} requires ${point.permission} for ${contribution.point}`
      )
      outcome.rejected.push({ point: contribution.point, reason: "permission-denied" })
      continue
    }

    registerInterceptor(
      createInterceptorRegistration({
        pluginId,
        pointId: contribution.point,
        semantic: point.semantic,
        handler: ((...args: unknown[]) => {
          const check = () => {
            if (point.permission && !options.hasPermission?.(point.permission))
              throw new Error(`Interceptor permission revoked: ${point.permission}`)
          }
          check()
          const produced = (contribution.handler as (...values: unknown[]) => unknown)(...args)
          return Promise.resolve(produced).then((value) => {
            check()
            return value
          })
        }) as never,
        order: {
          ...(contribution.before ? { before: contribution.before } : {}),
          ...(contribution.after ? { after: contribution.after } : {}),
          ...(contribution.priority !== undefined ? { priority: contribution.priority } : {}),
        },
        ...(contribution.timeoutMs !== undefined ? { timeoutMs: contribution.timeoutMs } : {}),
        ...(contribution.failurePolicy ? { failurePolicy: contribution.failurePolicy } : {}),
        source: "interceptors",
        ...(contribution.id
          ? { registrationId: `${pluginId}:${contribution.point}:${contribution.id}` }
          : {}),
      })
    )
    outcome.registered += 1
  }
  return outcome
}
