// The pure A2UI core (ADR-0250 §14): what the kernel, the connectors, the
// scheduler, the CLI and the a2ui module share without importing the a2ui
// module. Each file is also its own entry (`@cognia/a2ui-core/<file>`), which
// is how the host imports it.

export * from "./component-tree"
export * from "./computed"
export * from "./data-model"
export * from "./mcp-tool-schemas"
export * from "./parser"
export * from "./segment-sanitize"
export * from "./streaming-preview"
