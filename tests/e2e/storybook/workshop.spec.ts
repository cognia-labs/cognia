import { readFileSync } from "node:fs"
import AxeBuilder from "@axe-core/playwright"
import { expect, test, type Page } from "@/tests/e2e/fixtures/test"
import requiredFiles from "@/.storybook/quality-stories.json"
import { qualityEntries } from "@/scripts/storybook/quality-index.mjs"

// Discovery fails on absent/stale selection instead of silently running zero tests.
const staticRoot =
  process.env.STORYBOOK_FULL_CATALOG === "1" ? ".cache/storybook-full" : ".cache/storybook-static"
const index = JSON.parse(readFileSync(`${staticRoot}/index.json`, "utf8"))
const stories = qualityEntries(index, requiredFiles)

async function openStory(page: Page, id: string, globals: Record<string, unknown>) {
  const query = new URLSearchParams({
    id,
    viewMode: "story",
    globals: `locale:${globals.locale};theme:${globals.theme}`,
  })
  await page.goto(`/iframe.html?${query}`, { waitUntil: "domcontentloaded" })
  const result = await page.waitForFunction((storyId) => {
    const channel = (
      window as Window & {
        __STORYBOOK_ADDONS_CHANNEL__?: { last: (event: string) => unknown[] | undefined }
      }
    ).__STORYBOOK_ADDONS_CHANNEL__
    for (const event of ["storyErrored", "storyThrewException", "playFunctionThrewException"]) {
      const error = channel?.last(event)?.[0]
      if (error)
        return {
          storyId,
          status: "error",
          error: (error as { message?: string }).message ?? String(error),
        }
    }
    if (document.body.classList.contains("sb-show-errordisplay")) {
      return {
        storyId,
        status: "error",
        error: document.querySelector("#error-message")?.textContent,
      }
    }
    const finished = channel?.last("storyFinished")?.[0] as
      { storyId?: string; status?: string } | undefined
    return finished?.storyId === storyId ? finished : false
  }, id)
  const completion = await result.jsonValue()
  expect(
    completion,
    `Story ${id} must finish render AND play: ${JSON.stringify(completion)}`
  ).toMatchObject({ storyId: id, status: "success" })
  await expect(page.locator("html")).toHaveAttribute("lang", String(globals.locale))
  await expect(page.locator("html")).toHaveClass(
    globals.theme === "dark" ? /dark/ : /^(?!.*\bdark\b)/
  )
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

async function switchStory(page: Page, id: string) {
  const result = await page.evaluate((storyId) => {
    const channel = (
      window as Window & {
        __STORYBOOK_ADDONS_CHANNEL__?: {
          once: (event: string, callback: (result: unknown) => void) => void
          emit: (event: string, payload: unknown) => void
        }
      }
    ).__STORYBOOK_ADDONS_CHANNEL__
    if (!channel) throw new Error("Storybook preview channel is unavailable")
    // Subscribe before switching: an earlier visit to A has its own cached
    // storyFinished event, which must not satisfy the return trip to A.
    return new Promise((resolve) => {
      channel.once("storyFinished", resolve)
      channel.emit("setCurrentStory", { storyId, viewMode: "story" })
    })
  }, id)
  expect(result).toMatchObject({ storyId: id, status: "success" })
}

for (const story of stories) {
  test(`@smoke @a11y ${story.id} renders, completes play and passes WCAG`, async ({
    page,
  }, testInfo) => {
    const errors: string[] = []
    const consoleErrors: string[] = []
    const externalRequests: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text())
    })
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      if (url.protocol.startsWith("http") && url.origin !== "http://127.0.0.1:6007") {
        externalRequests.push(url.origin)
        await route.abort()
      } else {
        await route.continue()
      }
    })
    await openStory(page, story.id, testInfo.project.metadata)
    const width = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }))
    expect(width.document, `${story.id} must fit the preview viewport`).toBeLessThanOrEqual(
      width.viewport + 1
    )
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze()
    expect(result.violations).toEqual([])
    expect(errors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(externalRequests, "Synthetic fixtures must not contact providers or hosts").toEqual([])
  })
}

