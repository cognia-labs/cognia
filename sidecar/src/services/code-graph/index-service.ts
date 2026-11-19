// Session code-graph index handle.
//
// Owns the store + parser lifecycle for one agent session rooted at `root`.
// Lazy: nothing is parsed until the first query (`ensureIndexed`). The on-disk
// `.cognia/codegraph.db` persists across sessions, so a warm start is a
// content-hash delta rather than a full re-parse. `syncStale` keeps the graph
// current between tool calls (and is driven by the optional watcher), surfacing
// a ⚠️ banner for files pending re-index.

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import fastGlob from "fast-glob"

import { loadIgnoreGlobs } from "../../platform/fs/gitignore.ts"
import { isSecretPath } from "../../platform/fs/secret-paths.ts"
import { canonicalisePartial } from "../../platform/fs/paths.ts"
import { isSupportedFile, languageFor } from "./languages/index.ts"
import { extractFile } from "./extractor.ts"
import type { ExtractResult } from "./extractor.ts"
import type { ExtractionPool } from "./extraction-pool.ts"
import { standaloneResourceDir } from "./parser.ts"
import { resolveAll } from "./resolver-pass.ts"
import { createStore } from "./store.ts"
import { startWatcher, type Watcher } from "./watcher.ts"
import * as graph from "./graph.ts"
import type { Reached } from "./graph.ts"
import { buildContext, type CodeContext } from "./context-builder.ts"
import type { CodeGraphStore, FileRecord, GraphNode, StoreStats } from "./store-memory.ts"

const MAX_FILE_BYTES = 5 * 1024 * 1024
const SYNC_THROTTLE_MS = 1500

interface BunCryptoHasher {
  update(bytes: Uint8Array): BunCryptoHasher
  digest(encoding: "hex"): string
}

/** Bun's file and hashing primitives, preferred over node:fs/crypto when whole. */
export interface BunHashRuntime {
  file(path: string): { bytes(): Promise<Uint8Array> }
  CryptoHasher: new (algorithm: string) => BunCryptoHasher
}

export interface IndexServiceOptions {
  root: string
  dbPath?: string
  watch?: boolean
  forceMemory?: boolean
  now?: () => number
  /** Omitted: `globalThis.Bun`. Null: always node:fs/crypto. */
  bunRuntime?: Partial<BunHashRuntime> | null
  /** Experimental: two process-wide extraction threads; omitted defaults to serial. */
  extractionWorkers?: 0 | 2
  /** Pin discovery order for reproducible comparisons; omitted preserves glob order. */
  fileOrder?: "lexical"
  /** Bounded, content-free diagnostics for controlled extraction experiments. */
  onExtraction?: (event: "worker" | "serial" | "fallback") => void
}

export interface IndexStatus extends Omit<StoreStats, "binding"> {
  /** "sqlite?" before the first query opens a configured on-disk store. */
  binding: string
  indexed: boolean
  root: string
  watching: boolean
  pending: number
}

/** The query surface the code-graph tools call. */
export interface CodeGraphIndex {
  ensureIndexed(): Promise<void>
  /** Re-index what changed since the last sync; resolves to the changed-file count. */
  syncStale(): Promise<number>
  search(query: unknown, opts?: { kind?: string; limit?: number }): GraphNode[]
  getNode(idOrQname: string): GraphNode | null
  snippetFor(node: GraphNode | null | undefined): string
  callers(id: string, depth?: number): Reached[]
  callees(id: string, depth?: number): Reached[]
  impact(id: string, depth?: number): Reached[]
  context(query: string, opts?: { maxNodes?: number; namedSeeds?: readonly string[] }): CodeContext
  files(): FileRecord[]
  status(): IndexStatus
  /** ⚠️ banner text for files pending re-index, or "" when current. */
  stalenessBanner(): string
}

export interface IndexService extends CodeGraphIndex {
  root: string
  readonly binding: string
  dispose(): void
}

function isBunHashRuntime(
  candidate: Partial<BunHashRuntime> | null | undefined
): candidate is BunHashRuntime {
  return typeof candidate?.file === "function" && typeof candidate?.CryptoHasher === "function"
}

