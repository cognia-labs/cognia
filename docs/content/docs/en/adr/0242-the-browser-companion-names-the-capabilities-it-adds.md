---
title: "0242 — The browser companion names the capabilities it adds"
description: "The extension and the Host ship separately, and agent-safe-v1 is a frozen, closed operation vocabulary. This ADR keeps that profile unchanged and adds capabilities beside it: the extension names each one in hello.features, the Host refuses a capability's operations before sending them to a browser that did not name it, and the first two capabilities are session-scoped request rules (network-rules-v1) and recorded steps for end-to-end tests (recording-v1)."
---

# ADR 0242 — The browser companion names the capabilities it adds

**Status:** Proposed
**Date:** 2026-10-27
**Related:** [ADR-0228](./0228-the-browser-companion-captures-richly-and-can-be-driven) (the device socket, the `agent-safe-v1` profile and its cancellation rules), [ADR-0201](./0201-the-desktop-browser-runs-chromium-locally) (the browser tools and their privileged engine methods)

## Context

ADR-0228 §5 froze the driving vocabulary as the `agent-safe-v1` profile. The extension sends the profile in `hello.features`; the Host forwards an operation only to a connection that negotiated it, and the extension refuses any operation it does not implement. Neither side can grow a capability the other did not agree to.

The extension now adds two things an agent should be able to use:

1. **Request rules.** The side panel can answer, fail, delay or redirect a page's requests and rewrite their headers. An agent reproducing a bug wants the same thing in the tabs it drives.
2. **Recorded steps.** The person can record what they do in a page. Those steps are the raw material of an end-to-end test, and an agent writing the test wants to read them, or to record in its own tab.

The extension is released through browser stores and the Host through the desktop app. A Host that knows a new operation will meet an extension that does not, and the reverse. Adding the names to `agent-safe-v1` would change a profile that is defined as frozen. A whole new profile for every addition would turn each one into a coordinated upgrade of both sides.

## Decision

### `agent-safe-v1` stays as it is; capabilities are named beside it

The profile keeps its meaning: the cancellation-safe envelope and the operations of ADR-0228. A capability is a further entry in `hello.features`, named with its own version, for example `network-rules-v1`. It adds operations and nothing else. Its operations travel in the same envelope, under the same cancellation, pause and takeover rules, and with the same `browser.drive` grant.

`packages/companion-client/src/browser-agent-protocol.json` lists every operation in `operations` and maps each capability-gated operation to its feature in `operationFeatures`. The Rust socket's `OPERATIONS` and `OPERATION_FEATURES` are pinned to that file by test.

### The Host refuses what the browser did not name

`call()` checks the feature after the profile. An operation whose feature the connection's `hello` did not name is refused with `browser_feature_unsupported` (HTTP 412, not retryable) and is never queued or sent. The extension still refuses an operation it does not implement, so a Host that predates this ADR is safe as well.

The agent tools are registered on every backend. Their engine methods are optional and exist only on the extension engine, and they are privileged: only the first-party Browser Tools receive them. On any other backend the tool answers `browser_feature_unsupported`.

### `network-rules-v1`

| Operation | Plane | Arguments |
| --- | --- | --- |
| `set_network_rules` | call | `rules`: replaces this session's rules |
| `clear_network_rules` | call | — |
| `list_network_rules` | read | — |

A rule has a `match` (`*` wildcards, `/regex/flags`, or part of the URL), an optional `method`, and an `action`: `fail`, `respond`, `modify`, `delay`, `redirect`, `request_headers` or `response_headers`, with that action's fields. `list_network_rules` returns each rule with its `coverage` and its `hits`. Header rewrites, blocking and redirects apply to every request of the tab (`all-requests`). Made-up and modified bodies, holds, and any rule limited by `times` apply only to the page's own `fetch` and XHR (`page-requests`). `hits` is `null` for an `all-requests` rule: the browser applies it, and it cannot count matches without a permission that reads the person's history.

An agent's rules apply only to the tabs its session holds. The side panel shows them, and the person can remove them. They are cleared when the session is released, stopped or taken over, and they are never written into the person's own rule library.

### `recording-v1`

| Operation | Plane | Arguments |
| --- | --- | --- |
| `start_recording` | call | — : records in the session's active tab |
| `stop_recording` | call | — |
| `list_recordings` | read | — |
| `get_recording` | read | `id`, optional `format`: `steps` or `playwright` |

A step uses the agent's own action names (`click`, `fill`, `select`, `press_key`, `navigate`, …, plus `assert`) and carries its target's locators, best first. A secret field's value is never recorded; the step says it is secret, and a generated test reads it from the environment. `get_recording` with `format: "playwright"` also returns a Playwright test the extension generated. Recordings and the generated test are page-derived data, and the tools frame them as untrusted content.

An agent records only in the tabs its session holds. The page and the side panel show that it is recording and offer to stop it, and the recording stops when the session ends.

## Consequences

- A capability ships in either order. Until both sides have it, the agent gets a clear refusal rather than an unknown-operation error.
- Every later capability follows the same shape: a feature name, its operations in `operations` and `operationFeatures`, an optional privileged engine method, and a refusal on every other backend.
- `get_recording` is a read. A recording may be large, and the idempotency ledger never stores it.
- Every new operation changes files the extension pins in `provenance/host-contract.json`. The extension refreshes its vendored `companion-client` and those hashes explicitly when it adopts this revision.

## Rollout

1. The Host change and this ADR land first. They change nothing for an extension that names neither feature.
2. The extension implements `network-rules-v1`, refreshes its vendored contract and starts naming the feature.
3. The extension implements `recording-v1` and names it.