test("@smoke Overview and explicit prop documentation are readable", async ({ page }) => {
  await page.goto("/iframe.html?id=documentation-overview--docs&viewMode=docs")
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Cognia component workshop")
  await expect(page.getByRole("columnheader", { name: "Included / 已提供" })).toBeVisible()
  await page.goto("/iframe.html?id=shared-statusbadge--docs&viewMode=docs")
  await expect(page.getByText("Translated status pill.", { exact: false })).toBeVisible()
  await expect(page.getByRole("row").filter({ hasText: "fallbackVariant" })).toContainText(
    "Variant used"
  )
})

test("@critical @a11y dialog opens by keyboard, traps focus and restores it after Escape", async ({
  page,
}, testInfo) => {
  await openStory(page, "ui-dialog--keyboard", testInfo.project.metadata)
  const trigger = page.getByRole("button")
  await trigger.press("Enter")
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Tab")
  await expect(dialog.locator(":focus")).toHaveCount(1)
  await page.keyboard.press("Escape")
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test("@critical @a11y checkbox supports keyboard activation", async ({ page }, testInfo) => {
  await openStory(page, "ui-checkbox--unchecked", testInfo.project.metadata)
  const checkbox = page.getByRole("checkbox")
  await expect(checkbox).toBeChecked() // play already exercised the pointer path
  await checkbox.focus()
  await checkbox.press("Space")
  await expect(checkbox).not.toBeChecked()
})

test("@critical preview store is reproducible after A–B–A navigation", async ({
  page,
}, testInfo) => {
  await openStory(page, "files-lenses--suggested", testInfo.project.metadata)
  await expect(page.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true")
  await switchStory(page, "files-lenses--trash-hidden")
  await expect(page.getByRole("radiogroup")).toHaveCount(0)
  await switchStory(page, "files-lenses--suggested")
  await expect(page.getByRole("radio").nth(1)).toHaveAttribute("aria-checked", "true")
})

test("@critical @a11y Files filter arrows move focus and selection together", async ({
  page,
}, testInfo) => {
  await openStory(page, "files-lenses--favorites", testInfo.project.metadata)
  const options = page.getByRole("radio")
  await options.nth(1).focus()
  await page.keyboard.down("ArrowRight")
  await expect(options.nth(2)).toBeFocused()
  await expect(options.nth(2)).toBeChecked()
  await page.keyboard.up("ArrowRight")
  await expect(options.nth(1)).not.toBeChecked()
  await options.nth(2).click()
  await expect(options.nth(2)).toBeChecked()
})

test("@critical @a11y device kind chips preserve toggle semantics with keyboard focus", async ({
  page,
}, testInfo) => {
  await openStory(page, "devices-devicelistpane--mixed-fleet", testInfo.project.metadata)
  const filters = page.getByRole("toolbar", { name: /^(Filter by device kind|按设备类型筛选)$/ })
  const chips = filters.getByRole("button")
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true")
  await chips.nth(0).focus()
  await page.keyboard.down("ArrowRight")
  await expect(chips.nth(1)).toBeFocused()
  await page.keyboard.up("ArrowRight")
  // Toggle-group arrows move focus; Space commits or clears the kind.
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("Space")
  await expect(chips.nth(1)).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("Space")
  await expect(chips.nth(0)).toHaveAttribute("aria-pressed", "true")
})

test("@critical @a11y open popup examples isolate background and restore focus", async ({
  page,
}, testInfo) => {
  for (const [id, role, triggerRole] of [
    ["ui-select--open", "listbox", "combobox"],
    ["ui-dropdownmenu--open", "menu", "button"],
  ] as const) {
    await openStory(page, id, testInfo.project.metadata)
    const popup = page.getByRole(role)
    await expect(popup.locator(":focus")).toHaveCount(1)
    await expect(page.locator("#storybook-root [inert]")).toHaveCount(1)
    await page.keyboard.press("Tab")
    await expect(popup.locator(":focus")).toHaveCount(1)
    await page.keyboard.press("Escape")
    await expect(popup).toHaveCount(0)
    await expect(page.locator("#storybook-root [inert]")).toHaveCount(0)
    await expect(page.getByRole(triggerRole)).toBeFocused()
  }
})

test("@critical Chat fixtures reset stores after same-document navigation", async ({
  page,
}, testInfo) => {
  await openStory(page, "chat-chatpane--conversation", testInfo.project.metadata)
  await expect(page.getByRole("log")).toContainText("React")
  await switchStory(page, "chat-chatpane--error-state")
  // Error play retries and clears the error, so it must not leak to Empty.
  await expect(page.getByRole("alert")).toHaveCount(0)
  await switchStory(page, "chat-chatpane--empty-state")
  await expect(page.getByRole("log")).toHaveCount(0)
  await expect(page.getByRole("alert")).toHaveCount(0)
  await switchStory(page, "chat-chatpane--thinking")
  await expect(page.getByRole("button", { name: /^(Stop|停止)$/ })).toBeVisible()
  await switchStory(page, "chat-chatpane--conversation")
  await expect(page.getByRole("log")).toContainText("React")
  await expect(page.getByRole("button", { name: /^(Stop|停止)$/ })).toHaveCount(0)
})

async function codeInk(page: Page, selector: string) {
  return page
    .locator(`${selector} pre:visible`)
    .first()
    .evaluate((pre) => {
      const code = pre.querySelector("code") ?? pre
      const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
      const ink: { text: string; color: string }[] = []
      while (walker.nextNode()) {
        const node = walker.currentNode
        const color = getComputedStyle(node.parentElement!).color
        for (const text of node.textContent ?? "") if (/\S/.test(text)) ink.push({ text, color })
      }
      // Streamdown makes each line a block span; it does not put literal LF
      // text nodes between them. Compare line contents and boundaries in both
      // engines, independently from the exact-source clipboard assertion.
      const text = Array.from(code.children)
        .map((line) => line.textContent)
        .join("\n")
        .trimEnd()
      return { text, ink }
    })
}

for (const variant of ["default", "github"]) {
  test(`@critical @a11y ${variant} code keeps actual colours through streaming and finalization`, async ({
    page,
  }, testInfo) => {
    await openStory(page, `chat-readingsurface--${variant}-code-parity`, testInfo.project.metadata)
    const streamed = await codeInk(page, '[data-code-phase="streaming"]')
    expect(streamed.text).toBe(
      '// Synthetic comment\nexport const marker = "你好"\nconst total = 42'
    )
    await page.getByRole("button", { name: /^(Confirm|确认)$/ }).click()
    await expect(page.locator('[data-code-phase="finalized"] pre.shiki')).toHaveCount(2)
    const finalized = await codeInk(page, '[data-code-phase="finalized"]')
    expect(finalized).toEqual(streamed)
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze()
    expect(result.violations).toEqual([])
    await page.getByRole("button", { name: /^(Cancel|取消)$/ }).click()
    await expect(
      page.locator('[data-code-phase="streaming"] code span[style*="--shiki-dark"]').first()
    ).toBeAttached()
    expect(await codeInk(page, '[data-code-phase="streaming"]')).toEqual(streamed)
  })
}

async function captureClipboard(page: Page) {
  await page.evaluate(() => {
    const copies: string[] = []
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copies.push(text)
        },
      },
    })
    Object.assign(window, { __storybookCodeCopies: copies })
  })
}

