import { subscribeNodeRegistry } from "@/lib/workflow/nodes/registry"
import { subscribePluginTriggerRegistry } from "@/lib/workflow/triggers/registry"
import { getPluginEventHooks } from "./hooks-system"

/** Keep standalone registries independent of the host that consumes their events. */
export function installWorkflowRegistryHookSource(): () => void {
  const stopNodes = subscribeNodeRegistry((event) => {
    const hooks = getPluginEventHooks()
    const { type, ...metadata } = event
    if (type === "register") void hooks.dispatchWorkflowNodeRegister(metadata)
    else void hooks.dispatchWorkflowNodeUnregister(metadata)
  })
  const stopTriggers = subscribePluginTriggerRegistry((event) => {
    const hooks = getPluginEventHooks()
    const { type, ...metadata } = event
    if (type === "register") void hooks.dispatchWorkflowTriggerRegister(metadata)
    else if (type === "unregister") void hooks.dispatchWorkflowTriggerUnregister(metadata)
  })
  return () => {
    stopTriggers()
    stopNodes()
  }
}
