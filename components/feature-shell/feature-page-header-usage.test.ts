/**
 * The page-header rules, pinned at every call site.
 *
 * `FeaturePageHeader` owns the look, but a call site still chooses which
 * props to pass, and that choice is how forty headers drifted apart: half had
 * a description and half did not, five tab styles sat in three places, and a
 * few pages fell back to the column-height `compact` band. This scans the
 * source of every call site and fails on a header that breaks the design, so
 * the next page added cannot quietly start the drift again.
 */

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(__dirname, "..", "..")
const SCANNED = ["app", "components"]

/**
 * Headers that are a column's own title inside a larger shell, where the
 * 40px band is right and a page-height band would not be.
 */
const COMPACT_ALLOWED: Record<string, string> = {
  "components/settings/settings-shell.tsx":
    "Settings' detail column under the settings nav; each section titles itself",
  "components/browser/browser-desktop-body.tsx":
    "the browser's chrome, where every pixel of height belongs to the page",
}

/**
 * View-bar content that is not a tab set. Everything else uses `tabs`, which
 * draws the one underline style.
 */
const NAVIGATION_ALLOWED: Record<string, string> = {}

interface CallSite {
  file: string
  props: Set<string>
  literal: Map<string, string>
}

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else if (/\.tsx$/.test(name) && !/\.(test|stories)\.tsx$/.test(name)) out.push(path)
  }
}

/** The props written on each `<FeaturePageHeader …>` opening tag. */
function callSites(): CallSite[] {
  const files: string[] = []
  for (const dir of SCANNED) walk(join(ROOT, dir), files)
  const sites: CallSite[] = []
  for (const path of files) {
    const source = readFileSync(path, "utf8")
    const file = relative(ROOT, path)
    if (file === "components/feature-shell/feature-page-header.tsx") continue
    let at = source.indexOf("<FeaturePageHeader")
    while (at !== -1) {
      let i = at + "<FeaturePageHeader".length
      let depth = 0
      let tag = ""
      for (; i < source.length; i++) {
        const c = source[i]
        if (depth === 0 && source.startsWith("//", i)) {
          // A comment between props may hold a ">" that is not the tag's end.
          const end = source.indexOf("\n", i)
          tag += source.slice(i, end === -1 ? source.length : end)
          i = (end === -1 ? source.length : end) - 1
          continue
        }
        if (c === "{") depth++
        else if (c === "}") depth--
        else if (depth === 0 && (c === ">" || source.startsWith("/>", i))) break
        tag += c
      }
      const props = new Set<string>()
      const literal = new Map<string, string>()
      let d = 0
      let quoted = false
      for (let j = 0; j < tag.length; j++) {
        const c = tag[j] ?? ""
        if (d === 0 && !quoted && tag.startsWith("//", j)) {
          // A comment between props: skip to the end of its line.
          const end = tag.indexOf("\n", j)
          j = end === -1 ? tag.length : end - 1
        } else if (d === 0 && c === '"') quoted = !quoted
        else if (quoted) continue
        else if (c === "{") d++
        else if (c === "}") d--
        else if (d === 0 && /\s/.test(c)) {
          const match = /^\s+([a-zA-Z]+)(?:=("[^"]*"))?/.exec(tag.slice(j))
          if (match?.[1]) {
            props.add(match[1])
            if (match[2]) literal.set(match[1], match[2].slice(1, -1))
          }
        }
      }
      sites.push({ file, props, literal })
      at = source.indexOf("<FeaturePageHeader", i)
    }
  }
  return sites
}

const SITES = callSites()

/** A page's own header, as opposed to a card or a nested section heading. */
function isPageHeader(site: CallSite) {
  const variant = site.literal.get("variant") ?? "management"
  return variant === "management" && site.literal.get("headingLevel") !== "2"
}

test("finds the call sites it is meant to police", () => {
  // A parser that silently matched nothing would pass every rule below.
  expect(SITES.length).toBeGreaterThan(30)
  expect(SITES.filter(isPageHeader).length).toBeGreaterThan(25)
})

test("every page header names itself: an icon (or avatar, or a way back) and a description", () => {
  const missing = SITES.filter(isPageHeader)
    .filter(
      (site) =>
        !site.props.has("description") ||
        !(site.props.has("icon") || site.props.has("avatar") || site.props.has("back"))
    )
    .map((site) => `${site.file}: ${[...site.props].join(" ")}`)
  expect(missing).toEqual([])
})

test("only a column-title header uses the compact band", () => {
  const compact = SITES.filter((site) => site.literal.get("variant") === "compact").map(
    (site) => site.file
  )
  expect(compact.filter((file) => !(file in COMPACT_ALLOWED))).toEqual([])
})

test("view tabs go through `tabs`, never a hand-built `navigation`", () => {
  const custom = SITES.filter((site) => site.props.has("navigation")).map((site) => site.file)
  expect(custom.filter((file) => !(file in NAVIGATION_ALLOWED))).toEqual([])
})

test("no header brings its own placement for navigation", () => {
  // Tabs always sit in the view bar; the inline placement was removed.
  expect(
    SITES.filter((site) => site.props.has("navigationPlacement")).map((site) => site.file)
  ).toEqual([])
})