async function copiedSource(page: Page) {
  return page.evaluate(
    () => (window as Window & { __storybookCodeCopies?: string[] }).__storybookCodeCopies ?? []
  )
}

test("@critical code theme flip keeps DOM/highlight result and full-source copy intact", async ({
  page,
}, testInfo) => {
  await openStory(page, "chat-renderers-codeblock--long-source", testInfo.project.metadata)
  const expected = [
    ...Array.from({ length: 2001 }, (_, index) => `// Line ${index}: 你好`),
    "// COMPLETE_SOURCE_TAIL",
  ].join("\r\n")
  const preview = page.getByRole("region", { name: /Code in typescript|typescript 代码/ })
  await expect(preview).toBeVisible()
  await expect(preview).toContainText("Line 1999: 你好")
  await expect(preview).not.toContainText("COMPLETE_SOURCE_TAIL")
  const before = await page.locator("pre.shiki").allTextContents()
  const nodes = await page.locator("pre.shiki").elementHandles()
  const firstColor = await page
    .locator("pre.shiki:visible span[style]")
    .first()
    .evaluate((el) => getComputedStyle(el).color)
  await captureClipboard(page)
  await page.getByRole("button", { name: /^(Copy code|复制代码)$/ }).click()
  await expect.poll(() => copiedSource(page)).toEqual([expected])
  await page.evaluate(() => document.documentElement.classList.toggle("dark"))
  const nextColor = await page
    .locator("pre.shiki:visible span[style]")
    .first()
    .evaluate((el) => getComputedStyle(el).color)
  expect(nextColor).not.toBe(firstColor)
  for (const node of nodes) expect(await node.evaluate((el) => el.isConnected)).toBe(true)
  expect(await page.locator("pre.shiki").allTextContents()).toEqual(before)
  await page.getByRole("button", { name: /^(Copy code|复制代码)$/ }).click()
  await expect.poll(() => copiedSource(page)).toEqual([expected, expected])
})

