# Content safety

Runtime-neutral assessment shared by the app, CLI and sidecar. A separate
package is needed because these runtimes cannot import app-private modules,
and PII redaction has independent round-trip and offset contracts.

- `assessContentSafety` returns category/reason-code findings and explicit
  inspection status. It never modifies input, returns source excerpts, or
  includes redaction maps.
- `decideContentSafety` applies independent privacy and injection policies.
  The Host owns configuration, replies, auditing and execution refusal.
- `assertSafeExternalContent` inspects structured model-visible tool output
  with bounded text/decode/node/depth budgets; opaque binary transport fields
  are excluded while textual siblings and text resources are inspected.
- `frameExternalContent` fences external data and neutralizes embedded fences.
- `assessStructuredContentSafety` aggregates findings across text, keys,
  textual bytes, data URLs and tagged file data with one traversal budget.
- `assertSafeModelInput` and `assertSafeModelHistory` combine authored text parts
  and preserve quoted analysis; attachments and tool evidence remain external.

PII behavior remains in `@cognia/redact`. No LLM calls, model downloads,
automatic bans, persona checks, HTTP listeners or destructive prompt cleaning
are added. The new code is independently implemented rather than copied from
the evaluated AstrBot plugin.

## Host wiring

The connector's `promptInjectionProtection` field defaults to enabled for old
and new rows. The existing permissions form persists an explicit boolean through
the audited, Host-owned configuration writer. Admission scans actual text and
locally extracted media before model-producing commands, queues, live steering
and automation fan-out. Current group/reply context and transcript rebuilds are
reassessed, preserving stored originals for UI. The value travels in
`SendOptions.contentSafety` and invalidates retained tool runtimes on change.
Bot-owned topics with an `imAuthorityBinding` inherit the adapter's safety
setting without adopting connector routing, history or model defaults.

Queued responders, workflow/Bot observers and recovery recheck current Host
policy before execution. Callback text and live controls are checked too.
An active turn with a different captured policy cannot accept steering, queued
follow-ups, live commands, compaction or restored context under a newer setting.
External execution tracks policy by adapter instance and native session ID;
session-object replacement cannot discard it. Streaming and non-streaming share
the same final dispatch check.

Final Cognia tool-result boundaries apply existing PII processing before the
injection check: AI SDK builtins/plugins/configured MCP, native SDK Cognia
builtins/plugins, authenticated tool-host, and CLI stdio tool-bridge. Disabling
bot injection protection leaves privacy gates, permissions and independent RAG
retrieval quarantine active. RAG trust classification reuses this package while
preserving its existing reason-code contract. The external bridge reuses its
fencing helper.

| Boundary                                           | Existing owner                                                                                                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Admission, deferred queues, recovery and callbacks | Connector Bus                                                                                                           |
| Current content, attachments and edited history    | Context Workbench, final IPC and sidecar admission                                                                      |
| Protected native SDK resume                        | Transcript preparation rebuilds a gated canonical seed; the Host refuses opaque resume IDs                              |
| External/ACP execution and controls                | External manager, CLI and paired-host caller admission                                                                  |
| Tool metadata and schemas                          | MCP discovery, native/AI SDK plugin adapters and CLI bridge                                                             |
| Native external MCP responses                      | Guarded stdio relay with the resolved setting                                                                           |
| Tool results after review                          | Final safety composition, including actual JSON/structuredContent projections                                           |
| External Bridge evidence                           | Tool envelopes and wiki metadata/resources; authorized Character/Skill instruction exports retain their owner semantics |

Detector v2 inspects bounded layered URI/base64/base64url, Unicode escapes,
HTML entities, compatibility characters and invisible separators. Every rule
uses decoded/normalized views. Depth, candidate, character and traversal limits
report incomplete inspection rather than declaring unexamined content safe.

Operators can test a sample locally in the permissions editor. It uses the draft
setting, stores no sample and makes no model call; clear/collapse removes it.
Audit filters use checkbox dropdowns and a protection-only checkbox, with counts
bounded to the loaded view. No incident store or schema migration is introduced.

Protected native SDK turns reconstruct a canonical seed instead of reusing
opaque history. This can reduce native resume/cache reuse; provider latency and
cost effects require live acceptance and are not established by local tests.

Heuristics do not establish universal semantic attack resistance. Third-party
agents and native SDKs may own tool loops Cognia cannot intercept; their own
tools remain governed by their native permissions. This package guards Cognia's
owned input/output boundaries rather than claiming to replace those controls.

## Validation

Use the root Jest entry point for `src/index.test.ts`. Sidecar integration tests
use `scripts/test/run-sidecar-tests.mjs`. `tsup` inlines the private redactor for
the staged Node export; linked-package freshness includes redactor source edits.
