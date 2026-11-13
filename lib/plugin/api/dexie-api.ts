/**
 * Plugin Dexie API — namespace-enforcing wrapper around Dexie.
 *
 * Plugins receive this via `ctx.dexie`. Every `table()` call is intercepted to
 * prepend the plugin's own namespace prefix, so a plugin can never access
 * another plugin's tables or the core CogniaDB tables.
 */

import type Dexie from "dexie"
import { toNamespacedTableName, fromNamespacedTableName } from "@/lib/plugin/dexie/namespace"

export interface PluginDexieAPI {
  /**
   * Returns a Dexie Table scoped to this plugin.
   *
   * `name` is the logical table name (no prefix) or an already-namespaced
   * `<pluginId>:<name>`. Throws when the name resolves outside this plugin's
   * namespace. NOTE: this validates the NAMESPACE only — whether the table
   * actually exists (was declared in `manifest.dexie.tables` and applied to
   * the schema) is Dexie's own lookup error at call time (W6.6).
   */
  table<T, K = unknown>(name: string): Dexie.Table<T, K>

  /**
   * Returns a namespace-enforcing view of the Dexie instance for advanced
   * queries and transactions. `table(...)` and `transaction(...)` validate
   * every table name against this plugin's `<pluginId>:` namespace — a bare
   * name is auto-prefixed, a name already prefixed to this plugin passes
   * through, and a name prefixed to a *different* plugin (or a core CogniaDB
   * table) is rejected. This closes the isolation hole where the raw instance
   * let a plugin reach `db.table("characters")` or another plugin's tables.
   */
  rawDb(): Dexie
}

/**
 * Factory used by createPluginContext to build the ctx.dexie object.
 *
 * @param db      - The shared CogniaDB (or any Dexie) instance.
 * @param pluginId - The plugin's id. Used to build and validate namespace prefixes.
 */
export function createDexieAPI(db: Dexie, pluginId: string): PluginDexieAPI {
  // Resolve a caller-supplied table name to this plugin's namespace:
  //  - bare name        → `<pluginId>:<name>`
  //  - `<pluginId>:x`   → passes through (already correctly namespaced)
  //  - `<other>:x`      → rejected (cross-plugin / core-table access)
  const resolveTableName = (name: string): string => {
    if (!name) {
      throw new Error(
        `Plugin "${pluginId}" attempted to access table "${name}" which is not in its namespace`
      )
    }
    const parsed = fromNamespacedTableName(name)
    if (parsed) {
      if (parsed.pluginId !== pluginId) {
        throw new Error(
          `Plugin "${pluginId}" attempted to access table "${name}" which is not in its namespace`
        )
      }
      return name
    }
    return toNamespacedTableName(pluginId, name)
  }

  const handles = new WeakMap<object, object>()
  const originals = new WeakMap<object, object>()
  const protect = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value
    if (value === db) return view
    if (typeof (value as PromiseLike<unknown>).then === "function")
      return Promise.resolve(value).then(protect)
    if (Array.isArray(value)) return value.map(protect)
    if (
      value instanceof Date ||
      value instanceof Blob ||
      ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer
    )
      return value
    const prototype = Object.getPrototypeOf(value)
    // Stored plugin rows stay ordinary structured-cloneable data. Only live
    // Dexie handles need a facade (including WhereClause, which has no .db).
    if (prototype === Object.prototype || prototype === null) return value
    const existing = handles.get(value)
    if (existing) return existing
    const read = (key: PropertyKey): unknown => {
      if (key === "db") return view
      if (
        key === "constructor" ||
        key === "core" ||
        (typeof key === "string" && key.startsWith("_"))
      )
        return undefined
      const member: unknown = Reflect.get(value, key)
      if (typeof member !== "function") return protect(member)
      return (...args: unknown[]) =>
        protect(
          Reflect.apply(
            member,
            value,
            args.map((arg) =>
              typeof arg === "function"
                ? (...items: unknown[]) => Reflect.apply(arg, undefined, items.map(protect))
                : arg && typeof arg === "object"
                  ? (originals.get(arg) ?? arg)
                  : arg
            )
          )
        )
    }
    const safe = new Proxy(
      {},
      {
        get: (_target, key) => read(key),
        ownKeys: () =>
          Reflect.ownKeys(value).filter((key) => !(typeof key === "string" && key.startsWith("_"))),
        getOwnPropertyDescriptor: (_target, key) =>
          Reflect.has(value, key)
            ? { configurable: true, enumerable: true, get: () => read(key) }
            : undefined,
        getPrototypeOf: () => null,
      }
    )
    handles.set(value, safe)
    originals.set(safe, value)
    return safe
  }
  const table = <T, K = unknown>(name: string): Dexie.Table<T, K> =>
    protect(db.table<T, K>(resolveTableName(name))) as Dexie.Table<T, K>
  const transaction = (...args: unknown[]): unknown => {
    const spec = (value: unknown): unknown => {
      if (typeof value === "string") return resolveTableName(value)
      if (Array.isArray(value)) return value.map(spec)
      const original =
        value && typeof value === "object" ? (originals.get(value) ?? value) : undefined
      if (
        original &&
        "name" in original &&
        typeof original.name === "string" &&
        original.name === resolveTableName(original.name)
      )
        return original
      throw new Error("Transaction table is not in its namespace")
    }
    const resolved = args.map((arg, index) =>
      index === 0
        ? arg
        : typeof arg === "function"
          ? (...items: unknown[]) => Reflect.apply(arg, undefined, items.map(protect))
          : spec(arg)
    )
    return protect(Reflect.apply(db.transaction, db, resolved))
  }
  // A fresh facade target contains no Host database properties or descriptors.
  const read = (key: PropertyKey): unknown => {
    if (key === "name") return db.name
    if (key === "table") return table
    if (key === "transaction") return transaction
    if (key === "tables")
      return db.tables.filter((entry) => entry.name.startsWith(`${pluginId}:`)).map(protect)
    return undefined
  }
  const view = new Proxy(
    {},
    {
      get: (_target, key) => read(key),
      ownKeys: () => ["name", "table", "transaction", "tables"],
      getOwnPropertyDescriptor: (_target, key) =>
        ["name", "table", "transaction", "tables"].includes(String(key))
          ? { configurable: true, enumerable: true, get: () => read(key) }
          : undefined,
      getPrototypeOf: () => null,
    }
  ) as Dexie
  return { table, rawDb: () => view }
}
