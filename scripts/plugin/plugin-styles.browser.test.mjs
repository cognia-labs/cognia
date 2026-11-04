import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { build } from "esbuild"
import { chromium, webkit } from "@playwright/test"
import { buildFrontendPlugin } from "./build-frontend-plugins.mjs"

const stylesBundle = await build({
  entryPoints: ["lib/plugin/styles/plugin-stylesheet.ts"],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "PluginStyles",
  platform: "browser",
  define: { "process.env": "{}" },
})
for (const [name, browserType] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  for (const supportsScope of [true, false]) {
    test(`release CSS retains responsive/focus/hover/dark/animation behavior in ${name}, scope=${supportsScope}`, async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-style-browser-"))
      t.after(() => fs.rmSync(root, { recursive: true, force: true }))
      const directory = path.join(root, "plugins/example/src")
      fs.mkdirSync(directory, { recursive: true })
      const classes =
        "sm:px-2 focus-visible:underline animate-spin translate-x-1 ring-2 dark:text-muted-foreground [@media(hover:hover)]:hover:bg-muted/50"
      const manifest = { id: "example", version: "1.0.0", type: "frontend", main: "src/index.ts" }
      fs.writeFileSync(path.join(root, "plugins/example/plugin.json"), JSON.stringify(manifest))
      fs.writeFileSync(
        path.join(directory, "index.ts"),
        `export const classes=${JSON.stringify(classes)}; export default {manifest:${JSON.stringify(manifest)}}`
      )
      const release = await buildFrontendPlugin({
        root,
        directory: "example",
        moduleManifest: manifest,
      })
      const css =
        release.files.get(release.manifest.styles).toString() +
        '\n.probe,#never{color:red}.probe{color:blue}.probe::before{content:"marker"}@supports(font-family:"{"){.brace{color:green}}'
      const browser = await browserType.launch({ headless: true })
      t.after(() => browser.close())
      const page = await browser.newPage({
        viewport: { width: 800, height: 600 },
        reducedMotion: "no-preference",
      })
      await page.route("http://plugin-styles.test/", (route) =>
        route.fulfill({ contentType: "text/html", body: "<!doctype html>" })
      )
      await page.goto("http://plugin-styles.test/")
      await page.setContent(
        `<style>@layer properties,theme,base,components,utilities;:root{--muted:rgb(20,40,60);--muted-foreground:rgb(50,60,70)}@layer base{input{padding:0;border:0;background:transparent}}</style><div data-plugin-root="example"><input id="inside" class="${classes}" value="inside"><span class="probe" id="probe">probe</span><span class="brace" id="brace">brace</span></div><input id="outside" class="${classes}" value="outside"><span class="probe" id="outside-probe">outside</span>`
      )
      await page.addScriptTag({ content: stylesBundle.outputFiles[0].text })
      await page.evaluate(
        ({ css, supportsScope }) => {
          if (!supportsScope) delete globalThis.CSSScopeRule
          PluginStyles.injectPluginStyles("example", css)
        },
        { css, supportsScope }
      )
      assert.equal(
        (await page.locator('[data-plugin-styles="example"]').textContent()).includes("@scope ("),
        supportsScope
      )
      assert.deepEqual(
        await page.locator("#probe").evaluate((el) => ({
          color: getComputedStyle(el).color,
          before: getComputedStyle(el, "::before").content,
        })),
        { color: "rgb(0, 0, 255)", before: '"marker"' }
      )
      assert.equal(
        await page
          .locator("#outside-probe")
          .evaluate((el) => getComputedStyle(el, "::before").content),
        "none"
      )
      assert.equal(
        await page.locator("#brace").evaluate((el) => getComputedStyle(el).color),
        "rgb(0, 128, 0)"
      )
      const observe = () =>
        page.locator("#inside").evaluate((element) => {
          const style = getComputedStyle(element)
          return {
            padding: style.paddingLeft,
            translate: style.translate,
            animation: style.animationName,
            animations: element.getAnimations().length,
            shadow: style.boxShadow,
            color: style.color,
            underline: style.textDecorationLine,
            background: style.backgroundColor,
          }
        })
      let computed = await observe()
      assert.equal(computed.padding, "8px")
      assert.equal(computed.translate, "4px")
      assert.equal(computed.animation, "spin")
      assert.equal(computed.animations, 1)
      assert.match(computed.shadow, /2px/)
      await page.locator("#inside").evaluate((element) => {
        for (const animation of element.getAnimations()) {
          animation.pause()
          animation.currentTime = 0
        }
      })
      await page.keyboard.press("Tab")
      assert.match((await observe()).underline, /underline/)
      await page.locator("#inside").hover()
      assert.notEqual((await observe()).background, "rgba(0, 0, 0, 0)")
      await page.evaluate(() => document.documentElement.classList.add("dark"))
      assert.equal((await observe()).color, "rgb(50, 60, 70)")
      await page.evaluate(() => document.documentElement.style.setProperty("--spacing", "8px"))
      computed = await observe()
      assert.equal(computed.padding, "16px")
      assert.equal(computed.translate, "8px")
      const outside = await page.locator("#outside").evaluate((element) => ({
        padding: getComputedStyle(element).paddingLeft,
        animations: element.getAnimations().length,
      }))
      assert.deepEqual(outside, { padding: "0px", animations: 0 })
      await page.setViewportSize({ width: 500, height: 600 })
      assert.equal((await observe()).padding, "0px")
      console.log(`[release-style] ${name} ${browser.version()} passed`)
    })
  }
}
