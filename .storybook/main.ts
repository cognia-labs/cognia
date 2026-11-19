import path from "node:path"
import type { StorybookConfig } from "@storybook/nextjs"
import { keepModuleIndexOnServer } from "./server-channel.ts"
import qualityStories from "./quality-stories.json" with { type: "json" }

// A named, explicit PR build selection. Normal dev/build always retains the
// entire component catalog; the quality suite rejects missing/empty entries.
export function storybookStories(quality: boolean): string[] {
  return quality
    ? [path.resolve(".storybook/overview.mdx"), ...qualityStories.map((file) => path.resolve(file))]
    : ["./*.mdx", "../components/**/*.stories.@(tsx|ts)"]
}

// Storybook runs on the WEBPACK framework (`@storybook/nextjs`) — the same
// bundler as the real Next app — not the Vite/rolldown framework. Rationale:
// rolldown evaluates several transitive deps' module-init out of order when the
// heavy chat graph is bundled into one story chunk ("createRegistry /
// createSelectorCreator is not defined" from tokenlens/reselect/plugin
// registries), which blocks full-page stories like ChatPane. Webpack resolves
// those exactly like `pnpm build` does, so no per-dep stubbing is needed.
//
// The webpack framework reads next.config.ts's basics but NOT its custom
// `webpack()` resolve customizations, so we mirror the browser aliases:
// Node-only built-ins → false, the pixi single-file collapse, and the shared
// Monaco runtime. Story-specific mocks isolate follow-ups and the chat runtime.

const NODE_ONLY_MODULES = [
  "dns",
  "node:dns",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "fs",
  "node:fs",
  "fs/promises",
  "node:fs/promises",
  "child_process",
  "node:child_process",
  "http2",
  "node:http2",
  "stream/promises",
  "node:stream/promises",
  "events",
  "node:events",
  // --- Built-ins the sidecar's own dependency tree reaches for --------------
  //
  // `lib/mcp/transport.ts` dynamically imports `sidecar/mcp-oauth-helper.mjs`
  // (a Node-only helper that only ever executes on the desktop/Tauri path),
  // which statically imports `undici` and lazily imports
  // `@modelcontextprotocol/sdk/client/*`. Because the importer physically
  // lives in `sidecar/` — a separate Node project with its own lockfile, NOT a
  // pnpm workspace member — webpack resolves those from `sidecar/node_modules`
  // and pulls undici 8.10.x (not the root's 7.x) into the preview graph. Same
  // shape as the `lib/auth-providers/feishu/cli/exec-lark-cli` case next.config.ts
  // documents: statically reachable, never evaluated in a WebView, so it gets
  // stubbed rather than restructured.
  //
  // `pnpm build` never needs these because next.config.ts also installs a
  // `NormalModuleReplacementPlugin(/^node:/)` that rewrites the WHOLE request
  // to the empty stub. @storybook/nextjs installs its own `/^node:/` plugin
  // that merely STRIPS the scheme and hands the rest to
  // node-polyfill-webpack-plugin, so `require('node:sqlite')` arrives here as
  // a bare `sqlite` that nothing can resolve.
  //
  // Only add names node-polyfill-webpack-plugin does NOT already cover. It
  // merges as `{ ...its polyfills, ...ourFallback }`, so anything listed here
  // SHADOWS the real polyfill — stubbing e.g. `util` or `buffer` would swap a
  // working browser implementation for an empty module. The plugin covers
  // assert, buffer, console, constants, crypto, domain, events, http, https,
  // os, path, punycode, process, querystring, stream, string_decoder, sys,
  // timers, tty, url, util, vm and zlib; the subpaths and newer built-ins
  // below are the gaps.
  "async_hooks",
  "node:async_hooks",
  "diagnostics_channel",
  "node:diagnostics_channel",
  "perf_hooks",
  "node:perf_hooks",
  "readline",
  "node:readline",
  "sqlite",
  "node:sqlite",
  "worker_threads",
  "node:worker_threads",
  // silk-wasm's ESM entry imports createRequire behind its Node environment
  // guard. Webpack must still resolve that chunk in browser previews, just as
  // next.config.ts does; the guarded Node branch is never run in the iframe.
  "module",
  "node:module",
]

// Built-in SUBPATHS from the same sidecar graph. These cannot live in
// `resolve.fallback` alongside the names above: fallback entries are matched
// like aliases (`key` also matches `key/anything`), the polyfill plugin merges
// as `{ ...its polyfills, ...ourFallback }`, and webpack takes the FIRST
// matching entry. So its `stream` → stream-browserify wins over our
// `stream/web` and rewrites the request to `stream-browserify/index.js/web`,
// which resolves to nothing. `resolve.alias` is consulted BEFORE normal
// resolution and is a list we own outright, so the subpath wins there.
// (The pre-existing `stream/promises` / `fs/promises` fallback entries have
// the same shadowing problem; `fs/promises` happens to work anyway because
// Storybook's own `fs: false` fallback swallows it, and nothing in the preview
// graph requests `stream/promises`.)
const NODE_ONLY_SUBPATHS = ["util/types", "node:util/types", "stream/web", "node:stream/web"]

