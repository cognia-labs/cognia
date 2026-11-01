import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createContext,
  detectRuntimeInitializers,
  detectLibStoreImperative,
  detectLibUiImports,
  detectDurableQueues,
  detectCaps,
  detectRunTables,
  discoverDexieTables,
  deriveOwner,
  isSourceFile,
  stripRustTests,
  readExclusions,
  detectTauriDynamicImports,
} from "./counter.mjs"

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), "convergence-counter-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  return createContext(root)
}

function database(table, row = 'status: "pending" | "done"; attempts: number', extra = "") {
  return `import Dexie, { Table } from "dexie";
    interface Row { ${row} }
    class SeparateDB extends Dexie {
      ${table}!: Table<Row, string>;
      constructor() { super("separate"); this.version(1).stores({ ${table}: "id" }); }
    } export const db = new SeparateDB(); ${extra}`
}

test("separate FusionDB discovers fusionOutbox, status and attempts", (t) => {
  const ctx = fixture(t, { "lib/fusion/db.ts": database("fusionOutbox") })
  const [row] = detectDurableQueues(ctx)
  assert.equal(row.table, "fusionOutbox")
  assert.match(row.database, /SeparateDB.*lib\/fusion\/db.ts/)
  assert.deepEqual(row.rowFields, ["attempts", "status"])
  assert.deepEqual(row.signals, ["name", "retry-count", "status"])
})

test("inline imported accountSyncOutbox row is found by name without retry fields", (t) => {
  const ctx = fixture(t, {
    "lib/db.ts": `import Dexie, { Table } from "dexie";
      class AccountDB extends Dexie { accountSyncOutbox!: Table<import("./rows").AccountSyncOutboxRow, string>;
      constructor() { super("a"); this.version(1).stores({accountSyncOutbox: "id"}); } }`,
    "lib/rows.ts": "export interface AccountSyncOutboxRow { id: string; payload: unknown }",
  })
  const [row] = detectDurableQueues(ctx)
  assert.equal(row.table, "accountSyncOutbox")
  assert.deepEqual(row.rowFields, ["id", "payload"])
  assert.deepEqual(row.signals, ["name"])
})

for (const table of ["evalOnlineQueue", "mediaGenerationJobs", "connectorInboundJobs"]) {
  test(`${table} is a queue name signal`, (t) => {
    assert.equal(
      detectDurableQueues(fixture(t, { "lib/db.ts": database(table, "id: string") }))[0].table,
      table
    )
  })
}

test("Dexie schemas, imports, intersections, inheritance, EntityTable and dropped tables", (t) => {
  const ctx = fixture(t, {
    "packages/demo/db.ts": `import Dexie, { EntityTable } from "dexie";
      import { CURRENT_SCHEMA } from "./schema"; import type { Row } from "./rows";
      class OtherDB extends Dexie { jobs!: EntityTable<Row, "id">; droppedQueue!: EntityTable<Row, "id">;
      constructor() { super("a"); this.version(1).stores(CURRENT_SCHEMA); } }`,
    "packages/demo/schema.ts":
      'const BASE = {jobs: "id", droppedQueue: "id"}; export const CURRENT_SCHEMA = {...BASE, droppedQueue: null};',
    "packages/demo/rows.ts":
      'interface Base { id: string; leaseOwner: string }; type Status = "pending" | "done"; interface Extended extends Base { status: Status }; export type Row = Extended & { dueAt: number };',
  })
  const tables = discoverDexieTables(ctx)
  assert.deepEqual(
    tables.map((r) => r.table),
    ["jobs"]
  )
  assert.deepEqual(tables[0].rowFields, ["dueAt", "id", "leaseOwner", "status"])
  assert.deepEqual(detectDurableQueues(ctx)[0].signals, ["name", "due-time", "lease", "status"])
})

test("new Dexie sites collect only their own schemas and unresolved row types stay visible", (t) => {
  const ctx = fixture(t, {
    "lib/db.ts": `import Dexie from "dexie";
    const alpha = new Dexie("alpha"); alpha.version(1).stores({pendingItems: "id"});
    const beta = new Dexie("beta"); beta.version(1).stores({retryJobs: "id", goneQueue: null});`,
  })
  const rows = detectDurableQueues(ctx)
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.rowFields === null))
  assert.match(rows.find((r) => r.table === "retryJobs").database, /beta/)
  assert.match(rows.find((r) => r.table === "pendingItems").database, /alpha/)
})

test("new Dexie intersection assertions discover EntityTable row types", (t) => {
  const ctx = fixture(t, {
    "packages/plugin/db.ts": `import Dexie, {EntityTable} from "dexie";
    interface Row { id: string; nextRetryAt: number }; const db = new Dexie("plugin") as Dexie & {entries: EntityTable<Row, "id">};
    db.version(1).stores({entries: "id"});`,
  })
  const [row] = detectDurableQueues(ctx)
  assert.equal(row.table, "entries")
  assert.deepEqual(row.rowFields, ["id", "nextRetryAt"])
  assert.deepEqual(row.signals, ["due-time"])
})

test("Rust SQLite queues use snake_case signals and ignore test modules", (t) => {
  const ctx = fixture(t, {
    "crates/demo/src/db.rs": `fn init() { let sql = r#"CREATE TABLE IF NOT EXISTS dispatch_jobs (
    id TEXT, attempts INTEGER, next_attempt_at INTEGER, lease_owner TEXT, status TEXT DEFAULT 'pending'
    );"#; }
    #[cfg(test)] mod tests { fn test() { let sql = "CREATE TABLE fake_queue (attempts INTEGER)"; } }`,
  })
  const [row] = detectDurableQueues(ctx)
  assert.equal(row.key, "sqlite:demo/dispatch_jobs")
  assert.deepEqual(row.signals, ["name", "retry-count", "due-time", "lease", "status"])
})

test("SFTP DEFAULT_CONCURRENCY is a cap", (t) => {
  const ctx = fixture(t, {
    "lib/sftp/queue.ts":
      "const DEFAULT_CONCURRENCY = 2; export const value = options.concurrency ?? DEFAULT_CONCURRENCY",
  })
  assert.equal(detectCaps(ctx)[0].symbol, "DEFAULT_CONCURRENCY")
  assert.equal(detectCaps(ctx)[0].value, 2)
})

test("DEFAULT_AI_TURN_LIMIT is a cap", (t) => {
  const [row] = detectCaps(
    fixture(t, { "lib/execution/broker.ts": "export const DEFAULT_AI_TURN_LIMIT = 16" })
  )
  assert.equal(row.key, "lib/execution/broker.ts#DEFAULT_AI_TURN_LIMIT")
})

