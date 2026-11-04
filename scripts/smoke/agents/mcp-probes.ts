/**
 * MCP servers an agent can be told to call, one per transport (stdio, HTTP,
 * SSE). Each records that it was called, so a smoke proves the agent really
 * reached the tool instead of trusting the model's report.
 */
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { check, type SmokeContext } from "./kit"

export interface McpProbes {
  /** Servers in the shape ACP `session/new` takes. */
  servers: [
    { name: string; command: string; args: string[]; env: [] },
    { type: "http"; name: string; url: string; headers: [] },
    { type: "sse"; name: string; url: string; headers: [] },
  ]
  /** The marker the stdio probe returns and writes to `stdioReceipt` when called. */
  stdioMarker: string
  stdioReceipt: string
  /** The marker each network probe returns, by transport. */
  networkMarkers: { http: string; sse: string }
  /** Network transports whose probe tool was called. */
  networkCalls: Set<"http" | "sse">
}

function stdioProbeSource(name: string, receipt: string, marker: string): string {
  return `
import readline from 'node:readline';
import fs from 'node:fs';
readline.createInterface({input:process.stdin}).on('line', line => {
  const req=JSON.parse(line); if(req.id === undefined) return;
  let result={};
  if(req.method === 'initialize') result={protocolVersion:req.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:${JSON.stringify(name)},version:'1.0.0'}};
  else if(req.method === 'tools/list') result={tools:[{name:'probe',description:'Return the integration probe marker',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
  else if(req.method === 'tools/call') {fs.writeFileSync(${JSON.stringify(receipt)},${JSON.stringify(marker)});result={content:[{type:'text',text:${JSON.stringify(marker)}}]};}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
});
`
}

/** Start the three probes for `prefix` (e.g. "kimi" → kimi-probe, kimi-http-probe, kimi-sse-probe). */
export async function startMcpProbes(context: SmokeContext, prefix: string): Promise<McpProbes> {
  const stdioMarker = `MCP_OK_${randomUUID()}`
  const stdioReceipt = path.join(context.scratch, "mcp-called.txt")
  const script = path.join(context.scratch, "mcp-probe.mjs")
  fs.writeFileSync(script, stdioProbeSource(`${prefix}-probe`, stdioReceipt, stdioMarker))

  const tag = prefix.toUpperCase()
  const networkMarkers = { http: `${tag}_HTTP_OK`, sse: `${tag}_SSE_OK` }
  const networkCalls = new Set<"http" | "sse">()
  const sseStreams = new Map<string, ServerResponse>()
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (request.method === "GET" && url.pathname === "/sse") {
      const id = randomUUID()
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      sseStreams.set(id, response)
      response.write(`event: endpoint\ndata: /sse-message?sessionId=${id}\n\n`)
      request.on("close", () => sseStreams.delete(id))
      return
    }
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    let body = ""
    for await (const chunk of request) body += chunk
    const rpc = JSON.parse(body)
    const transport = url.pathname === "/sse-message" ? "sse" : "http"
    let result: unknown = {}
    if (rpc.method === "initialize")
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: `${prefix}-${transport}-probe`, version: "1.0.0" },
      }
    if (rpc.method === "tools/list")
      result = {
        tools: [
          {
            name: "probe",
            description: `Return the ${prefix} ${transport} integration marker`,
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }
    if (rpc.method === "tools/call") {
      networkCalls.add(transport)
      result = { content: [{ type: "text", text: networkMarkers[transport] }] }
    }
    if (transport === "sse") {
      response.writeHead(202).end()
      if (rpc.id !== undefined)
        sseStreams
          .get(url.searchParams.get("sessionId") ?? "")
          ?.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`
          )
    } else if (rpc.id === undefined) response.writeHead(202).end()
    else
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  context.defer(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address() as AddressInfo | null
  check(address, "MCP probe server did not start")
  const base = `http://127.0.0.1:${address.port}`
  return {
    servers: [
      { name: `${prefix}-probe`, command: process.execPath, args: [script], env: [] },
      { type: "http", name: `${prefix}-http-probe`, url: `${base}/mcp`, headers: [] },
      { type: "sse", name: `${prefix}-sse-probe`, url: `${base}/sse`, headers: [] },
    ],
    stdioMarker,
    stdioReceipt,
    networkMarkers,
    networkCalls,
  }
}