// Optional server-only deps loaded via `import(/* webpackIgnore */ "pkg")`.
const OPTIONAL_SERVER_PACKAGES = ["langfuse"]

const PIXI_PREBUNDLED_ABS = path.resolve(process.cwd(), "node_modules/pixi.js/dist/pixi.mjs")
const FOLLOW_UPS_MOCK = path.resolve(process.cwd(), "hooks/chat/use-follow-up-suggestions.mock.ts")
const CHAT_PANE_RUNTIME_MOCK = path.resolve(
  process.cwd(),
  ".storybook/mocks/use-chat-pane-runtime.ts"
)
// Next's SWC path transform may hand webpack an absolute request before
// enhanced-resolve sees aliases. Cover raw and transformed imports alike.
const STORY_RUNTIME_MOCKS = new Map(
  [
    ["hooks/chat/use-follow-up-suggestions", FOLLOW_UPS_MOCK],
    ["hooks/chat/use-chat-pane-runtime", CHAT_PANE_RUNTIME_MOCK],
  ].flatMap(([request, mock]) =>
    [
      `@/${request}`,
      path.resolve(process.cwd(), request!),
      `${path.resolve(process.cwd(), request!)}.ts`,
    ].map((specifier) => [specifier, mock!] as const)
  )
)

// `@storybook/nextjs` 10.6's App Router mock predates Next 16.4's
// `LayoutRouterContext.parentRenderTree`, so `useRouter()` in the framework's
// own RedirectBoundary crashes every story. Its imports of the router-context
// module are redirected to a shim that fills the field in; see the shim.
const APP_ROUTER_CONTEXT_REQUEST =
  /^next\/dist\/shared\/lib\/app-router-context\.shared-runtime(\.js)?$/
const STORYBOOK_NEXTJS_DIST = /[\\/]@storybook[\\/]nextjs[\\/]dist[\\/]/
const LAYOUT_ROUTER_CONTEXT_SHIM = path.resolve(
  process.cwd(),
  ".storybook/next-layout-router-context.tsx"
)

