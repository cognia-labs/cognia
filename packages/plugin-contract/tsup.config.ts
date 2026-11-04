import { defineConfig } from "tsup"

// The plugin contract is types plus the constants and validators that define
// it. Every module is an entry so subpath imports
// (`@cognia/plugin-contract/types/plugin/plugin`, …) resolve from dist too.
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  // build-package.mjs emits checked declarations with native TypeScript first.
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2017",
  // Hooks and modal stores must use the consumer's React dispatcher and state runtime.
  external: [/^@cognia\//, /^react(?:\/|$)/, /^zustand(?:\/|$)/],
  // These workspaces publish source-first entries. A contract tarball loaded
  // by plain Node must inline them: Node does not strip TS in node_modules.
  noExternal: [
    /^@cognia\/(?:agent-trace|document|logging|primitives|provider-core|provider-embedding|rag|redact|tts|web-search)(?:\/|$)/,
  ],
})