test("Rust Semaphore construction is a cap outside cfg(test) only", (t) => {
  const ctx = fixture(t, {
    "crates/demo/src/host.rs": `impl PythonHost { fn new() -> Self { Self { semaphore: Semaphore::new(4) } } }
    #[cfg(test)] mod tests { fn nested() { let s = Semaphore::new(99); let brace = "}"; } }`,
  })
  const rows = detectCaps(ctx)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].key, "crates/demo/src/host.rs#PythonHost::new::semaphore/Semaphore::new")
  assert.equal(rows[0].value, 4)
})

test("Rust strings, nested comments and static initializers preserve cap scope", (t) => {
  const ctx = fixture(t, {
    "crates/demo/src/host.rs": `const MESSAGE: &str = r#"the \"host\" worker"#;
    /* outer /* nested */ comment: Semaphore::new(99) */
    static INSTALL_SLOTS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));
    impl Host { fn spawn() { let message = "child has no stdin"; let quote = '\"'; let sem = Semaphore::new(4); } }
    #[cfg(test)] mod tests { fn fake() { let s = Semaphore::new(100); } }`,
  })
  const rows = detectCaps(ctx)
  assert.deepEqual(rows.map((r) => r.symbol).sort(), [
    "Host::spawn::sem/Semaphore::new",
    "INSTALL_SLOTS/Semaphore::new",
  ])
  assert.deepEqual(rows.map((r) => r.value).sort(), [2, 4])
})

function capShapeContext(t) {
  return fixture(t, {
    "lib/caps.ts": `const options = { concurrency: 3, maxParallelCalls: 5 };
      function start(concurrency = 4) { const first = new Semaphore(2); const second = pLimit(6);
        const local = new StartSemaphore(3); return options.maxConcurrentCalls ?? 7; }
      const notASlot = "hello"; const workersCount = 8;`,
    "crates/demo/src/lib.rs": `const MAX_IN_FLIGHT: usize = 12; fn work() { stream.buffer_unordered(3); let o = Options { max_concurrent_calls: 4 }; }`,
  })
}
function assertCapShapes(rows) {
  assert.equal(rows.length, 11)
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.key, r.value])), {
    "crates/demo/src/lib.rs#MAX_IN_FLIGHT": 12,
    "crates/demo/src/lib.rs#work/buffer_unordered": 3,
    "crates/demo/src/lib.rs#work/max_concurrent_calls": 4,
    "lib/caps.ts#options/concurrency": 3,
    "lib/caps.ts#options/maxParallelCalls": 5,
    "lib/caps.ts#start/concurrency": 4,
    "lib/caps.ts#start::first/Semaphore": 2,
    "lib/caps.ts#start::second/pLimit": 6,
    "lib/caps.ts#start::local/StartSemaphore": 3,
    "lib/caps.ts#start/maxConcurrentCalls": 7,
    "lib/caps.ts#workersCount": 8,
  })
}
test("caps cover properties, numeric defaults, local factories and anonymous sites with stable keys", (t) => {
  assertCapShapes(detectCaps(capShapeContext(t)))
})
test("review2 #12 exact shape assertion rejects removal of three repeated-value caps", (t) => {
  const rows = detectCaps(capShapeContext(t))
  const incomplete = rows.filter(
    (r) =>
      ![
        "work/buffer_unordered",
        "work/max_concurrent_calls",
        "start::local/StartSemaphore",
      ].includes(r.symbol)
  )
  assert.throws(() => assertCapShapes(incomplete), assert.AssertionError)
})

function runFixture(t, row, writer) {
  return fixture(t, {
    "lib/db.ts": database("engineRuns", row),
    "lib/db/execution-runs.ts": "export function createExecutionRun() {}",
    "lib/ledger.ts": 'export {createExecutionRun} from "./db/execution-runs"',
    "lib/writer.ts": `import {db} from "./db";${writer}`,
  })
}

test("runId with a writer that never writes the ledger is name-only", (t) => {
  const [row] = detectRunTables(runFixture(t, "runId: string", "db.engineRuns.add(row)"))
  assert.equal(row.reference, "name-only")
  assert.deepEqual(row.writers, ["lib/writer.ts"])
  assert.deepEqual(row.ledgerWriters, [])
})

test("runId with a writer calling createExecutionRun is real", (t) => {
  const [row] = detectRunTables(
    runFixture(
      t,
      "runId: string",
      'import {createExecutionRun} from "./db/execution-runs"; db.table("engineRuns").put(row); createExecutionRun(run)'
    )
  )
  assert.equal(row.reference, "real")
  assert.deepEqual(row.ledgerWriters, ["lib/writer.ts"])
})

test("run rows without a run field have no ledger reference even with a ledger writer", (t) => {
  const [row] = detectRunTables(
    runFixture(t, "id: string", "db.engineRuns.update(id, row); createExecutionRun(run)")
  )
  assert.equal(row.reference, "none")
  assert.equal(row.referenceField, null)
})
test("run reference checks calls, not ledger declarations or strings", (t) => {
  const ctx = runFixture(
    t,
    "runId: string",
    'db.engineRuns.put(row); function createExecutionRun() {}; const example = "createExecutionRun(run)";'
  )
  assert.equal(detectRunTables(ctx)[0].reference, "name-only")
})
test("table collection writes and aliased ledger calls establish a real reference", (t) => {
  const ctx = runFixture(
    t,
    "runId: string",
    'import {createExecutionRun as create} from "./ledger"; db.table("engineRuns").where("id").equals(id).modify(patch); create(run)'
  )
  assert.equal(detectRunTables(ctx)[0].reference, "real")
})

test("status plus lifecycle fields nominates a run table without a run-like name", (t) => {
  const ctx = fixture(t, {
    "lib/db.ts": database("records", 'status: "running" | "done"; completedAt: number'),
  })
  assert.equal(detectRunTables(ctx)[0].table, "records")
})

function initializerFixture(t, extra = {}) {
  return fixture(t, {
    "components/providers/initializers/oauth.tsx": `import { useEffect } from "react";
      import { refreshExpiringOAuthCredentials } from "@/lib/oauth";
      function refresh() { refreshExpiringOAuthCredentials() }
      export function Init() { useEffect(() => { refresh() }, []); return null }`,
    "lib/oauth.ts": "export function refreshExpiringOAuthCredentials() {}",
    ...extra,
  })
}

