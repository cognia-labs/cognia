import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { parse } from "yaml"

const workflow = parse(readFileSync(".github/workflows/storybook.yml", "utf8"))
const pkg = JSON.parse(readFileSync("package.json", "utf8"))

test("the PR lane builds the selected workshop before running the real browser gates", () => {
  const job = workflow.jobs.quality
  const commands = job.steps.flatMap((step) => (step.run ? [step.run] : []))
  assert.equal(job["runs-on"], "macos-26", "Match the screenshot-authoring OS/architecture")
  assert.ok(
    commands.indexOf("pnpm storybook:quality:build") < commands.indexOf("pnpm storybook:test")
  )
  for (const script of ["storybook:config:test", "storybook:quality:build", "storybook:test"]) {
    assert.ok(pkg.scripts[script])
    assert.ok(commands.includes(`pnpm ${script}`))
  }
  assert.ok(commands.includes("pnpm exec playwright install chromium"))
  assert.ok(pkg.scripts["storybook:quality:build"].includes("STORYBOOK_QUALITY=1"))
  assert.ok(pkg.scripts["storybook:test"].includes("playwright.storybook.config.ts"))
  assert.ok(
    job.steps.some(
      (step) => step.if === "always()" && step.uses.startsWith("actions/upload-artifact@")
    )
  )
})

test("full catalog builds keep normal discovery and remain separate from selected PR evidence", () => {
  const job = workflow.jobs["full-catalog"]
  assert.match(job.if, /push/)
  const build = job.steps.find((step) => step.run?.includes("storybook build"))
  assert.ok(build)
  assert.equal(job.env.STORYBOOK_QUALITY, undefined)
  assert.equal(build.env?.STORYBOOK_QUALITY, undefined)
  assert.ok(
    job.steps.some(
      (step) =>
        step.env?.STORYBOOK_FULL_CATALOG === "1" && step.run?.includes("pnpm storybook:test")
    )
  )
  assert.ok(workflow.on.pull_request.paths.includes("tests/e2e/storybook/**"))
  for (const event of ["pull_request", "push"]) {
    for (const path of [
      "app/**/*.css",
      "packages/**",
      "public/**",
      "jest.config.ts",
      "__mocks__/shiki-theme-*.js",
    ]) {
      assert.ok(workflow.on[event].paths.includes(path), `${event}: ${path}`)
    }
  }
})
