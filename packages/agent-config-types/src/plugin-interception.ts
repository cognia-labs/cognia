/** Shared terminal identity across the renderer, capture runner and Sidecar. */
export const PLUGIN_INTERCEPTOR_REFUSED = "PLUGIN_INTERCEPTOR_REFUSED" as const

export function isPluginInterceptorRefusal(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const value = error as { code?: unknown; name?: unknown }
  return (
    value.code === PLUGIN_INTERCEPTOR_REFUSED ||
    value.code === "policy_refused" ||
    value.name === "InterceptorGuardDeniedError" ||
    value.name === "InterceptorFailClosedError"
  )
}
