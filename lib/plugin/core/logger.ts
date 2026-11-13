/** Host-owned producer stamping around the portable logger contract. */
import { createPluginSystemLogger as createPortableLogger } from "@cognia/plugin-contract/lib/plugin/core/logger"
import {
  withLogEgressSource,
  captureLogEgressSource,
  mergeLogEgressSources,
} from "@cognia/logging/context"
import { pluginEgressContext } from "./invocation-identity"
import {
  personalLogEgressSource,
  installPersonalLogEgressPolicy,
} from "@/lib/execution/personal-egress"
export * from "@cognia/plugin-contract/lib/plugin/core/logger"

export function createPluginSystemLogger(
  ...args: Parameters<typeof createPortableLogger>
): ReturnType<typeof createPortableLogger> {
  const pluginId = args[0]
  installPersonalLogEgressPolicy()
  const wrap = (
    logger: ReturnType<typeof createPortableLogger>
  ): ReturnType<typeof createPortableLogger> =>
    new Proxy(logger, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver)
        if (typeof value !== "function") return value
        if (key === "child" || key === "withContext")
          return (...values: unknown[]) => wrap(Reflect.apply(value, target, values))
        return (...values: unknown[]) =>
          withLogEgressSource(
            mergeLogEgressSources(
              captureLogEgressSource(),
              personalLogEgressSource(pluginEgressContext(pluginId))
            ),
            () => Reflect.apply(value, target, values)
          )
      },
    })
  return wrap(createPortableLogger(...args))
}
