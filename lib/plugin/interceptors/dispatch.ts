/**
 * Moved to `@cognia/plugin-contract`, which owns the plugin contract.
 * This re-export keeps host imports of `@/lib/plugin/interceptors/dispatch` working.
 */
export * from "@cognia/plugin-contract/lib/plugin/interceptors/dispatch"

import * as portable from "@cognia/plugin-contract/lib/plugin/interceptors/dispatch"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import { HOST_BACKGROUND, withPluginExecutionContext } from "../core/invocation-identity"

export interface InterceptorDispatchContext extends portable.InterceptorDispatchContext {
  /** Host operation identity, never a plugin payload field. */
  credentialContext?: PersonalCredentialContext
}
export interface TransformDispatchOptions<T> extends portable.TransformDispatchOptions<T> {
  credentialContext?: PersonalCredentialContext
}
function bound(context: InterceptorDispatchContext): portable.InterceptorDispatchContext {
  const execution = context.credentialContext ?? HOST_BACKGROUND
  return {
    ...context,
    invokeHandler: (registration, invoke) =>
      withPluginExecutionContext(registration.pluginId, execution, async () => invoke()),
  }
}
export function dispatchObserve<T>(
  pointId: string,
  payload: T,
  context: InterceptorDispatchContext
) {
  return portable.dispatchObserve(pointId, payload, bound(context))
}
export function dispatchTransform<T>(
  pointId: string,
  value: T,
  context: TransformDispatchOptions<T>
) {
  return portable.dispatchTransform(pointId, value, { ...context, ...bound(context) })
}
export function dispatchGuard<T>(
  pointId: string,
  payload: T,
  context: InterceptorDispatchContext & { collectApprovals?: boolean }
) {
  return portable.dispatchGuard(pointId, payload, { ...context, ...bound(context) })
}
export function requireGuardPass<T>(
  pointId: string,
  payload: T,
  context: InterceptorDispatchContext
) {
  return portable.requireGuardPass(pointId, payload, bound(context))
}
export function dispatchAround<T, R>(
  pointId: string,
  input: T,
  terminal: (value: T) => Promise<R>,
  context: InterceptorDispatchContext
) {
  return portable.dispatchAround(pointId, input, terminal, bound(context))
}
