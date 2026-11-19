import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { runInNewContext } from "node:vm"

import config, { storybookStories } from "../../.storybook/main.ts"
import qualityStories from "../../.storybook/quality-stories.json" with { type: "json" }

const require = createRequire(import.meta.url)
const frameworkRequire = createRequire(require.resolve("@storybook/nextjs"))
const webpackRequire = createRequire(frameworkRequire.resolve("webpack"))
const builderRequire = createRequire(frameworkRequire.resolve("@storybook/builder-webpack5"))
const RuleSetCompiler = frameworkRequire("webpack/lib/rules/RuleSetCompiler")
const compiler = new RuleSetCompiler([])

test("Jest's Shiki asset adapters equal the real installed ESM theme data", async () => {
  for (const name of ["one-light", "one-dark-pro", "github-light-default", "github-dark-default"]) {
    const actual = (await import(`shiki/themes/${name}.mjs`)).default
    const adapted = require(`../../__mocks__/shiki-theme-${name}.js`)
    assert.deepEqual(adapted, actual)
    assert.ok(Object.isFrozen(adapted))
  }
})

test("runtime replacement catches SWC absolute imports before resolution", async () => {
  const cfg = await config.webpackFinal({})
  const listeners = []
  const compiler = {
    hooks: {
      normalModuleFactory: {
        tap(_name, apply) {
          apply({
            hooks: {
              beforeResolve: {
                tap(_name, listener) {
                  listeners.push(listener)
                },
              },
            },
          })
        },
      },
    },
  }
  for (const plugin of cfg.plugins) plugin.apply(compiler)
  for (const hook of ["use-chat-pane-runtime", "use-follow-up-suggestions"]) {
    for (const request of [
      `@/hooks/chat/${hook}`,
      path.resolve(`hooks/chat/${hook}`),
      path.resolve(`hooks/chat/${hook}.ts`),
    ]) {
      const data = {
        request,
        contextInfo: { issuer: path.resolve("components/chat/chat-view.tsx") },
      }
      for (const listener of listeners) listener(data)
      assert.equal(
        data.request,
        hook === "use-chat-pane-runtime"
          ? path.resolve(".storybook/mocks/use-chat-pane-runtime.ts")
          : path.resolve("hooks/chat/use-follow-up-suggestions.mock.ts")
      )
    }
  }
  const ordinary = { request: "@/lib/utils", contextInfo: {} }
  for (const listener of listeners) listener(ordinary)
  assert.equal(ordinary.request, "@/lib/utils")
})

test("chat runtime mocks win over the framework's broad app alias", async () => {
  const cfg = await config.webpackFinal({ resolve: { alias: { "@": process.cwd() } } })
  const resolveBrowser = webpackRequire("enhanced-resolve").create.sync({
    alias: cfg.resolve.alias,
    extensions: [".ts", ".tsx", ".js"],
  })
  assert.equal(
    resolveBrowser(process.cwd(), "@/hooks/chat/use-chat-pane-runtime"),
    path.resolve(".storybook/mocks/use-chat-pane-runtime.ts")
  )
  assert.equal(resolveBrowser(process.cwd(), "@/lib/utils"), path.resolve("lib/utils/index.ts"))
  assert.equal(
    resolveBrowser(process.cwd(), "@/hooks/chat/use-follow-up-suggestions"),
    path.resolve("hooks/chat/use-follow-up-suggestions.mock.ts")
  )
})

test("the installed native minifier preserves code behavior and extracted licenses", async () => {
  const TerserPlugin = builderRequire("terser-webpack-plugin")
  const minimizer = new TerserPlugin({ parallel: 8 })
  await config.webpackFinal(
    { optimization: { minimize: true, minimizer: [minimizer] } },
    { configType: "PRODUCTION" }
  )
  assert.equal(minimizer.options.minimizer.implementation, TerserPlugin.swcMinify)
  const source =
    "/*! fixture-license */ class Counter { #value = 40; next() { return this.#value + 2 } } globalThis.answer = new Counter().next();"
  const result = await minimizer.options.minimizer.implementation(
    { "fixture.js": source },
    undefined,
    minimizer.options.minimizer.options,
    minimizer.options.extractComments
  )
  assert.ok(result.code)
  const context = {}
  runInNewContext(result.code, context)
  assert.equal(context.answer, 42)
  assert.ok(result.extractedComments.some((comment) => comment.includes("fixture-license")))
  const esm = await minimizer.options.minimizer.implementation(
    { "mocker-runtime-injected.js": "export const owner = import.meta.url;" },
    undefined,
    minimizer.options.minimizer.options,
    minimizer.options.extractComments
  )
  assert.match(esm.code, /import\.meta\.url/)
  assert.match(esm.code, /export/)
})

test("Storybook indexes the contributor guide alongside co-located stories", () => {
  assert.ok(config.stories.includes("./*.mdx"))
  assert.ok(config.stories.includes("../components/**/*.stories.@(tsx|ts)"))
  assert.equal(config.framework.name, "@storybook/nextjs")
  assert.equal(config.typescript.reactDocgen, false)
})