test("non-install symbol called transitively from useEffect is a runtime candidate", (t) => {
  assert.equal(
    detectRuntimeInitializers(initializerFixture(t))[0].symbol,
    "refreshExpiringOAuthCredentials"
  )
})
test("symbol called from a brain root is dropped", (t) => {
  assert.deepEqual(
    detectRuntimeInitializers(
      initializerFixture(t, {
        "lib/headless/boot.ts":
          'import {refreshExpiringOAuthCredentials} from "@/lib/oauth"; refreshExpiringOAuthCredentials()',
      })
    ),
    []
  )
})
test("reachable module without a symbol call still nominates the symbol", (t) => {
  assert.equal(
    detectRuntimeInitializers(
      initializerFixture(t, {
        "lib/headless/boot.ts": 'import {refreshExpiringOAuthCredentials} from "@/lib/oauth";',
      })
    ).length,
    1
  )
})
test("initializer exclusions drop only named symbols", (t) => {
  const ctx = initializerFixture(t, {
    "scripts/gates/headless-registry-exclusions.json": JSON.stringify({
      initializers: {
        "components/providers/initializers/oauth.tsx": {
          symbols: ["refreshExpiringOAuthCredentials"],
          reason: "Desktop lifecycle intentionally owns this",
        },
      },
    }),
  })
  assert.deepEqual(detectRuntimeInitializers(ctx), [])
})
test("pending headless symbols stay runtime candidates", (t) => {
  const ctx = initializerFixture(t, {
    "scripts/gates/headless-registry-exclusions.json": JSON.stringify({
      pending: {
        "components/providers/initializers/oauth.tsx": {
          symbols: ["refreshExpiringOAuthCredentials"],
        },
      },
    }),
  })
  assert.equal(detectRuntimeInitializers(ctx).length, 1)
})
test("expression callbacks and transitive local calls count, dead local functions do not", (t) => {
  const ctx = fixture(t, {
    "lib/runtime.ts": "export function boot() {}; export function unused() {}",
    "components/providers/initializers/one.tsx": `import {useEffect} from "react"; import {boot, unused} from "@/lib/runtime";
      const two = () => boot(); function one() { two() };
      useEffect(() => one(), []); function dead() {unused()}`,
  })
  assert.deepEqual(
    detectRuntimeInitializers(ctx).map((r) => r.symbol),
    ["boot"]
  )
})
test("dynamic aliases, layout effects, local callback references, and uncalled imports", (t) => {
  const ctx = fixture(t, {
    "lib/runtime.ts": "export function boot() {}; export function unused() {}",
    "components/providers/initializers/dynamic.tsx": `import {useLayoutEffect as layout} from "react";
      import {unused} from "@/lib/runtime";
      const callback = async () => { const {boot: start} = await import("@/lib/runtime"); start() };
      layout(callback, []); function dead() { unused() }`,
  })
  assert.deepEqual(
    detectRuntimeInitializers(ctx).map((r) => r.symbol),
    ["boot"]
  )
})

test("inline awaited dynamic module calls inside effects are candidates", (t) => {
  const ctx = fixture(t, {
    "lib/runtime.ts": "export function refresh() {}",
    "components/providers/initializers/inline.tsx": `import {useEffect} from "react";
      useEffect(() => { void (async () => { (await import("@/lib/runtime")).refresh() })() }, [])`,
  })
  assert.equal(detectRuntimeInitializers(ctx)[0].symbol, "refresh")
})

test("store imperative imports distinguish static, dynamic, relative, and unused", (t) => {
  const ctx = fixture(t, {
    "stores/x.ts": "export const x = {}",
    "lib/static.ts": 'import { x } from "@/stores/x"; x.getState()',
    "lib/nested/dynamic.ts": 'const { x } = await import("../../stores/x"); x.setState({})',
    "lib/require.ts": 'const x = require("@/stores/x"); x.subscribe(fn)',
    "lib/unused.ts": 'import { x } from "@/stores/x"; const a = x',
    "lib/fixture.test.ts": 'import { x } from "@/stores/x"; x.getState()',
  })
  const rows = detectLibStoreImperative(ctx)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.find((r) => r.key === "lib/static.ts").imports, ["static"])
  assert.ok(rows.filter((r) => r.imports.includes("dynamic")).length === 2)
  assert.ok(rows.every((r) => r.stores[0] === "stores/x.ts"))
})

test("UI type-only imports and type exports are flagged; mixed imports are not", (t) => {
  const ctx = fixture(t, {
    "hooks/x.ts": "export interface X {}; export const x = 1",
    "components/x.ts": "export interface Y {}",
    "lib/types.ts": 'import type { X } from "@/hooks/x"; export { type Y } from "../components/x"',
    "lib/mixed.ts": 'import {type X, x} from "@/hooks/x"',
  })
  const rows = detectLibUiImports(ctx)
  assert.equal(rows.find((r) => r.key === "lib/types.ts").typeOnly, true)
  assert.equal(rows.find((r) => r.key === "lib/mixed.ts").typeOnly, false)
})

test("source filter, Rust brace matching and owner defaults", () => {
  for (const file of [
    "lib/a.test.ts",
    "lib/a.spec.js",
    "lib/a.stories.tsx",
    "lib/a.d.ts",
    "lib/__tests__/a.ts",
    "lib/__mocks__/a.ts",
    "lib/fixtures/a.ts",
    "lib/test-utils/a.ts",
    "crates/x/tests/a.rs",
    "crates/x/benches/a.rs",
  ])
    assert.equal(isSourceFile(file), false, file)
  assert.equal(isSourceFile("lib/x.ts"), true)
  assert.doesNotMatch(
    stripRustTests(
      'fn real() {} #[cfg(test)] mod a { fn inner() { let s = r#"}"#; } } fn after() {}'
    ),
    /inner/
  )
  for (const [file, owner] of [
    ["lib/a/x.ts", "lib/a"],
    ["packages/p/src/a.ts", "packages/p"],
    ["crates/c/src/a.rs", "crates/c"],
    ["cli/src/x/a.ts", "cli/src/x"],
    ["sidecar/src/x/a.ts", "sidecar/src/x"],
    ["plugins/p/src/a.ts", "plugins/p"],
    ["src-tauri/src/a.rs", "src-tauri"],
  ])
    assert.equal(deriveOwner(file), owner)
})

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
test(
  "real repository smoke: all known misses remain visible",
  { skip: !existsSync(join(repo, "lib/router-fusion/db/fusion-db.ts")) },
  () => {
    const ctx = createContext(repo)
    const queues = detectDurableQueues(ctx)
    for (const table of [
      "fusionOutbox",
      "accountSyncOutbox",
      "evalOnlineQueue",
      "mediaGenerationJobs",
      "connectorInboundJobs",
    ])
      assert.ok(
        queues.some((r) => r.table === table),
        table
      )
    const caps = detectCaps(ctx)
    for (const file of [
      "crates/cognia-github-runner/src/lib.rs",
      "crates/cognia-sandbox-pool/src/providers/config.rs",
    ])
      assert.ok(
        caps.some((r) => r.file === file),
        file
      )
    assert.ok(caps.some((r) => r.file === "lib/sftp/transfer-queue.ts"))
    assert.ok(caps.some((r) => r.key === "lib/execution/broker.ts#DEFAULT_AI_TURN_LIMIT"))
    assert.ok(
      caps.some(
        (r) =>
          r.file.startsWith("crates/cognia-plugin-runtime/src/python/") &&
          /Semaphore/.test(r.symbol)
      )
    )
    assert.ok(
      detectRuntimeInitializers(ctx).some(
        (r) =>
          r.initializer ===
            "components/providers/initializers/provider-oauth-refresh-initializer.tsx" &&
          r.symbol === "refreshExpiringOAuthCredentials"
      )
    )
  }
)