export function createIndexService(opts: IndexServiceOptions): IndexService {
  const root = path.resolve(opts.root)
  const now = opts.now ?? Date.now
  const runtimeCandidate =
    opts.bunRuntime === undefined
      ? (globalThis as { Bun?: Partial<BunHashRuntime> }).Bun
      : opts.bunRuntime
  const bunRuntime = isBunHashRuntime(runtimeCandidate) ? runtimeCandidate : null
  const dbPath = opts.forceMemory
    ? undefined
    : (opts.dbPath ?? path.join(root, ".cognia", "codegraph.db"))

  let store: CodeGraphStore | null = null
  let initPromise: Promise<void> | null = null
  let watcher: Watcher | null = null
  let lastSyncAt = 0
  let disposed = false
  let syncing: Promise<number> | null = null
  let resolutionPending = false
  let pool: ExtractionPool | null = null
  let workerFailed = false
  let serialTail: Promise<unknown> = Promise.resolve()
  const workersEnabled =
    (opts.extractionWorkers ?? (process.env.COGNIA_CODE_INDEX_WORKERS === "2" ? 2 : 0)) === 2 &&
    // A compiled /$bunfs URL may identify the whole host, not a worker entry.
    !standaloneResourceDir()
  /** files known-changed (from the watcher) awaiting re-index → drives the banner */
  const pendingPaths = new Set<string>()
  const oversizedPaths = new Set<string>()
  let canonicalRoot: string | undefined

  // Discovery and direct snippet reads must never follow a file or directory
  // symlink below the selected root, including a path from a persisted graph.
  function sourcePath(rel: string): string | null {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).some((part) => !part || part.startsWith(".")))
      return null
    try {
      canonicalRoot ??= fs.realpathSync(root)
      const expected = path.join(canonicalRoot, rel)
      if (isSecretPath(expected)) return null
      if (fs.realpathSync(expected) !== expected || !fs.lstatSync(expected).isFile()) return null
      return expected
    } catch {
      return null
    }
  }

  function assertActive(): void {
    if (disposed) throw new Error("code graph index is disposed")
  }

  function observeExtraction(event: "worker" | "serial" | "fallback"): void {
    try {
      opts.onExtraction?.(event)
    } catch {
      /* Diagnostics cannot affect indexing. */
    }
  }

  async function extract(rel: string, source: string): Promise<ExtractResult> {
    assertActive()
    if (workersEnabled && !workerFailed) {
      try {
        if (!pool) {
          const { acquireExtractionPool } = await import("./extraction-pool.ts")
          assertActive()
          pool ??= acquireExtractionPool()
        }
        const result = await pool.extract(rel, source)
        assertActive()
        observeExtraction("worker")
        return result
      } catch {
        assertActive()
        // Only pure extraction is replayed. Stores and resolution never run
        // in workers, and a failed pool stays disabled for this session.
        workerFailed = true
        observeExtraction("fallback")
        pool?.dispose()
        pool = null
      }
    }
    if (!workerFailed) {
      observeExtraction("serial")
      return extractFile(rel, source)
    }
    const result = serialTail.then(() => {
      assertActive()
      observeExtraction("serial")
      return extractFile(rel, source)
    })
    serialTail = result.catch(() => undefined)
    return result
  }

  /** The open store; the query methods run only after `ensureIndexed()`. */
  function openStore(): CodeGraphStore {
    assertActive()
    if (!store) throw new Error("code graph is not indexed; await ensureIndexed() first")
    return store
  }

  function ensureStore(): CodeGraphStore {
    assertActive()
    if (!store) {
      let writableCache = dbPath
      if (writableCache) {
        try {
          const expected = path.join(fs.realpathSync(root), path.relative(root, writableCache))
          for (const suffix of ["", "-wal", "-shm"]) {
            const candidate = writableCache + suffix
            if (
              canonicalisePartial(candidate) !== expected + suffix ||
              fs.lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()
            ) {
              throw new Error("CodeGraph cache must not follow symlinks")
            }
          }
          fs.mkdirSync(path.dirname(writableCache), { recursive: true })
        } catch {
          writableCache = undefined
        }
      }
      store = createStore({ dbPath: writableCache, forceMemory: opts.forceMemory })
    }
    return store
  }

  /** Walk the tree → repo-relative source paths we can extract. */
  async function listSourceFiles(): Promise<string[]> {
    const ignore = await loadIgnoreGlobs(root)
    const all = await fastGlob("**/*", {
      cwd: root,
      onlyFiles: true,
      dot: false,
      followSymbolicLinks: false,
      suppressErrors: true,
      ignore,
    })
    const supported = all.filter((rel) => isSupportedFile(rel))
    return opts.fileOrder === "lexical" ? supported.sort() : supported
  }

  async function hashFile(abs: string): Promise<{ hash: string; size: number; buf: Uint8Array }> {
    if (bunRuntime) {
      const buf = await bunRuntime.file(abs).bytes()
      const hash = new bunRuntime.CryptoHasher("sha1").update(buf).digest("hex")
      return { hash, size: buf.byteLength, buf }
    }
    const buf = await fsp.readFile(abs)
    return { hash: crypto.createHash("sha1").update(buf).digest("hex"), size: buf.length, buf }
  }

  /** Re-extract a single file into the store (or delete it when gone). */
  async function prepareOne(rel: string): Promise<() => boolean> {
    assertActive()
    const abs = sourcePath(rel)
    const existing = ensureStore().getFile(rel)
    const remove = () => {
      if (!existing) return false
      ensureStore().deleteFile(rel)
      return true
    }
    if (!abs) return remove
    let stat: fs.Stats
    try {
      stat = await fsp.stat(abs)
    } catch {
      return remove
    }
    if (stat.size > MAX_FILE_BYTES) {
      oversizedPaths.add(rel)
      return remove
    }
    const { hash, size, buf } = await hashFile(abs)
    assertActive()
    if (size > MAX_FILE_BYTES) {
      oversizedPaths.add(rel)
      return remove
    }
    oversizedPaths.delete(rel)
    if (existing && existing.content_hash === hash) return () => false
    const source = new TextDecoder().decode(buf)
    const result = await extract(rel, source)
    return () => {
      ensureStore().replaceFileGraph(rel, {
        nodes: result.nodes,
        edges: result.edges,
        unresolved: result.unresolved,
        file: {
          path: rel,
          content_hash: hash,
          language: result.language ?? languageFor(rel),
          size,
          modified_at: Math.floor(stat.mtimeMs),
          indexed_at: now(),
          node_count: result.nodes.length - 1,
          errors: result.errors.length ? JSON.stringify(result.errors) : null,
        },
      })
      return true
    }
  }

  async function indexFiles(paths: readonly string[]): Promise<string[]> {
    const changed: string[] = []
    const width = workersEnabled && !workerFailed ? 2 : 1
    for (let i = 0; i < paths.length; i += width) {
      assertActive()
      const batch = paths.slice(i, i + width)
      const prepared = await Promise.all(batch.map(prepareOne))
      assertActive()
      // Worker completion order cannot change store insertion, ranking or
      // ambiguous-reference tie breaks. Commit in the original path order.
      for (const [offset, commit] of prepared.entries()) if (commit()) changed.push(batch[offset]!)
    }
    return changed
  }

  /** Full build (or warm delta): index every changed/new file, drop the gone. */
  async function buildAll(): Promise<void> {
    const current = ensureStore()
    const onDisk = await listSourceFiles()
    const onDiskSet = new Set(onDisk)
    let changed = (await indexFiles(onDisk)).length
    // Drop files removed from disk since the last index.
    for (const f of current.allFiles()) {
      if (!onDiskSet.has(f.path)) {
        current.deleteFile(f.path)
        changed++
      }
    }
    if (changed > 0 || resolutionPending) {
      resolutionPending = true
      resolveAll(current)
      resolutionPending = false
    }
    lastSyncAt = now()
  }

  function maybeStartWatcher(): void {
    assertActive()
    if (!opts.watch || watcher) return
    watcher = startWatcher(root, {
      accept: (abs) => isSupportedFile(abs) || path.basename(abs) === ".gitignore",
      onChange: (absPaths) => {
        for (const abs of absPaths) {
          const rel = toRel(abs)
          if (rel) pendingPaths.add(rel)
        }
      },
    })
  }

  async function ensureIndexed(): Promise<void> {
    assertActive()
    if (!initPromise) {
      initPromise = buildAll()
        .then(() => maybeStartWatcher())
        .catch((err: unknown) => {
          initPromise = null
          throw err
        })
    }
    return initPromise
  }

  /**
   * Re-index files known/likely changed since the last sync. When the watcher
   * is active this processes only its pending set; otherwise it throttled-walks
   * for content-hash deltas.
   */
  async function performSync(): Promise<number> {
    await ensureIndexed()
    let changed = 0
    if (pendingPaths.size > 0 || now() - lastSyncAt >= SYNC_THROTTLE_MS) {
      const pending = [...pendingPaths]
      const fullScan =
        pending.length === 0 || pending.some((rel) => path.basename(rel) === ".gitignore")
      pendingPaths.clear()
      try {
        const onDisk = await listSourceFiles()
        const onDiskSet = new Set(onDisk)
        const updates = await indexFiles(
          fullScan ? onDisk : pending.filter((rel) => onDiskSet.has(rel))
        )
        changed += updates.length
        const current = openStore()
        for (const f of current.allFiles()) {
          if (!onDiskSet.has(f.path)) {
            current.deleteFile(f.path)
            changed++
          }
        }
        for (const rel of oversizedPaths) if (!onDiskSet.has(rel)) oversizedPaths.delete(rel)
        if (fullScan) lastSyncAt = now()
      } catch (error) {
        resolutionPending = true
        for (const rel of pending) pendingPaths.add(rel)
        throw error
      }
    }
    resolutionPending ||= changed > 0
    if (resolutionPending) {
      resolveAll(openStore())
      resolutionPending = false
    }
    return changed
  }

  async function syncStale(): Promise<number> {
    assertActive()
    syncing ??= performSync().finally(() => {
      syncing = null
    })
    return syncing
  }

  /** Verbatim source for a node's line range, cached per file+hash. */
  function getSnippet(node: GraphNode | null | undefined): string {
    if (!node || node.kind === "file") return ""
    const rel = node.file_path
    const lines = readLines(rel)
    if (!lines) return ""
    const start = Math.max(1, node.start_line)
    const end = Math.min(lines.length, node.end_line || start)
    return lines.slice(start - 1, end).join("\n")
  }

  function readLines(rel: string): string[] | null {
    const fileRec = store?.getFile(rel)
    if (!fileRec) return null
    try {
      const abs = sourcePath(rel)
      if (abs && fs.statSync(abs).size <= MAX_FILE_BYTES) {
        const bytes = fs.readFileSync(abs)
        const hash = bunRuntime
          ? new bunRuntime.CryptoHasher("sha1").update(bytes).digest("hex")
          : crypto.createHash("sha1").update(bytes).digest("hex")
        if (bytes.length <= MAX_FILE_BYTES && hash === fileRec.content_hash) {
          return bytes.toString("utf-8").split(/\r?\n/)
        }
      }
    } catch {
      // A file may be replaced between discovery and reading.
    }
    pendingPaths.add(rel)
    return null
  }

  function toRel(abs: string): string | null {
    const rel = path.relative(root, abs)
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null
    return rel.split(path.sep).join("/")
  }

  // ---- query surface (consumed by the code-graph tools) ----

  return {
    root,
    get binding() {
      return store?.binding ?? (dbPath ? "sqlite?" : "memory")
    },

    ensureIndexed,
    syncStale,

    search(query, { kind, limit } = {}) {
      return openStore().searchNodes(query, { kind, limit })
    },
    getNode(idOrQname) {
      return openStore().getNode(idOrQname)
    },
    snippetFor(node) {
      return getSnippet(node)
    },
    callers(id, depth) {
      return graph.callers(openStore(), id, depth)
    },
    callees(id, depth) {
      return graph.callees(openStore(), id, depth)
    },
    impact(id, depth) {
      return graph.impact(openStore(), id, depth)
    },
    context(query, { maxNodes, namedSeeds } = {}) {
      const current = openStore()
      return buildContext(current, query, {
        getSnippet,
        fileCount: current.stats().fileCount,
        maxNodes,
        namedSeeds,
      })
    },
    files() {
      return openStore().allFiles()
    },

    status() {
      const s: Omit<IndexStatus, "indexed" | "root" | "watching" | "pending"> = store
        ? store.stats()
        : {
            fileCount: 0,
            nodeCount: 0,
            edgeCount: 0,
            unresolvedCount: 0,
            languages: {},
            binding: this.binding,
          }
      return {
        indexed: !!initPromise,
        root,
        watching: !!watcher?.supported,
        pending: pendingPaths.size,
        ...s,
      }
    },

    stalenessBanner() {
      const skipped =
        oversizedPaths.size > 0
          ? `⚠️ ${oversizedPaths.size} source file(s) skipped because they exceed 5 MiB.`
          : ""
      if (pendingPaths.size === 0) return skipped
      const sample = [...pendingPaths].slice(0, 5).join(", ")
      return (
        `⚠️ ${pendingPaths.size} file(s) changed on disk and are pending re-index ` +
        `(${sample}${pendingPaths.size > 5 ? ", …" : ""}). Read them directly for current content.` +
        (skipped ? ` ${skipped}` : "")
      )
    },

    dispose() {
      if (disposed) return
      disposed = true
      pool?.dispose()
      pool = null
      try {
        watcher?.dispose()
      } catch {
        /* ignore */
      }
      watcher = null
      try {
        store?.close()
      } catch {
        /* ignore */
      }
      store = null
      initPromise = null
      oversizedPaths.clear()
      pendingPaths.clear()
    },
  }
}
