import assert from "node:assert/strict"
import { test } from "node:test"

import { createSubsystemClassifier } from "./subsystems.mjs"

const FILES = [
  "lib/chat/engine.ts",
  "components/chat/view.tsx",
  "hooks/chat/use-chat.ts",
  "stores/chat/chat-store.ts",
  "components/plugins/list.tsx",
  "lib/plugin/host.ts",
  "components/providers/initializers/x.tsx",
  "lib/settings/defaults.ts",
  "components/settings/shell.tsx",
  "app/(mobile-onboard)/pair/page.tsx",
  "lib/pet/window.ts",
  "lib/pet.ts",
  "lib/stray.ts",
  "hooks/use-chat.ts",
]

const { classify } = createSubsystemClassifier(FILES)

test("one feature across layers is one subsystem", () => {
  for (const file of FILES.slice(0, 4)) assert.equal(classify(file).key, "chat")
  assert.equal(classify("hooks/chat/use-chat.ts").layer, "hooks")
})

test("plural and singular directories merge", () => {
  assert.equal(classify("components/plugins/list.tsx").key, "plugin")
  assert.equal(classify("lib/plugin/host.ts").key, "plugin")
})

test("the initializers and the settings store get names of their own", () => {
  assert.equal(classify("components/providers/initializers/x.tsx").key, "initializers")
  assert.equal(classify("lib/settings/defaults.ts").key, "settings-store")
  assert.equal(classify("components/settings/shell.tsx").key, "settings")
})

test("route groups name the subsystem inside the parentheses", () => {
  assert.equal(classify("app/(mobile-onboard)/pair/page.tsx").key, "mobile-onboard")
})

test("a root-level file attaches to a subsystem of the same name, else to the layer root", () => {
  assert.equal(classify("lib/pet.ts").key, "pet")
  assert.equal(classify("hooks/use-chat.ts").key, "chat")
  assert.equal(classify("lib/stray.ts").key, "lib-root")
})

test("packages, plugins and the CLI keep their own keys; other roots are unclassified", () => {
  assert.deepEqual(classify("packages/redact/src/index.ts"), {
    key: "pkg:redact",
    layer: "packages",
  })
  assert.deepEqual(classify("plugins/ocr/src/index.ts"), { key: "plugin:ocr", layer: "plugins" })
  assert.deepEqual(classify("cli/src/main.ts"), { key: "cli", layer: "cli" })
  assert.equal(classify("src-tauri/src/lib.rs"), null)
})
