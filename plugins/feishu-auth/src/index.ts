import { definePlugin, definePluginManifest, type PluginContext } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { createFeishuAuthProvider } from "./oauth"

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate(ctx: PluginContext) {
    const auth = createFeishuAuthProvider(ctx)
    const unregister = ctx.auth.registerProvider(auth.provider)
    ctx.lifecycle.onDispose(() => {
      auth.dispose()
      unregister()
    }, "feishu-auth:provider")
  },
})