for (const [shape, expected] of [
  [
    "function write(){db.engineRuns.put(row)} function unrelated(){createExecutionRun(run)}",
    "name-only",
  ],
  [
    "function createExecutionRun(){} function write(){db.engineRuns.put(row);createExecutionRun(run)}",
    "name-only",
  ],
  ["function write(){db.engineRuns.put(row);createExecutionRun(run)}", "real"],
  [
    "function ledger(){createExecutionRun(run)} function write(){db.engineRuns.put(row);ledger()}",
    "real",
  ],
  [
    "function write(){db.engineRuns.put(row);function dead(){createExecutionRun(run)}}",
    "name-only",
  ],
])
  test(`ledger reference is scoped and import-proven: ${shape}`, (t) => {
    const prefix = shape.startsWith("function createExecutionRun")
      ? ""
      : 'import {createExecutionRun} from "./ledger";'
    assert.equal(
      detectRunTables(runFixture(t, "runId: string", prefix + shape))[0].reference,
      expected
    )
  })
test("direct ledger writes require a Dexie database handle", (t) => {
  for (const [receiver, expected] of [
    ["db", "real"],
    ["randomObject", "name-only"],
  ]) {
    const ctx = runFixture(
      t,
      "runId: string",
      `import {db} from './db'; function write(){db.engineRuns.put(row); ${receiver}.executionRuns.put(run)}`
    )
    assert.equal(detectRunTables(ctx)[0].reference, expected)
  }
})
for (const binding of [
  'import IndexedDB from "dexie"',
  'import {Dexie as IndexedDB} from "dexie"',
  'import * as indexed from "dexie"',
]) {
  test(`Dexie aliases in both inventories: ${binding}`, (t) => {
    const name = binding.includes("*") ? "indexed.Dexie" : "IndexedDB"
    const ctx = fixture(t, {
      "lib/db.ts": `${binding}; import {Table} from 'dexie'; interface Row {attempts:number;runId:string;status:'running'|'done';completedAt:number}; class X extends ${name}{ records!:Table<Row,string>; constructor(){super('a');this.version(1).stores({records:'id'})}}`,
    })
    assert.equal(detectDurableQueues(ctx)[0].table, "records")
    assert.equal(detectRunTables(ctx)[0].table, "records")
  })
}
for (const style of ["assertion", "implements", "declare"])
  test(`named imported database table types: ${style}`, (t) => {
    const declaration =
      style === "assertion"
        ? 'const db = new D("a") as D & Tables; db.version(1).stores({records:"id"})'
        : `class DB extends D ${style === "implements" ? "implements Tables" : ""} {${style === "declare" ? 'declare records: Tables["records"];' : ""} constructor(){super('a');this.version(1).stores({records:'id'})}}`
    const ctx = fixture(t, {
      "lib/types.ts": `import {EntityTable} from 'dexie'; export interface Row {attempts:number;runId:string;status:'running'|'done';completedAt:number}; export type Tables = { records:EntityTable<Row,'id'> }`,
      "lib/db.ts": `import D from 'dexie'; import type {Tables} from './types'; ${declaration}`,
    })
    assert.deepEqual(detectDurableQueues(ctx)[0].rowFields, [
      "attempts",
      "completedAt",
      "runId",
      "status",
    ])
    assert.equal(detectRunTables(ctx)[0].table, "records")
  })
test("Rust integer types, static caps and fully qualified semaphore constructors", (t) => {
  const ints = ["u8", "u16", "u32", "u64", "usize", "i32", "i64", "NonZeroUsize"]
  const ctx = fixture(t, {
    "crates/x/src/lib.rs":
      ints
        .map(
          (type, i) =>
            `static MAX_WORKERS_${i}: ${type} = ${type === "NonZeroUsize" ? "NonZeroUsize::new(4).unwrap()" : "4"};`
        )
        .join("\n") + "fn a(){Semaphore::const_new(2);tokio::sync::Semaphore::new(3);}",
  })
  assert.equal(detectCaps(ctx).length, 10)
})
test("cap identities include declaration scope and never occurrence order", (t) => {
  const before = detectCaps(
    fixture(t, {
      "lib/a.ts": "function a(){const MAX_CONCURRENT=2} function b(){const MAX_CONCURRENT=3}",
    })
  )
  const after = detectCaps(
    fixture(t, {
      "lib/a.ts": "function a(){const MAX_CONCURRENT=2} function c(){const MAX_CONCURRENT=3}",
    })
  )
  assert.deepEqual(
    before.map((r) => r.key),
    ["lib/a.ts#a/MAX_CONCURRENT", "lib/a.ts#b/MAX_CONCURRENT"]
  )
  assert.deepEqual(
    after.map((r) => r.key),
    ["lib/a.ts#a/MAX_CONCURRENT", "lib/a.ts#c/MAX_CONCURRENT"]
  )
})
for (const callback of [
  "useEffect(boot, [])",
  "useEffect(()=>setInterval(boot, 10), [])",
  "useEffect(()=>queueMicrotask(boot), [])",
  "useEffect(()=>promise.then(boot), [])",
  "useEffect(()=>subscribe(boot), [])",
])
  test(`imported callback counts: ${callback}`, (t) => {
    const ctx = fixture(t, {
      "lib/runtime.ts": "export function boot(){}",
      "components/providers/direct.tsx": `import {useEffect} from 'react'; import {boot} from '@/lib/runtime'; ${callback}`,
    })
    assert.equal(detectRuntimeInitializers(ctx)[0]?.symbol, "boot")
  })
