# `cognia host` output contract

Machine envelopes use `schemaVersion: 1` and `ok: true|false`. Successful calls include
`state: completed|accepted|dry-run`; normal results live in `data`. `cognia host operation` prints
the same envelope with `action: operation`: `accepted` (the operation in `data`) while it runs,
`completed` (its result in `data`) once it succeeded; without `--rpc-command`, `rpcCommand` and the
catalog fields of `meta` are `null`. RPC result bodies are opaque because the current catalog
explicitly reports `outputTyped: false`; never infer fields from an opaque result. A future catalog
may mark a command `outputTyped: true` only when an output schema is actually available.

`categories` output is catalog-derived. Each command has exactly one `category`; each category
names one domain skill. Category IDs are filters and discovery hints, not authorization scopes.

Errors are written to stderr with one of these stable types:

- `validation`
- `configuration`
- `authentication`
- `confirmation`
- `transport`
- `timeout`
- `server`
- `resync`

Exit codes:

| Code | Meaning                                                 |
| ---: | ------------------------------------------------------- |
|    0 | completed, accepted with `--no-wait`, or dry-run        |
|    1 | unclassified internal failure                           |
|    2 | CLI usage, local JSON, schema, or configuration failure |
|    3 | credential or authentication failure                    |
|    4 | confirmation required or declined                       |
|    5 | TLS, connection, transport, or timeout failure          |
|    6 | server RPC failure or event resynchronization required  |

`--format raw` emits only a successful RPC response body. Errors remain structured envelopes on
stderr.

Every flag is checked before anything is sent. A `query_no_match` failure therefore means the call
already ran (`details.state`) but `--query` selected nothing from its output: re-read state rather
than repeating the call.
