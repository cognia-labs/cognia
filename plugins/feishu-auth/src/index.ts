import { definePlugin, definePluginManifest, type PluginContext } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { createFeishuAuthProvider } from "./oauth"

export const manifest = definePluginManifest(manifestJson)

export default definePlugin({
  manifest,
  activate(ctx: PluginContext) {
    ctx.lifecycle.onDispose(
      ctx.auth.registerProvider(createFeishuAuthProvider(ctx)),
      "feishu-auth:provider"
    )
  },
})
