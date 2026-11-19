import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"
import { build } from "esbuild"
import { createHighlighter } from "shiki"
import { createCodePlugin } from "@streamdown/code"
import oneLight from "shiki/themes/one-light.mjs"
import oneDark from "shiki/themes/one-dark-pro.mjs"
import githubLight from "shiki/themes/github-light-default.mjs"
import githubDark from "shiki/themes/github-dark-default.mjs"

test("actual Shiki and Streamdown use corrected themes after raw themes were cached", async () => {
  await mkdir(".cache", { recursive: true })
  const directory = await mkdtemp(path.resolve(".cache/storybook-code-themes-"))
  let highlighter
  try {
    const originals = [oneLight, oneDark, githubLight, githubDark]
    const beforeImport = structuredClone(originals)
    const outfile = path.join(directory, "themes.mjs")
    await build({
      entryPoints: ["lib/shiki/chat-code-themes.ts"],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      tsconfig: "tsconfig.build.json",
      outfile,
    })
    const { chatCodeThemeInputs } = await import(pathToFileURL(outfile).href)
    assert.deepEqual(originals, beforeImport, "resolving themes must not mutate bundled data")
    const families = [
      { light: "one-light", dark: "one-dark-pro" },
      { light: "github-light-default", dark: "github-dark-default" },
    ]
    const source = '// Synthetic comment\nexport const marker = "你好"'
    highlighter = await createHighlighter({
      langs: ["typescript"],
      themes: families.flatMap((pair) => [pair.light, pair.dark]),
    })

    const highlight = (themes, code = source, isIncomplete = false) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Installed Streamdown highlighting did not complete")),
          10000
        )
        const done = (tokens) => {
          clearTimeout(timer)
          resolve(tokens)
        }
        const plugin = createCodePlugin({ themes })
        const immediate = plugin.highlight(
          { code, language: "typescript", themes, isIncomplete },
          done
        )
        if (immediate) done(immediate)
      })
    for (const pair of families) {
      const original = [pair.light, pair.dark]
      const corrected = chatCodeThemeInputs(pair)
      const raw = highlighter.codeToTokens(source, { lang: "typescript", themes: pair })
      await highlight(original)
      for (const theme of corrected) await highlighter.loadTheme(theme)
      const finalized = highlighter.codeToTokens(source, {
        lang: "typescript",
        themes: { light: corrected[0].name, dark: corrected[1].name },
      })
      const streamed = await highlight(corrected)
      const incremental = await highlight(corrected, source + "\n// New line", true)

      assert.notEqual(finalized.tokens[0][0].htmlStyle.color, raw.tokens[0][0].htmlStyle.color)
      if (pair.light === "one-light")
        assert.notEqual(
          finalized.tokens[0][0].htmlStyle["--shiki-dark"],
          raw.tokens[0][0].htmlStyle["--shiki-dark"]
        )
      assert.deepEqual(streamed.tokens, finalized.tokens)
      assert.deepEqual(incremental.tokens.slice(0, 2), finalized.tokens)
      assert.equal(
        finalized.tokens.map((line) => line.map((token) => token.content).join("")).join("\n"),
        source
      )
    }
  } finally {
    highlighter?.dispose()
    await rm(directory, { recursive: true, force: true })
  }
})
