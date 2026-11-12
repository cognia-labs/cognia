import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { randomBytes } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"

export const RESULT_PREFIX = "COGNIA_PLUGIN_RESULT:"
const FRAME_LIMIT = 2 * 1024 * 1024
const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"])
const WIRE_KEYS = [
  "$callback",
  "$undefined",
  "$cogniaSecretRef",
  "$cogniaPlainObject",
  "$hostHandle",
]
const HOST_PRIVATE_IMPORT_PATTERN =
  /(?:from\s*|import\s*\(|require\s*\(|import\s+(?=["']))\s*["'](@\/(?:lib|types|components|stores)(?:\/[^"']*)?)["']/g

export function createBridgeContext({ snapshot, send, requestTimeoutMs = 120_000 }) {
  const callbacks = new Map()
  const callbackIds = new WeakMap()
  const hostHandles = new WeakMap()
  const pending = new Map()
  const operations = new AsyncLocalStorage()
  let sequence = 0
  let snapshotValue

  const encode = (value, seen = new WeakSet(), owner) => {
    if (typeof value === "function") {
      if (hostHandles.has(value)) return { $hostHandle: hostHandles.get(value) }
      const owners = callbackIds.get(value) ?? new Map()
      let id = owners.get(owner)
      if (!id) {
        id = `cb:${++sequence}`
        owners.set(owner, id)
        callbackIds.set(value, owners)
        callbacks.set(id, (...args) => value.apply(owner, args))
      }
      return { $callback: id }
    }
    if (value === undefined) return { $undefined: true }
    if (value === null || typeof value !== "object") return value
    if (seen.has(value)) throw new Error("Node plugin value contains a cycle")
    seen.add(value)
    const entries = Object.entries(value).map(([key, item]) => [key, encode(item, seen, value)])
    seen.delete(value)
    if (Array.isArray(value)) return entries.map(([, item]) => item)
    const encoded = Object.fromEntries(entries)
    if (
      Object.getOwnPropertyDescriptor(value, Symbol.for("cognia.plugin.secretRef"))?.value === true
    ) {
      return { $cogniaSecretRef: encoded }
    }
    return WIRE_KEYS.some((key) => Object.hasOwn(value, key))
      ? { $cogniaPlainObject: entries }
      : encoded
  }

  const safe = (segments) => {
    if (
      segments.some(
        (segment) => typeof segment !== "string" || !segment || UNSAFE_PATH_SEGMENTS.has(segment)
      )
    ) {
      throw new Error("Unsafe Node plugin context path")
    }
    return segments
  }
  const handle = (id, path = [], promise, properties = {}) => {
    const proxy = new Proxy(() => {}, {
      get(_target, key) {
        if (key === "then") return promise?.then.bind(promise)
        if (typeof key !== "string") return undefined
        if (Object.hasOwn(properties, key)) return properties[key]
        return handle(id, safe([...path, key]))
      },
      apply(_target, _owner, args) {
        return call({ handle: id, path: path.join(".") }, args)
      },
    })
    hostHandles.set(proxy, { id, path })
    return proxy
  }
  const revive = (value) => {
    if (Array.isArray(value)) return value.map(revive)
    if (!value || typeof value !== "object") return value
    if (Object.keys(value).length === 1) {
      if (value.$undefined === true) return undefined
      if (value.$cogniaPlainObject)
        return Object.fromEntries(
          value.$cogniaPlainObject.map(([key, item]) => [key, revive(item)])
        )
      if (value.$cogniaSecretRef)
        return Object.defineProperty(
          revivePlain(value.$cogniaSecretRef),
          Symbol.for("cognia.plugin.secretRef"),
          { value: true }
        )
      if (value.$hostHandle)
        return handle(
          value.$hostHandle.id,
          safe(value.$hostHandle.path ?? []),
          undefined,
          revive(value.$hostHandle.properties ?? {})
        )
    }
    return revivePlain(value)
  }
  const revivePlain = (value) =>
    Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]))
  const call = (target, args) => {
    const operation = operations.getStore()
    if (operation?.expired) throw new Error("Node plugin request has expired")
    const id = `call:${++sequence}`
    const encodedArgs = encode(args)
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error("Node plugin host call timed out"))
      }, requestTimeoutMs)
      pending.set(id, { resolve, reject, timer })
      send({
        type: "call",
        id,
        requestId: operation?.id,
        ...target,
        args: encodedArgs,
      })
    })
    // Even fire-and-forget calls are part of the enclosing lifecycle request.
    promise.catch(() => {})
    operation?.calls.push(promise)
    return handle(id, [], promise)
  }
  snapshotValue = revive(snapshot)
  const local = snapshotValue.local ?? {}
  const localI18n = local.i18n
  const localMethods = {
    "configuration.get": (key) => snapshotValue.config?.[key],
    "configuration.getOrDefault": (key, fallback) =>
      snapshotValue.config?.[key] === undefined ? fallback : snapshotValue.config[key],
    "configuration.getAll": () => ({ ...snapshotValue.config }),
    "permissions.getGrantedPermissions": () => local.permissions ?? [],
    "permissions.hasPermission": (permission) => (local.permissions ?? []).includes(permission),
    "permissions.hasAllPermissions": (permissions) =>
      permissions.every((permission) => (local.permissions ?? []).includes(permission)),
    "permissions.hasAnyPermission": (permissions) =>
      permissions.some((permission) => (local.permissions ?? []).includes(permission)),
  }
  if (localI18n) {
    const message = (key, fallback = true) => {
      const fullKey = key.startsWith(`plugin.${snapshotValue.pluginId}.`)
        ? key
        : `plugin.${snapshotValue.pluginId}.${key}`
      return (
        localI18n.messages?.[localI18n.locale]?.[fullKey] ??
        (fallback ? localI18n.messages?.en?.[fullKey] : undefined)
      )
    }
    Object.assign(localMethods, {
      "i18n.getCurrentLocale": () => localI18n.locale,
      "i18n.getLocale": () => localI18n.locale,
      "i18n.getAvailableLocales": () => localI18n.locales,
      "i18n.getLocaleName": (locale) => localI18n.localeNames?.[locale] ?? locale,
      "i18n.t": (key, params) => {
        const value = message(key) ?? key
        return params && value !== key
          ? value.replace(/\{(\w+)\}/g, (match, name) =>
              params[name] !== undefined ? String(params[name]) : match
            )
          : value
      },
      "i18n.hasTranslation": (key) => message(key, false) !== undefined,
      "i18n.hasKey": (key) => message(key, false) !== undefined,
      "i18n.formatDate": (date, options) =>
        new Intl.DateTimeFormat(localI18n.locale, options).format(date),
      "i18n.formatNumber": (number, options) =>
        new Intl.NumberFormat(localI18n.locale, options).format(number),
      "i18n.formatRelativeTime": (date) => {
        const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
        const [unit, value] =
          seconds >= 86400
            ? ["day", Math.floor(seconds / 86400)]
            : seconds >= 3600
              ? ["hour", Math.floor(seconds / 3600)]
              : seconds >= 60
                ? ["minute", Math.floor(seconds / 60)]
                : ["second", seconds]
        return new Intl.RelativeTimeFormat(localI18n.locale, {
          numeric: "auto",
        }).format(-value, unit)
      },
    })
  }
  const proxyFor = (segments) =>
    new Proxy(() => {}, {
      get(_target, property) {
        if (property === "then" || typeof property !== "string") return undefined
        const path = safe([...segments, property])
        let value = snapshotValue
        for (const segment of path) value = value?.[segment]
        if (value !== undefined) return value
        return proxyFor(path)
      },
      apply(_target, _owner, args) {
        const path = safe(segments).join(".")
        if (Object.hasOwn(localMethods, path)) return localMethods[path](...args)
        if (path === "i18n.registerTranslations" && localI18n) {
          const [locale, translations] = args
          const messages = (localI18n.messages[locale] ??= {})
          for (const [key, value] of Object.entries(translations))
            messages[
              key.startsWith(`plugin.${snapshotValue.pluginId}.`)
                ? key
                : `plugin.${snapshotValue.pluginId}.${key}`
            ] = value
        }
        return call({ path }, args)
      },
    })
  return {
    context: proxyFor([]),
    encode,
    revive,
    callbacks,
    reply(frame) {
      const request = pending.get(frame.id)
      if (!request) return
      pending.delete(frame.id)
      clearTimeout(request.timer)
      if (Object.hasOwn(frame, "error")) request.reject(new Error(String(frame.error)))
      else request.resolve(revive(frame.value))
    },
    async run(id, action, timeoutMs, failOnHostError = false) {
      const operation = { id, calls: [], expired: false }
      let timer
      try {
        return await Promise.race([
          operations.run(operation, async () => {
            const result = await action()
            let settled = 0
            while (settled < operation.calls.length) {
              const batch = operation.calls.slice(settled)
              settled += batch.length
              const results = await Promise.allSettled(batch)
              const failure = results.find((result) => result.status === "rejected")
              if (failOnHostError && failure) throw failure.reason
            }
            return result
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              operation.expired = true
              reject(new Error("Node plugin request timed out"))
            }, timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

export function resolvePluginDefinition(moduleExports) {
  const first = moduleExports?.default ?? moduleExports
  const definition = first?.default?.activate ? first.default : first
  if (!definition || typeof definition.activate !== "function") {
    throw new Error("Node plugin entry must export a PluginDefinition with activate(ctx)")
  }
  return definition
}

async function loadDefinition(entry) {
  const source = await readFile(entry, "utf8")
  const hostPrivateImports = [...source.matchAll(HOST_PRIVATE_IMPORT_PATTERN)].map(
    (match) => match[1]
  )
  if (hostPrivateImports.length > 0) {
    throw new Error(
      `Marketplace plugin ${entry} imports host-private modules: ${[
        ...new Set(hostPrivateImports),
      ].join(", ")}`
    )
  }
  const moduleExports = await import(`${pathToFileURL(entry).href}?host=${Date.now()}`)
  return { definition: resolvePluginDefinition(moduleExports), moduleExports }
}

async function main() {
  // Capture the writer before plugin import. The nonce distinguishes accidental
  // stdout from frames; it is not a security boundary against plugin code,
  // which can already make the context calls its permissions allow.
  const write = process.stdout.write.bind(process.stdout)
  process.stdout.write = process.stderr.write.bind(process.stderr)
  for (const level of ["debug", "info", "log", "warn", "error"]) {
    console[level] = (...args) => process.stderr.write(`[plugin:${level}] ${args.join(" ")}\n`)
  }
  const token = randomBytes(32).toString("hex")
  const send = (frame) => {
    const line = `${RESULT_PREFIX}${JSON.stringify({ ...frame, token })}\n`
    if (Buffer.byteLength(line) > FRAME_LIMIT)
      throw new Error("Node plugin frame exceeded the protocol limit")
    write(line)
  }
  const [, entry, pluginId] = process.argv.slice(1)
  if (!entry || !pluginId) throw new Error("Node plugin host requires entry and plugin id")
  let bridge
  let definition
  let activated = false
  let activating = false
  let deactivating = false
  const dispatch = async (frame) => {
    if (frame.type === "reply") {
      bridge?.reply(frame)
      return
    }
    const id = frame.id
    try {
      if (frame.type === "activate") {
        if (bridge) throw new Error("Node plugin already activated")
        bridge = createBridgeContext({ snapshot: frame.snapshot, send })
        const loaded = await loadDefinition(entry)
        definition = loaded.definition
        activating = true
        const hooks = await bridge.run(id, () => definition.activate(bridge.context), 30_000, true)
        activated = true
        activating = false
        const publicExports = Object.fromEntries(
          Object.entries(loaded.moduleExports).filter(([name]) => name !== "default")
        )
        send({
          type: "activated",
          id,
          hooks: bridge.encode(hooks ?? {}),
          exports: bridge.encode(publicExports),
        })
      } else if (frame.type === "invoke") {
        if (!bridge || (!activated && !activating && !deactivating))
          throw new Error("Node plugin is not active")
        const callback = bridge.callbacks.get(frame.callbackId)
        if (!callback) throw new Error(`Node plugin callback not found: ${frame.callbackId}`)
        const args = bridge.revive(frame.args)
        if (!Array.isArray(args)) throw new Error("Node plugin callback arguments must be an array")
        const result = await bridge.run(id, () => callback(...args), 120_000)
        send({ type: "result", id, value: bridge.encode(result) })
      } else if (frame.type === "deactivate") {
        if (!bridge || deactivating) throw new Error("Node plugin is not active")
        deactivating = true
        await bridge.run(id, () => definition?.deactivate?.(bridge.context), 5_000)
        activated = false
        deactivating = false
        send({ type: "result", id, value: { $undefined: true } })
        // The owner kills the process after receiving the result and disposing handles.
      } else throw new Error("Unknown Node plugin frame")
    } catch (error) {
      if (frame.type === "activate") activating = false
      send({
        type: "error",
        id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  let buffer = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    buffer += chunk
    if (Buffer.byteLength(buffer) > FRAME_LIMIT) {
      process.exitCode = 1
      process.stdin.destroy()
      return
    }
    let newline
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      try {
        void dispatch(JSON.parse(line))
      } catch {
        send({ type: "error", error: "Invalid Node plugin frame" })
      }
    }
  })
  process.stdin.on("end", () => process.exit())
  send({ type: "ready", protocol: 2 })
}

if (process.argv[1] === "resident") {
  main().catch((error) => {
    process.stderr.write(`${error}\n`)
    process.exitCode = 1
  })
}