test("same symbol from two modules has two identities", (t) => {
  const ctx = fixture(t, {
    "lib/a.ts": "export function boot(){}",
    "lib/b.ts": "export function boot(){}",
    "components/providers/two.tsx": `import {useEffect} from 'react';import {boot as a} from '@/lib/a';import {boot as b} from '@/lib/b'; useEffect(()=>{a();b()},[])`,
  })
  assert.deepEqual(
    detectRuntimeInitializers(ctx).map((r) => r.key),
    ["components/providers/two.tsx#boot@lib/a.ts", "components/providers/two.tsx#boot@lib/b.ts"]
  )
})
for (const style of ["static", "import", "require"])
  test(`template module specifiers: ${style}`, (t) => {
    const load = (target, name) =>
      style === "static"
        ? `import {${name}} from \`@/${target}\`;`
        : `const {${name}} = ${style === "import" ? "await import" : "require"}(\`@/${target}\`);`
    const ctx = fixture(t, {
      "stores/x.ts": "export const x={}",
      "hooks/h.ts": "export const h=1",
      "lib/runtime.ts": "export function boot(){}",
      "lib/a.ts": load("stores/x", "x") + "x.getState()",
      "lib/b.ts": load("hooks/h", "h"),
      "components/providers/initializers/a.tsx": `import {useEffect} from 'react';${load("lib/runtime", "boot")}useEffect(boot,[])`,
    })
    assert.equal(detectLibStoreImperative(ctx).length, 1)
    assert.equal(detectLibUiImports(ctx).length, 1)
    assert.equal(detectRuntimeInitializers(ctx).length, 1)
  })
test("explicit roots run effects; headless exclusions do not apply to other roots", (t) => {
  const file = "components/account/sync/account-sync-host.tsx"
  const ctx = fixture(t, {
    "lib/runtime.ts": "export function boot(){}",
    [file]: `import {useEffect} from 'react';import {boot} from '@/lib/runtime';useEffect(boot,[])`,
    "scripts/gates/convergence/runtime-roots.json": JSON.stringify({
      roots: [{ file, reason: "Owns the account synchronization lifecycle" }],
      notRuntime: [],
    }),
    "scripts/gates/headless-registry-exclusions.json": JSON.stringify({
      initializers: {
        [file]: { symbols: ["boot"], reason: "Must not silence a non-initializer host" },
      },
    }),
  })
  assert.equal(detectRuntimeInitializers(ctx).length, 1)
})

test("a brain call to the same symbol in another module does not hide debt", (t) => {
  const ctx = fixture(t, {
    "lib/a.ts": "export function boot(){}",
    "lib/b.ts": "export function boot(){}",
    "lib/headless/boot.ts": 'import {boot} from "../a";boot()',
    "components/providers/a.tsx":
      'import {useEffect} from "react";import {boot} from "@/lib/b";useEffect(boot,[])',
  })
  assert.equal(detectRuntimeInitializers(ctx)[0].module, "lib/b.ts")
})
test("imported constants used as values are not callback invocations", (t) => {
  const ctx = fixture(t, {
    "lib/a.ts": 'export const COMMAND="open"; export function subscribe(){}',
    "components/providers/a.tsx":
      'import {useEffect} from "react";import {COMMAND,subscribe} from "@/lib/a";useEffect(()=>subscribe(COMMAND,()=>{}),[])',
  })
  assert.deepEqual(
    detectRuntimeInitializers(ctx).map((r) => r.symbol),
    ["subscribe"]
  )
})
test("a caller may combine a table-writing helper and the imported ledger writer", (t) => {
  const ctx = runFixture(
    t,
    "runId:string",
    'import {createExecutionRun} from "./ledger";function writeTable(){db.engineRuns.put(row)} function write(){writeTable();createExecutionRun(run)}'
  )
  assert.equal(detectRunTables(ctx)[0].reference, "real")
})

test("explicit roots include effects owned by invoked custom hooks", (t) => {
  const file = "components/account/sync/account-sync-host.tsx"
  const ctx = fixture(t, {
    [file]:
      'import {useWorker} from "@/hooks/use-worker"; export function Host(){useWorker();return null}',
    "hooks/use-worker.ts":
      'import {useEffect} from "react";import {boot} from "@/lib/worker";export function useWorker(){useEffect(boot,[])}',
    "lib/worker.ts": "export function boot(){}",
    "scripts/gates/convergence/runtime-roots.json": JSON.stringify({
      roots: [{ file, reason: "Owns account worker through an invoked custom hook" }],
      notRuntime: [],
    }),
  })
  assert.equal(detectRuntimeInitializers(ctx)[0].initializer, file)
  assert.equal(detectRuntimeInitializers(ctx)[0].effectFile, "hooks/use-worker.ts")
})
test("dynamic brain imports and templates retain call provenance", (t) => {
  const ctx = initializerFixture(t, {
    "lib/headless/boot.ts":
      "async function start(){const [{refreshExpiringOAuthCredentials:refresh}] = await Promise.all([import(`@/lib/oauth`)]);refresh()}start()",
  })
  assert.deepEqual(detectRuntimeInitializers(ctx), [])
})

test("store-owned runtime installers remain candidates", (t) => {
  const ctx = fixture(t, {
    "stores/watcher.ts": "export function installWatcher(){}",
    "components/providers/initializers/watch.tsx":
      'import {useEffect} from "react";import {installWatcher} from "@/stores/watcher";useEffect(installWatcher,[])',
  })
  assert.equal(detectRuntimeInitializers(ctx)[0].module, "stores/watcher.ts")
})

test("a shadowed ledger import cannot establish a real reference", (t) => {
  const ctx = runFixture(
    t,
    "runId:string",
    'import {createExecutionRun} from "./ledger";function write(createExecutionRun){db.engineRuns.put(row);createExecutionRun(run)}'
  )
  assert.equal(detectRunTables(ctx)[0].reference, "name-only")
})
for (const load of ["await import", "require"])
  test(`template ledger provenance through ${load}`, (t) => {
    const ctx = runFixture(
      t,
      "runId:string",
      `const {createExecutionRun:create}=${load}(\`./ledger\`);function write(){db.engineRuns.put(row);create(run)}`
    )
    assert.equal(detectRunTables(ctx)[0].reference, "real")
  })

test("Dexie handles are lexically scoped and namespace ledger imports cannot be shadowed", (t) => {
  for (const writer of [
    'import Dexie from "dexie";function unrelated(){const fake=new Dexie("x")}function write(fake){db.engineRuns.put(row);fake.executionRuns.put(run)}',
    'import * as ledger from "./ledger";function write(ledger){db.engineRuns.put(row);ledger.createExecutionRun(run)}',
  ])
    assert.equal(detectRunTables(runFixture(t, "runId:string", writer))[0].reference, "name-only")
})
test("same-file method calls can establish a scoped ledger link", (t) => {
  const ctx = runFixture(
    t,
    "runId:string",
    'import {createExecutionRun} from "./ledger";class Writer{ledger(){createExecutionRun(run)}write(){db.engineRuns.put(row);this.ledger()}}'
  )
  assert.equal(detectRunTables(ctx)[0].reference, "real")
})

test("Rust cap declarations remain nominated when their integer value is an expression", (t) => {
  const rows = detectCaps(
    fixture(t, {
      "crates/x/src/lib.rs": "const MAX_WORKERS:u32=DEFAULT_WORKERS;static MAX_PARALLEL:i64=2 * 4;",
    })
  )
  assert.equal(rows.length, 2)
  assert.ok(rows.every((r) => r.value === null))
})

