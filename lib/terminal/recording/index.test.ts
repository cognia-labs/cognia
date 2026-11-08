/**
 * Barrel surface guard for terminal recording, and the pin on its dormancy:
 * the recorder and player exist as a library, but no product surface uses
 * them yet (see the barrel's header).
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import * as recording from "./index"
import { createRecorder, DEFAULT_MAX_DURATION_SEC, DEFAULT_TITLE } from "./recorder"
import { createPlayer } from "./player"

describe("lib/terminal/recording barrel", () => {
  it("re-exports the recorder and player factories by identity", () => {
    expect(recording.createRecorder).toBe(createRecorder)
    expect(recording.createPlayer).toBe(createPlayer)
  })

  it("re-exports the asciicast codec pair", () => {
    expect(typeof recording.serializeAsciicast).toBe("function")
    expect(typeof recording.parseAsciicast).toBe("function")
  })

  it("re-exports the recorder defaults by identity", () => {
    expect(recording.DEFAULT_MAX_DURATION_SEC).toBe(DEFAULT_MAX_DURATION_SEC)
    expect(recording.DEFAULT_TITLE).toBe(DEFAULT_TITLE)
  })

  it("exposes exactly the documented runtime surface", () => {
    expect(Object.keys(recording).sort()).toEqual([
      "DEFAULT_MAX_DURATION_SEC",
      "DEFAULT_TITLE",
      "createPlayer",
      "createRecorder",
      "parseAsciicast",
      "serializeAsciicast",
    ])
  })
})

/** Every `.ts`/`.tsx` source file under `dir`, tests excluded. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.tsx?$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name)) out.push(path)
  }
  return out
}

describe("lib/terminal/recording dormancy", () => {
  /**
   * Built but not surfaced: a UI that starts importing the recorder makes it a
   * feature, and the docs and the barrel's "dormant" label must change with it.
   * Update this pin in the same change.
   */
  it("is not imported by any UI layer yet", () => {
    const root = process.cwd()
    const importers = ["app", "components", "hooks", "stores"]
      .flatMap((dir) => sourceFiles(join(root, dir)))
      .filter((file) => readFileSync(file, "utf8").includes("lib/terminal/recording"))
      .map((file) => file.slice(root.length + 1))
    expect(importers).toEqual([])
  })
})
