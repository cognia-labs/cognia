import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import * as sync from "./index"

it("exports the vendor-neutral Host entry points", () => {
  for (const name of [
    "runExternalSync",
    "registerExternalSync",
    "requestExternalSync",
    "installExternalSyncRuntime",
    "registerExternalSyncRenewer",
    "setExternalSyncSubscription",
  ] as const)
    expect(sync[name]).toEqual(expect.any(Function))
})

it("pins renewal dormancy: no built-in Host or bundled plugin calls a renewer", () => {
  const callers: string[] = []
  const walk = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (["node_modules", "dist", "build", ".next"].includes(entry.name)) continue
      const file = join(path, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (/\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec|stories)\./.test(file)) {
        const source = readFileSync(file, "utf8")
        if (
          /\bregisterExternalSyncRenewer\s*\(/.test(source) &&
          !file.endsWith("lib/external-services/sync/renewal.ts")
        )
          callers.push(file)
      }
    }
  }
  for (const root of [
    "app",
    "components",
    "hooks",
    "lib",
    "stores",
    "plugins",
    "cli/src",
    "services/workspace-runtime",
    "packages",
  ])
    walk(root)
  expect(callers).toEqual([])
})

it("keeps the core free of vendor and issue/calendar imports", () => {
  for (const file of ["types.ts", "core.ts", "runtime.ts", "renewal.ts", "index.ts"]) {
    const source = readFileSync(join(process.cwd(), "lib/external-services/sync", file), "utf8")
    expect(source).not.toMatch(
      /(?:from\s*|import\s*\()["'][^"']*(?:issues|calendar|lark|google|github)[^"']*["']/i
    )
  }
})