test("ledger re-exports resolve the original const writer symbol", (t) => {
  const ctx = fixture(t, {
    "lib/db.ts": database("engineRuns", "runId:string"),
    "lib/db/execution-runs.ts": "export const createExecutionRun=()=>{}",
    "lib/barrel.ts": 'export {createExecutionRun as record} from "./db/execution-runs"',
    "lib/writer.ts":
      'import {db} from "./db";import {record as writeRun} from "./barrel";function write(){db.engineRuns.put(row);writeRun(run)}',
  })
  assert.equal(detectRunTables(ctx)[0].reference, "real")
})

for (const version of [1, 2])
  test(`normalizes v${version} headless decisions without swallowing pending debt`, (t) => {
    const ctx = fixture(t, {
      "scripts/gates/headless-registry-exclusions.json": JSON.stringify({
        version,
        initializers: {
          "components/providers/initializers/a.tsx": {
            symbols: ["skip"],
            reason: "Renderer navigation is client bound.",
          },
        },
        uiOnly: { "@/lib/ui": { reason: "Every export controls renderer layout." } },
        pendingCeiling: 1,
        pending: {
          "components/providers/initializers/b.tsx": {
            symbols: ["boot"],
            phase: "phase 1",
            reason: "Account maintenance has no brain owner.",
          },
        },
      }),
    })
    const decisions = readExclusions(ctx)
    assert.deepEqual([...decisions.excluded.values()][0].symbols, new Set(["skip"]))
    assert.equal(decisions.uiOnly.get("@/lib/ui").symbols, "*")
    assert.equal([...decisions.pending.values()][0].phase, "phase 1")
    assert.equal(decisions.pendingCeiling, 1)
  })

test("effect-local Promise.all module slots and referenced local callbacks remain reachable", (t) => {
  const ctx = fixture(t, {
    "lib/a.ts": "export function boot(){}; export function deps(){}",
    "components/providers/initializers/a.tsx": `import {useEffect} from "react";
      async function run(){const [a]=await Promise.all([import(\`@/lib/a\`)]);a.boot(a.deps())}
      export function A(){useEffect(()=>{subscribe(run)},[])}`,
  })
  assert.deepEqual(
    detectRuntimeInitializers(ctx)
      .map((r) => r.symbol)
      .sort(),
    ["boot", "deps"]
  )
})

for (const [name, source, expected, staticAlsoInClassA = false] of [
  ["dynamic", 'const a=import("@tauri-apps/api/core")', true],
  ["template", "const a=import(`@tauri-apps/api/event`)", true],
  ["require", "const a=require(`@tauri-apps/api/core`)", true],
  ["type query", 'type A=typeof import("@tauri-apps/api/core")', false],
  ["static", 'import {invoke} from "@tauri-apps/api/core";invoke("x")', false],
  [
    "both",
    'import {invoke} from "@tauri-apps/api/core";const a=import("@tauri-apps/api/event")',
    true,
    true,
  ],
  [
    "type static plus dynamic",
    'import type {Event} from "@tauri-apps/api/event";const a=import("@tauri-apps/api/event")',
    true,
  ],
])
  test(`dynamic Tauri inventory: ${name}`, (t) => {
    const rows = detectTauriDynamicImports(fixture(t, { "lib/a.ts": source }))
    assert.equal(rows.length, Number(expected))
    if (expected) {
      assert.equal(rows[0].key, "lib/a.ts")
      assert.equal(rows[0].staticAlsoInClassA, staticAlsoInClassA)
    }
  })
test("dynamic Tauri inventory reuses class A seam owners and source domain", (t) => {
  const source = 'void import("@tauri-apps/api/core")'
  assert.deepEqual(
    detectTauriDynamicImports(
      fixture(t, {
        "lib/tauri/transport-tauri.ts": source,
        "lib/connectors/tauri/commands.ts": source,
        "lib/connectors/events.ts": source,
        "cli/src/a.ts": source,
        "lib/a.test.ts": source,
      })
    ),
    []
  )
})

for (const type of [
  "RecordTable",
  "Table<Row,string> & {marker?:true}",
  "AliasedTable<Row,string>",
])
  test(`review2 #3 resolves wrapped table member ${type}`, (t) => {
    const ctx = fixture(t, {
      "lib/db.ts": `import Dexie,{Table,Table as AliasedTable} from "dexie";
    interface Row{attempts:number;status:"pending"|"done";completedAt:number};type RecordTable=Table<Row,string>;
    class DB extends Dexie{records!:${type};constructor(){super("x");this.version(1).stores({records:"id"})}}`,
    })
    for (const detector of [detectDurableQueues, detectRunTables]) {
      const [row] = detector(ctx)
      assert.ok(row)
      assert.equal(row.table, "records")
      assert.deepEqual(row.rowFields, ["attempts", "completedAt", "status"])
    }
  })
for (const callback of [
  "useEffect(runtime.boot,[])",
  "useEffect(()=>queueMicrotask(runtime.boot),[])",
])
  test(`review2 #4 namespace callback ${callback}`, (t) => {
    const ctx = fixture(t, {
      "lib/runtime.ts": "export function boot(){}",
      "components/providers/initializers/a.tsx": `import {useEffect} from "react";import * as runtime from "@/lib/runtime";${callback}`,
    })
    assert.deepEqual(
      detectRuntimeInitializers(ctx).map((r) => r.key),
      ["components/providers/initializers/a.tsx#boot@lib/runtime.ts"]
    )
  })
test("review2 #5 every writer entry must reach the ledger", (t) => {
  const ctx = fixture(t, {
    "lib/db.ts": database("engineRuns", "runId:string"),
    "lib/db/execution-runs.ts": "export function createExecutionRun(){}",
    "lib/writer.ts":
      'import {db} from "./db";import {createExecutionRun} from "./db/execution-runs";export function good(){db.engineRuns.put(row);createExecutionRun(run)}export function bad(){db.engineRuns.put(row)}',
  })
  const [row] = detectRunTables(ctx)
  assert.equal(row.reference, "name-only")
  assert.deepEqual(row.unlinkedWriters, ["lib/writer.ts#bad"])
})
test("review2 #5 same-named tables on different databases do not share ledger proof", (t) => {
  const ctx = fixture(t, {
    "lib/a.ts": database("engineRuns", "runId:string"),
    "lib/b.ts": database("engineRuns", "runId:string"),
    "lib/db/execution-runs.ts": "export function createExecutionRun(){}",
    "lib/writer.ts":
      'import {db as a} from "./a";import {db as b} from "./b";import {createExecutionRun} from "./db/execution-runs";export function writeA(){a.engineRuns.put(row)}export function writeB(){b.engineRuns.put(row);createExecutionRun(run)}',
  })
  const rows = detectRunTables(ctx)
  assert.equal(rows.find((r) => r.file === "lib/a.ts").reference, "name-only")
  assert.equal(rows.find((r) => r.file === "lib/b.ts").reference, "real")
})
for (const source of ["const MAX_WORKERS=2*2;", "const config={maxConcurrentCalls:2*2};"])
  test(`review2 #6 nonliteral TS cap stays nominated: ${source}`, (t) => {
    const rows = detectCaps(fixture(t, { "lib/a.ts": source }))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].value, null)
  })