const config: StorybookConfig & {
  experimental_serverChannel: typeof keepModuleIndexOnServer
} = {
  experimental_serverChannel: keepModuleIndexOnServer,
  framework: {
    name: "@storybook/nextjs",
    options: {
      builder: {
        // Persistent webpack cache in node_modules/.cache/webpack — turns the
        // ~50s cold compile into a warm-start of a few seconds.
        fsCache: true,
        // Compile stories on demand (dev only). With 1200+ story files the
        // eager preview bundle pulls in effectively the whole app; lazy
        // compilation makes startup compile just the preview shell and pays
        // for each story the first time it is opened.
        lazyCompilation: true,
      },
    },
  },
  // addon-mcp serves the local Storybook AI MCP at http://localhost:6006/mcp
  // while `pnpm storybook` is running (registered in .mcp.json).
  addons: ["@storybook/addon-docs", "@storybook/addon-mcp"],
  // Contributor docs plus co-located component previews (not app/hooks/lib).
  stories: storybookStories(process.env.STORYBOOK_QUALITY === "1"),
  // Serve `public/` at the root like Next does, so stories that reference
  // static assets by absolute path (`/icons/icon-512.png` in the mobile boot
  // screen, brand marks, fixtures) render them instead of a broken image.
  staticDirs: ["../public", { from: "../node_modules/geist/dist/fonts", to: "/fonts/geist" }],
  // react-docgen recurses infinitely on some store modules pulled into the
  // graph (e.g. lib/platform/viewport-store.ts); preview doesn't need prop tables.
  typescript: { reactDocgen: false },
  webpackFinal: async (cfg, options) => {
    // Standalone previews do not need multi-GB production source maps. Dev
    // retains the framework's debugging setup; minification stays enabled.
    if (options?.configType === "PRODUCTION") {
      cfg.devtool = false
      // Static builds run once per CI job. Keeping their entire app graph for
      // serialization adds heap/disk pressure, and parallel selections must
      // never read/write the same persistent cache. Dev keeps fsCache above.
      cfg.cache = false
    }
    // PR assertions exercise the real render/play graph without paying for
    // minification of the transitive app runtime. Normal full builds still
    // test production minification in their separate CI lane.
    if (process.env.STORYBOOK_QUALITY === "1") {
      cfg.optimization = { ...cfg.optimization, minimize: false }
    }
    // The default JS minifier exhausts a 10 GiB heap on the full graph. Reuse
    // the framework's installed native SWC minifier with one bounded worker.
    for (const minimizer of cfg.optimization?.minimizer ?? []) {
      const plugin = minimizer as {
        constructor?: { name?: string; swcMinify?: unknown }
        options?: {
          parallel?: boolean | number
          minimizer?: { implementation?: unknown; options: Record<string, unknown> }
        }
      }
      const parallel = plugin?.options?.parallel
      if (
        plugin?.constructor?.name === "TerserPlugin" &&
        plugin.options &&
        (parallel === true || (typeof parallel === "number" && parallel > 1))
      ) {
        plugin.options.parallel = 1
      }
      if (plugin?.constructor?.name === "TerserPlugin" && plugin.options?.minimizer) {
        if (typeof plugin.constructor.swcMinify !== "function") {
          throw new Error("Unsupported Storybook minifier: review the SWC compatibility setup")
        }
        plugin.options.minimizer.implementation = plugin.constructor.swcMinify
        plugin.options.minimizer.options = {
          ...plugin.options.minimizer.options,
          compress: true,
          // Storybook injects an ESM mocker runtime with import.meta/export.
          // SWC parses it strictly; all webpack assets can use module parsing.
          module: true,
        }
      }
    }
    // `storybook dev` crashes in webpack's watcher after a compile:
    // `FileSystemInfo._resolveContextTimestamp` hashes a snapshotted directory
    // (context) whose nested-symlink entry resolves to an `undefined`
    // timestampHash, throwing "Cannot read properties of undefined (reading
    // 'length')" (webpack-5 bug aggravated by pnpm symlinks, see
    // webpack/discussions#17373). The offending contexts are the pnpm
    // *workspace package* directories (`packages/*`, `mobile`, `docs`,
    // `plugin-sdk/*`) that `resolve.symlinks` realpaths out of node_modules,
    // so ignoring node_modules alone only fixed the first-compile crash — the
    // first *re*build still died. Fix: watch-ignore every directory Storybook
    // doesn't serve stories from (anchored at the repo root so e.g.
    // `components/mobile/` stays watched). Tradeoff: edits under packages/*
    // need a Storybook restart to show up.
    const IGNORED_ROOT_DIRS = [
      "node_modules",
      "packages",
      "mobile",
      "docs",
      "plugin-sdk",
      "sidecar",
      "services",
      "src-tauri",
      "cli",
      "out",
      "\\.next",
      "\\.git",
    ]
    const escapedRoot = process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    cfg.watchOptions = {
      ...(cfg.watchOptions ?? {}),
      ignored: new RegExp(
        `(^${escapedRoot}[\\\\/](${IGNORED_ROOT_DIRS.join("|")})[\\\\/])|([\\\\/]node_modules[\\\\/])`
      ),
    }

    // Disable React Fast Refresh. Its `registerExportsForReactRefresh` eagerly
    // reads each module's default export during init; a benign circular import
    // in the chat graph (`stores/artifact` ↔ `lib/plugin/messaging/hooks-system`)
    // then throws "Cannot access '__WEBPACK_DEFAULT_EXPORT__' before
    // initialization" — DEV ONLY (the production `storybook build` has no refresh
    // and renders fine). We trade HMR for a full reload on edit, which Storybook
    // handles cleanly. Strip both halves: the runtime plugin and the loaders'
    // refresh injection (else `$RefreshReg$` is undefined).
    cfg.plugins = (cfg.plugins ?? []).filter(
      (p) =>
        !/ReactRefresh/.test((p as { constructor?: { name?: string } })?.constructor?.name ?? "")
    )
    const stripRefresh = (use: unknown) => {
      for (const u of Array.isArray(use) ? use : [use]) {
        const opts = (u as { options?: Record<string, unknown> })?.options
        if (opts && typeof opts === "object") {
          if ("hasReactRefresh" in opts) opts.hasReactRefresh = false
          if (Array.isArray(opts.plugins)) {
            opts.plugins = opts.plugins.filter(
              (pl) => !String(Array.isArray(pl) ? pl[0] : pl).includes("react-refresh")
            )
          }
        }
      }
    }
    const walkRules = (rules: unknown[] | undefined) => {
      for (const r of rules ?? []) {
        const rule = r as { use?: unknown; exclude?: unknown; oneOf?: unknown[]; rules?: unknown[] }
        if (!rule || typeof rule !== "object") continue
        if (rule.use) stripRefresh(rule.use)
        for (const use of Array.isArray(rule.use) ? rule.use : [rule.use]) {
          const loader = use as
            | {
                loader?: string
                options?: { nextConfig?: { transpilePackages?: string[] } }
              }
            | undefined
          const packages = loader?.options?.nextConfig?.transpilePackages
          if (
            loader?.loader === "@storybook/nextjs/next-swc-loader-patch" &&
            packages?.length &&
            rule.exclude
          ) {
            // Storybook 10.6's node_modules exclusion also matches the outer
            // node_modules/.pnpm/ directory, skipping Next's transpilePackages.
            // Opt those packages back into the existing SWC rule, preserving
            // compiler options and all other exclusions. Use the LAST
            // node_modules segment so their unlisted dependencies stay excluded.
            rule.exclude = {
              and: [rule.exclude],
              not: (resource: string) => {
                const packagePath = resource.replace(/\\/g, "/").split("/node_modules/").pop()
                return packages.some((name) => packagePath?.startsWith(`${name}/`))
              },
            }
          }
        }
        if (rule.oneOf) walkRules(rule.oneOf)
        if (rule.rules) walkRules(rule.rules)
      }
    }
    walkRules(cfg.module?.rules as unknown[] | undefined)

    // Swap the framework's router-context import for the shim. This runs in
    // `beforeResolve`, on the raw request, because the framework also aliases
    // bare `next` to an absolute directory — a `resolve.alias` keyed on the
    // specifier would never see it again after that rewrite. Scoped by issuer
    // so the shim's own import (and every app import) gets Next's real module.
    cfg.plugins.push({
      apply(compiler) {
        compiler.hooks.normalModuleFactory.tap("CogniaLayoutRouterContextShim", (factory) => {
          factory.hooks.beforeResolve.tap("CogniaLayoutRouterContextShim", (data) => {
            const runtimeMock = STORY_RUNTIME_MOCKS.get(data.request)
            if (runtimeMock) data.request = runtimeMock
            if (
              APP_ROUTER_CONTEXT_REQUEST.test(data.request) &&
              STORYBOOK_NEXTJS_DIST.test(data.contextInfo.issuer ?? "")
            ) {
              data.request = LAYOUT_ROUTER_CONTEXT_SHIM
            }
          })
        })
      },
    })

    // Memory/disk bounds for the fsCache enabled above. Without these the
    // filesystem cache is unbounded in both directions: the on-disk pack
    // (node_modules/.cache/webpack) grows past 10 GB because entries default
    // to a 60-day maxAge with no compression, and the dev process RSS creeps
    // toward the heap ceiling because deserialized cache entries stay in the
    // in-memory cache for 5 idle compilations (webpack's dev default) and
    // serialization buffers are never released.
    if (cfg.cache && typeof cfg.cache === "object" && cfg.cache.type === "filesystem") {
      cfg.cache.compression = "gzip"
      cfg.cache.maxAge = 7 * 24 * 60 * 60 * 1000
      cfg.cache.allowCollectingMemory = true
      if (cfg.mode === "development") cfg.cache.maxMemoryGenerations = 1
    }

    cfg.resolve ??= {}
    // Mirror of next.config.ts:181 — Node built-ins resolve to `false` in the
    // browser bundle so any transitive dep that imports them doesn't blow up.
    cfg.resolve.fallback = {
      ...(cfg.resolve.fallback ?? {}),
      ...Object.fromEntries(
        [...NODE_ONLY_MODULES, ...OPTIONAL_SERVER_PACKAGES].map((m) => [m, false])
      ),
    }
    cfg.resolve.alias = {
      // Specific mocks must precede Next's broad `@` alias: enhanced-resolve
      // uses the first match, otherwise the real controller wins silently.
      "@/hooks/chat/use-follow-up-suggestions$": FOLLOW_UPS_MOCK,
      "@/hooks/chat/use-chat-pane-runtime$": CHAT_PANE_RUNTIME_MOCK,
      ...(cfg.resolve.alias ?? {}),
      // Built-in subpaths — alias, not fallback (see NODE_ONLY_SUBPATHS).
      ...Object.fromEntries(NODE_ONLY_SUBPATHS.map((m) => [m, false])),
      // Mirror of next.config.ts:188 — collapse pixi to its single-file dist.
      "pixi.js$": PIXI_PREBUNDLED_ABS,
      // y-monaco's legacy deep import conflicts with Monaco's exports map.
      // Reuse the app's adapter to the loaded editor, avoiding a second instance.
      "monaco-editor/esm/vs/editor/editor.api.js$": path.resolve(
        process.cwd(),
        "lib/browser-stubs/monaco-editor-api.ts"
      ),
      // Replace the LLM-backed follow-ups hook with a controllable mock so the
      // follow-up-suggestions story never calls a model.
    }
    return cfg
  },
}

export default config
