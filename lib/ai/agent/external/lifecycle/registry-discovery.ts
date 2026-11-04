import { proxyFetch } from "@/lib/network/proxy-fetch"
import { discoverRegistryAgents as discover } from "@cognia/agent-acp/registry-lifecycle"
export * from "@cognia/agent-acp/registry-lifecycle"
export function discoverRegistryAgents(options: { platformKey: string; fetcher?: typeof fetch }) {
  return discover({ ...options, fetcher: options.fetcher ?? proxyFetch })
}