for (const integer of [
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
])
  test(`review2 #7 Rust ${integer} cap has a concrete stable identity`, (t) => {
    const [row] = detectCaps(
      fixture(t, { "crates/a/src/lib.rs": `const MAX_WORKERS:${integer}=4;` })
    )
    assert.equal(row?.key, "crates/a/src/lib.rs#MAX_WORKERS")
    assert.equal(row.value, 4)
  })
test("review2 #2 fingerprints ignore unrelated lines and bind call arguments", (t) => {
  const caps = (source) => detectCaps(fixture(t, { "lib/a.ts": source }))[0].evidence
  assert.match(caps("const MAX_WORKERS=4;") ?? "", /^[a-f0-9]{16}$/)
  assert.equal(
    caps("const MAX_WORKERS=4;"),
    caps("const unrelated=99;\nconst MAX_WORKERS=4;\nfunction other(){}")
  )
  const runtime = (arg) =>
    detectRuntimeInitializers(
      fixture(t, {
        "lib/a.ts": "export function boot(x){}",
        "components/providers/initializers/a.tsx": `import {useEffect} from "react";import {boot} from "@/lib/a";useEffect(()=>boot(${arg}),[])`,
      })
    )[0].evidence
  assert.notEqual(runtime("1"), runtime("2"))
})
test("review2 #2 table evidence changes with writer and consumer function identities", (t) => {
  const row = (writer, consumer) =>
    detectDurableQueues(
      fixture(t, {
        "lib/db.ts": database("jobs"),
        "lib/writer.ts": `import {db} from "./db";function ${writer}(){db.jobs.put(row)}function ${consumer}(){return db.jobs.toArray()}`,
      })
    )[0]
  assert.match(row("save", "drain").evidence ?? "", /^[a-f0-9]{16}$/)
  assert.notEqual(row("save", "drain").evidence, row("save", "claim").evidence)
  assert.notEqual(row("save", "drain").evidence, row("put", "drain").evidence)
})

test("review2 #6 optional cap declarations without initializers do not crash discovery", (t) => {
  const ctx = fixture(t, {
    "lib/a.ts": "class Limits { maxConcurrentCalls?:number }; function run(concurrency?:number){}",
  })
  assert.deepEqual(detectCaps(ctx), [])
})

test("review2 #6 worker objects and prompt slots are not numeric cap expressions", (t) => {
  const ctx = fixture(t, {
    "lib/a.ts":
      "const worker=pool.get(id);const slots=await listPromptSlots();const workerPolicy=session.workerHandoff;const MAX_WORKERS=readConfiguredLimit();",
  })
  assert.deepEqual(
    detectCaps(ctx).map((r) => [r.key, r.value]),
    [["lib/a.ts#MAX_WORKERS", null]]
  )
})

test("review2 #3 default Dexie namespace Table resolves its declared row", (t) => {
  const ctx = fixture(t, {
    "lib/db.ts":
      'import IndexedDB from "dexie";interface Row{attempts:number};class DB extends IndexedDB{records!:IndexedDB.Table<Row,string>;constructor(){super("x");this.version(1).stores({records:"id"})}}',
  })
  assert.deepEqual(detectDurableQueues(ctx)[0].rowFields, ["attempts"])
})

test("review2 #2 callback evidence includes its scheduler expression", (t) => {
  const evidence = (delay) =>
    detectRuntimeInitializers(
      fixture(t, {
        "lib/a.ts": "export function boot(){}",
        "components/providers/initializers/a.tsx": `import {useEffect} from "react";import * as runtime from "@/lib/a";useEffect(()=>setInterval(runtime.boot,${delay}),[])`,
      })
    )[0].evidence
  assert.notEqual(evidence(100), evidence(200))
})
test("review2 #2 Rust constant evidence retains source tokens masked for discovery", (t) => {
  const evidence = (value) =>
    detectCaps(
      fixture(t, { "crates/a/src/lib.rs": `const MAX_WORKERS:usize=read_limit("${value}");` })
    )[0].evidence
  assert.notEqual(evidence("small"), evidence("large"))
})

for (const callback of [
  "useEffect((runtime.boot),[])",
  "useEffect(((runtime.boot as Callback)!),[])",
  "useEffect(()=>queueMicrotask((runtime.boot)),[])",
  "useEffect(()=>setInterval((runtime.boot satisfies Callback)!,10),[])",
  "useEffect(()=> (runtime.boot)(),[])",
])
  test("review3 #4 wrapped runtime callback " + callback, (t) => {
    const ctx = fixture(t, {
      "lib/runtime.ts": "export function boot(){}",
      "components/providers/initializers/a.tsx": `import {useEffect} from "react";import * as runtime from "@/lib/runtime";type Callback=()=>void;${callback}`,
    })
    assert.deepEqual(
      detectRuntimeInitializers(ctx).map((r) => r.symbol),
      ["boot"]
    )
  })

for (const source of [
  "const MAX_WORKERS=limits['workers'];",
  "const options={maxConcurrentCalls:limits['calls']};",
  "const MAX_WORKERS=((limits['workers']! as number) satisfies number);",
])
  test("review3 #5 element-access cap " + source, (t) => {
    const rows = detectCaps(fixture(t, { "lib/caps.ts": source }))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].value, null)
  })

for (const exposure of [
  "export {bad};",
  "export {bad as exposed};",
  "export default bad;",
  "export {bad as default};",
])
  test("review3 #2 every exported writer entry " + exposure, (t) => {
    const ctx = fixture(t, {
      "lib/db.ts": database("engineRuns", "runId:string"),
      "lib/db/execution-runs.ts": "export function createExecutionRun(){}",
      "lib/writer.ts": `import {db} from './db';import {createExecutionRun} from './db/execution-runs';function bad(){db.engineRuns.put(row)}export function good(){bad();createExecutionRun(run)}${exposure}`,
    })
    const [r] = detectRunTables(ctx)
    assert.equal(r.reference, "name-only")
    assert.deepEqual(r.unlinkedWriters, ["lib/writer.ts#bad"])
  })