test("@critical AI code copy uses the original Unicode source", async ({ page }, testInfo) => {
  await openStory(page, "ai-elements-codeblock--default", testInfo.project.metadata)
  const root = page.locator('[data-slot="ai-code-block"] pre')
  const beforeInk = await root
    .locator('span[style*="--shiki-dark"]')
    .first()
    .evaluate((el) => getComputedStyle(el).color)
  const node = await root.elementHandle()
  await page.evaluate(() => document.documentElement.classList.toggle("dark"))
  await expect(root).toHaveCSS(
    "background-color",
    testInfo.project.metadata.theme === "dark" ? "rgb(250, 250, 250)" : "rgb(40, 44, 52)"
  )
  await expect(root.locator('span[style*="--shiki-dark"]').first()).not.toHaveCSS(
    "color",
    beforeInk
  )
  expect(await node!.evaluate((el) => el.isConnected)).toBe(true)
  await captureClipboard(page)
  await page.getByRole("button", { name: /^(Copy|复制)$/ }).click()
  await expect
    .poll(() => copiedSource(page))
    .toEqual(['// Synthetic comment\nexport const marker = "你好"\nconst total = 42'])
})

test("@critical @a11y code scroll regions are reachable by keyboard", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const id of [
    "ai-elements-codeblock--changed-middle",
    "chat-renderers-codeblock--streaming",
    "chat-renderers-codeblock--highlighted-lines",
  ]) {
    await openStory(page, id, testInfo.project.metadata)
    const region = page.getByRole("region")
    await expect(region).toHaveAccessibleName(/.+/)
    await region.focus()
    await expect(region).toBeFocused()
    await page.keyboard.press("ArrowRight")
    await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  }
})

test("@visual deterministic loading tokens and primitives", async ({ page }, testInfo) => {
  await openStory(page, "ui-loading--visual", testInfo.project.metadata)
  // This fixture has no visible text or system-font glyphs. Keep the same
  // pinned Chromium/macOS environment for baseline generation and CI review.
  await expect(page.getByRole("region")).toHaveScreenshot("loading-primitives.png", {
    animations: "disabled",
  })
})
