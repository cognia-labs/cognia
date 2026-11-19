// Storybook 10.6 broadcasts its internal reverse dependency index as a full
// websocket snapshot, even without clients. Cognia's full catalog produces
// >9 million edges and exceeds V8's string limit in telejson.stringify.
// Keep that internal index server-side; HTTP MCP and local channel subscribers
// still read the real index. Browser graph status/revisions/globals are intact.
// Remove this compatibility shim when upstream bounds internal service sync.

interface ServiceEvent {
  type: string
  args?: Array<{ serviceId?: string }>
}

interface Transport {
  constructor: { name: string }
  send: (event: ServiceEvent, ...rest: unknown[]) => unknown
}

const installed = new WeakSet<Transport>()

export function keepModuleIndexOnServer<T>(channel: T): T {
  // experimental_serverChannel is a version-sensitive third-party boundary.
  // Fail visibly if its transport contract changes, rather than silently
  // reintroducing a full-catalog crash.
  const transports = (channel as { transports?: Transport[] }).transports
  const browserTransports = transports?.filter(
    (transport) => transport.constructor.name === "ServerChannelTransport"
  )
  if (!browserTransports?.length) {
    throw new Error("Unsupported Storybook server transport: review the module-index sync shim")
  }
  for (const transport of browserTransports) {
    if (installed.has(transport)) continue
    const send = transport.send
    transport.send = function (event, ...rest) {
      if (
        (event.type === "services:patches" || event.type === "services:sync-start-reply") &&
        event.args?.[0]?.serviceId === "core/module-graph-index"
      ) {
        return
      }
      return send.call(this, event, ...rest)
    }
    installed.add(transport)
  }
  return channel
}