test("quality builds are explicit and default discovery keeps the whole catalog", () => {
  assert.deepEqual(storybookStories(false), ["./*.mdx", "../components/**/*.stories.@(tsx|ts)"])
  assert.deepEqual(storybookStories(true), [
    path.resolve(".storybook/overview.mdx"),
    ...qualityStories.map((file) => path.resolve(file)),
  ])
  assert.ok(qualityStories.length > 0)
  assert.equal(new Set(qualityStories).size, qualityStories.length)
})

test("static minification remains enabled with a bounded worker pool", async () => {
  class TerserPlugin {
    static swcMinify = () => {}
    options = {
      parallel: 8,
      keepClassnames: true,
      minimizer: { options: { mangle: true, compress: { passes: 2 } } },
    }
  }
  const minimizer = new TerserPlugin()
  const other = { options: { parallel: 8 } }
  await config.webpackFinal({ optimization: { minimize: true, minimizer: [minimizer, other] } })
  assert.equal(minimizer.options.parallel, 1)
  assert.equal(minimizer.options.keepClassnames, true)
  assert.equal(minimizer.options.minimizer.options.compress, true)
  assert.equal(minimizer.options.minimizer.implementation, TerserPlugin.swcMinify)
  assert.equal(minimizer.options.minimizer.options.mangle, true)
  assert.equal(other.options.parallel, 8)
  const production = { devtool: "source-map" }
  await config.webpackFinal(production, { configType: "PRODUCTION" })
  assert.equal(production.devtool, false)
  assert.equal(production.cache, false)
  const development = { devtool: "eval-cheap-module-source-map" }
  await config.webpackFinal(development, { configType: "DEVELOPMENT" })
  assert.equal(development.devtool, "eval-cheap-module-source-map")
})

test("only the explicit quality build disables minification", async () => {
  const previous = process.env.STORYBOOK_QUALITY
  try {
    delete process.env.STORYBOOK_QUALITY
    const full = { optimization: { minimize: true } }
    await config.webpackFinal(full)
    assert.equal(full.optimization.minimize, true)
    process.env.STORYBOOK_QUALITY = "1"
    const selected = { optimization: { minimize: true } }
    await config.webpackFinal(selected)
    assert.equal(selected.optimization.minimize, false)
  } finally {
    if (previous === undefined) delete process.env.STORYBOOK_QUALITY
    else process.env.STORYBOOK_QUALITY = previous
  }
})

test("Storybook resolves silk-wasm's guarded Node module import in the browser", async () => {
  const cfg = await config.webpackFinal({})
  const resolveBrowser = webpackRequire("enhanced-resolve").create.sync({
    fallback: cfg.resolve.fallback,
  })
  const codecDirectory = path.dirname(require.resolve("silk-wasm"))
  for (const request of ["module", "node:module"]) {
    assert.equal(resolveBrowser(codecDirectory, request), false, request)
  }
})

test("Storybook transpiles Next's allowlisted packages through pnpm's virtual store", async () => {
  const transpilePackages = ["@cognia/sync-protocol", "@cognia/status-contract", "@noble/curves"]
  const virtualModule = path.resolve("node_modules/.cache/storybook/virtual.ts")
  const options = { nextConfig: { transpilePackages }, hasReactRefresh: true }
  const rule = {
    test: /\.[jt]sx?$/,
    include: [process.cwd()],
    exclude: [
      /node_modules\/(?!(@cognia\/sync-protocol|@cognia\/status-contract|@noble\/curves)\/)/,
      virtualModule,
    ],
    use: { loader: "@storybook/nextjs/next-swc-loader-patch", options },
  }
  // Keep the existing nested-rule traversal working as well as top-level rules.
  const rawRule = { resourceQuery: /raw/, exclude: /node_modules/ }
  await config.webpackFinal({ module: { rules: [rawRule, { oneOf: [rule] }] } })
  const excludes = compiler.compileCondition("exclude", rule.exclude).fn

  for (const name of transpilePackages) {
    for (const separator of ["/", "\\"]) {
      for (const file of [
        `/repo/node_modules/${name}/src/index.ts`,
        `/repo/node_modules/.pnpm/${name.replace("/", "+")}@pinned/node_modules/${name}/src/index.ts`,
      ]) {
        const resource = file.replaceAll("/", separator)
        assert.equal(excludes(resource), false, resource)
      }
    }
  }
  for (const resource of [
    virtualModule,
    "/repo/node_modules/unlisted/index.ts",
    "/repo/node_modules/.pnpm/unlisted@1/node_modules/unlisted/index.ts",
    "/repo/node_modules/@cognia/sync-protocol-extra/index.ts",
    "/repo/node_modules/@cognia/sync-protocol/node_modules/unlisted/index.ts",
  ]) {
    assert.equal(excludes(resource), true, resource)
  }
  assert.equal(excludes("/repo/components/chat/tool-approval-dialog.tsx"), false)
  assert.equal(rawRule.exclude.test("/repo/node_modules/unlisted/index.ts"), true)
  assert.equal(rule.use.options, options, "Reuse the framework's compiler options")
  assert.equal(options.hasReactRefresh, false, "Preserve the existing refresh workaround")
})
