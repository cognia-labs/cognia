# @cognia/agent-runtime-kit

Building blocks for Cognia external-agent adapters (ADR-0217):
`BaseProtocolAdapter` (session registry, turn usage folding, permission routing),
the JSON-RPC peer and LF frame decoder, content blocks, orphan-process reclaim,
unsupported-extension errors, permission-mode ranking, history part builders
(`./history`), the outbound-gate prompt check that also decodes text hidden in
base64 blocks (`./prompt-gate`) and the plugin adapter compatibility wrapper
(`./plugin-compat`).

Depends only on `@cognia/agent-contracts`. Machine access comes from the host
through the contract's ports.

```ts
import { BaseProtocolAdapter } from "@cognia/agent-runtime-kit/base-adapter"
import { historyText, historyTool } from "@cognia/agent-runtime-kit/history"
```

Checked by `node scripts/build/pack-test-agent-package.mjs agent-runtime-kit`.
How to build an integration on it:
`docs/content/docs/en/subsystems/agent-packages/adding-an-agent.mdx`.

`./connection-coordinator` serializes shared connection ownership without vendor branches. `./lifecycle/*` contains portable catalog, credential, provider, receipt, install and lifecycle state machines; the Host supplies policy, persistence and machine access. `./thinking-levels` is the shared downward reasoning-level resolver. `./json-rpc-error` is a data-only error entry, re-exported by the peer with constructor identity preserved in both ESM and CJS. `./agent-path` is a separate Node-only executable-search entry and is not exported by the root.

`gateway-task` assembles registered integration recipes through the `agent-contracts/gateway-task` contract. It owns shared argument/environment checks and payload assembly; vendor grammars, slots and projection stay in integration packages. Host ports own model/account admission, facts, leases and private artifact writes.