test("review3 #2 re-exported writer is independently callable", (t) => {
  const ctx = fixture(t, {
    "lib/db.ts": database("engineRuns", "runId:string"),
    "lib/db/execution-runs.ts": "export function createExecutionRun(){}",
    "lib/writer.ts":
      "import {db} from './db';import {createExecutionRun} from './db/execution-runs';function bad(){db.engineRuns.put(row)}export function good(){bad();createExecutionRun(run)}",
    "lib/public.ts": "export {bad as externalWriter} from './writer';",
  })
  assert.equal(detectRunTables(ctx)[0].reference, "name-only")
})
test("review3 #2 default function and re-exported default writer retain proof", (t) => {
  for (const declaration of [
    "export default function bad(){db.engineRuns.put(row)}",
    "export default function(){db.engineRuns.put(row)}",
  ]) {
    const ctx = fixture(t, {
      "lib/db.ts": database("engineRuns", "runId:string"),
      "lib/db/execution-runs.ts": "export function createExecutionRun(){}",
      "lib/writer.ts": `import {db} from './db';import {createExecutionRun} from './db/execution-runs';${declaration}`,
      "lib/public.ts": "export {default as externalWriter} from './writer';",
    })
    assert.equal(detectRunTables(ctx)[0].reference, "name-only")
  }
})

for (const use of ["MAX_WORKERS", "(MAX_WORKERS! as number)"])
  test("review3 #1 cap evidence follows consuming call " + use, (t) => {
    const evidence = (consumer) =>
      detectCaps(fixture(t, { "lib/caps.ts": `const MAX_WORKERS=4;${consumer}(${use});` }))[0]
        .evidence
    assert.notEqual(evidence("nativePool"), evidence("businessAdmission"))
  })
for (const shape of ["property", "declarators"])
  test("review3 #6 cap evidence ignores sibling " + shape, (t) => {
    const evidence = (label) =>
      detectCaps(
        fixture(t, {
          "lib/caps.ts":
            shape === "property"
              ? `const options={maxConcurrentCalls:4,label:'${label}'};nativePool(options);`
              : `const MAX_WORKERS=4,label='${label}';nativePool(MAX_WORKERS);`,
        })
      )[0].evidence
    assert.equal(evidence("before"), evidence("after"))
  })
test("review3 #1 and #6 Rust cap evidence binds use but ignores sibling fields", (t) => {
  const evidence = (consumer, label) =>
    detectCaps(
      fixture(t, {
        "crates/a/src/lib.rs": `const MAX_WORKERS:usize=4;fn run(){${consumer}(MAX_WORKERS);}impl Default for Limits{fn default()->Self{Self{max_concurrent_calls:4,label:"${label}"}}}`,
      })
    )
  assert.notEqual(
    evidence("native_pool", "before").find((r) => r.symbol === "MAX_WORKERS").evidence,
    evidence("business_admission", "before").find((r) => r.symbol === "MAX_WORKERS").evidence
  )
  assert.equal(
    evidence("native_pool", "before").find((r) => r.symbol.includes("max_concurrent_calls"))
      .evidence,
    evidence("native_pool", "after").find((r) => r.symbol.includes("max_concurrent_calls")).evidence
  )
})

for (const init of ["let slots=Semaphore::new(4);", "let slots=Arc::new(Semaphore::new(4));"])
  test("review3 #1 Rust limiter binding consumers " + init, (t) => {
    const evidence = (consumer) =>
      detectCaps(fixture(t, { "crates/a/src/lib.rs": `fn run(){${init}${consumer}(slots);}` }))[0]
        .evidence
    assert.notEqual(evidence("native_pool"), evidence("business_admission"))
  })
for (const kind of ["durable", "run"])
  test("review3 #1 lifecycle behavior changes invalidate " + kind, (t) => {
    const detect = kind === "durable" ? detectDurableQueues : detectRunTables
    const evidence = (attempts, status, extra = "") =>
      detect(
        fixture(t, {
          "lib/db.ts": database("jobs"),
          "lib/drain.ts": `import {db} from './db';export async function drain(){const row=await db.jobs.get(id);if(row.attempts<${attempts}){await db.jobs.update(id,{status:'${status}',nextAttemptAt:row.nextAttemptAt+500});}${extra}}`,
        })
      )[0].evidence
    assert.notEqual(evidence(3, "done"), evidence(99, "done"))
    assert.notEqual(evidence(3, "done"), evidence(3, "deadletter"))
    assert.equal(evidence(3, "done"), evidence(3, "done", 'const unrelatedLabel="new";'))
  })
test("review3 #1 lifecycle evidence follows destructured retry aliases", (t) => {
  const evidence = (limit) =>
    detectDurableQueues(
      fixture(t, {
        "lib/db.ts": database("jobs"),
        "lib/drain.ts": `import {db} from './db';export async function drain(){const row=await db.jobs.get(id);const {attempts:tries}=row;if(tries<${limit})await db.jobs.update(id,{status:'done'});}`,
      })
    )[0].evidence
  assert.notEqual(evidence(3), evidence(99))
})

test("review3 #1 lifecycle evidence ignores unrelated logging in a writer", (t) => {
  const evidence = (label) =>
    detectDurableQueues(
      fixture(t, {
        "lib/db.ts": database("jobs"),
        "lib/drain.ts": `import {db} from './db';export function drain(){db.jobs.update(id,{status:'done'});console.error('${label}');}`,
      })
    )[0].evidence
  assert.equal(evidence("before"), evidence("after"))
})
test("review3 #1 SQLite lifecycle evidence binds retry SQL and ignores unrelated statements", (t) => {
  const evidence = (attempt, status, extra = "") =>
    detectDurableQueues(
      fixture(t, {
        "crates/demo/src/store.rs": `fn schema(){conn.execute_batch("CREATE TABLE jobs (id TEXT, status TEXT, attempts INTEGER);");}fn drain(){conn.execute("UPDATE jobs SET status='${status}' WHERE attempts<${attempt}");${extra}}`,
      })
    )[0].evidence
  assert.notEqual(evidence(3, "done"), evidence(99, "done"))
  assert.notEqual(evidence(3, "done"), evidence(3, "deadletter"))
  assert.equal(evidence(3, "done"), evidence(3, "done", 'let label="new";'))
})
test("review3 #4 wrapped scheduler keeps its full call evidence", (t) => {
  const evidence = (delay) =>
    detectRuntimeInitializers(
      fixture(t, {
        "lib/runtime.ts": "export function boot(){}",
        "components/providers/initializers/a.tsx": `import {useEffect} from 'react';import * as runtime from '@/lib/runtime';useEffect(()=>setInterval(((runtime.boot as Callback)!),${delay}),[])`,
      })
    )[0].evidence
  assert.notEqual(evidence(10), evidence(20))
})
