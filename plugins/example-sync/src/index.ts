import {
  definePlugin,
  definePluginManifest,
  defineSyncDriver,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"

export const manifest = definePluginManifest(manifestJson)
interface Item {
  id: string
  title: string
  sourceRemoved?: boolean
}

/** Fictional paginated remote. Replace this function with a granted integration request. */
export async function fetchRemote(input: { mode: string; page?: string; signal: AbortSignal }) {
  input.signal.throwIfAborted()
  if (input.mode === "incremental") return { items: [], cursor: "demo-v1" }
  return input.page === "second"
    ? { items: [{ id: "two", title: "Second item" }], cursor: "demo-v1" }
    : { items: [{ id: "one", title: "First item" }], nextPage: "second" }
}

export default definePlugin({
  manifest,
  activate(ctx: PluginContext) {
    const registration = ctx.sync.register(
      "demo",
      defineSyncDriver<Item>({
        itemId: (item) => item.id,
        fetchPage: fetchRemote,
        async applyPage({ items }, { signal }) {
          const known = (await ctx.storage.get<Record<string, Item>>("mirror")) ?? {}
          signal.throwIfAborted()
          for (const item of items) known[item.id] = item
          await ctx.storage.set("mirror", known)
        },
        async listKnownIds(signal) {
          const known = (await ctx.storage.get<Record<string, Item>>("mirror")) ?? {}
          signal.throwIfAborted()
          return Object.values(known)
            .filter((item) => !item.sourceRemoved)
            .map((item) => item.id)
        },
        async tombstone(ids, { signal }) {
          const known = (await ctx.storage.get<Record<string, Item>>("mirror")) ?? {}
          signal.throwIfAborted()
          for (const id of ids) if (known[id]) known[id].sourceRemoved = true
          await ctx.storage.set("mirror", known)
        },
      }),
      {} // Real services bind { connectionRef } here, before any run or request.
    )
    ctx.lifecycle.onDispose(registration.dispose, "example-sync:demo")
    ctx.sync.request("demo", { reason: "poll" })
  },
})
