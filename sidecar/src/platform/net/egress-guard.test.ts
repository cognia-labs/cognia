import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import type { LookupFunction } from "node:net"

import { createEgressGuard, isPrivateOrReservedHost, validateRemoteUrl } from "./egress-guard.ts"
import type { GuardAgentConstructor, LookupAll } from "./egress-guard.ts"

test("importing and validating the guard does not load Undici", () => {
  const source = `
    const {registerHooks}=await import("node:module");
    registerHooks({resolve(specifier,context,next){
      if(specifier.startsWith("undici")) throw Error("UNEXPECTED_UNDICI_IMPORT");
      return next(specifier,context);
    }});
    const {createEgressGuard}=await import(${JSON.stringify(new URL("./egress-guard.ts", import.meta.url).href)});
    const guard=createEgressGuard();
    let refused=false;
    try {guard.fetch("https://127.0.0.1/")}catch(error){refused=error.message.includes("private")}
    if(!refused) throw Error("URL refusal is no longer synchronous");
    const controller=new AbortController();controller.abort();
    try {await guard.fetch("https://example.test/",{signal:controller.signal});throw Error("abort ignored")}
    catch(error){if(error.name!=="AbortError")throw error}
    await guard.close();
    const privateGuard=createEgressGuard({allowPrivateNetwork:true,fetchImpl:async()=>new Response("ok")});
    if(await (await privateGuard.fetch("http://127.0.0.1/")).text()!=="ok")throw Error("injected fetch failed");
    await privateGuard.close();
  `
  execFileSync(process.execPath, ["--input-type=module", "--eval", source], { timeout: 10_000 })
})

test("lazy initialization shares one agent and fences cancellation and close", () => {
  const guardUrl = new URL("./egress-guard.ts", import.meta.url).href
  const source = `
    const {registerHooks}=await import("node:module");
    const assert=(await import("node:assert/strict")).default;
    let release;
    globalThis.loaded=new Promise(resolve=>{globalThis.loading=resolve});
    globalThis.gate=new Promise(resolve=>{release=resolve});
    globalThis.built=0;globalThis.closed=0;globalThis.fetched=0;
    const fakeModule='globalThis.loading();await globalThis.gate;export class Agent{constructor(){globalThis.built++}async close(){globalThis.closed++}}';
    registerHooks({resolve(specifier,context,next){
      if(specifier==="undici/index.js")return {url:"data:text/javascript,"+encodeURIComponent(fakeModule),shortCircuit:true};
      return next(specifier,context);
    }});
    const {createEgressGuard}=await import(${JSON.stringify(guardUrl)});
    const fetchImpl=async()=>{globalThis.fetched++;return new Response("ok")};
    const active=createEgressGuard({fetchImpl});
    const cancelled=createEgressGuard({fetchImpl});
    const closing=createEgressGuard({fetchImpl});
    const controller=new AbortController();
    const first=active.fetch("https://example.test/");
    const second=active.fetch("https://example.test/");
    const aborted=cancelled.fetch("https://example.test/",{signal:controller.signal});
    const late=closing.fetch("https://example.test/");
    const settled=Promise.allSettled([first,second,aborted,late]);
    await globalThis.loaded;
    controller.abort();
    const closed=closing.close();
    release();
    const results=await settled;await closed;
    assert.deepEqual(results.map(r=>r.status),["fulfilled","fulfilled","rejected","rejected"]);
    assert.equal(results[2].reason.name,"AbortError");
    assert.match(results[3].reason.message,/closed/);
    assert.equal(globalThis.fetched,2);
    assert.equal(globalThis.built,2);
    await Promise.all([active.close(),active.close(),cancelled.close()]);
    assert.equal(globalThis.closed,2);
    await assert.rejects(active.fetch("https://example.test/"),/closed/);
    assert.equal(globalThis.fetched,2);
  `
  execFileSync(process.execPath, ["--input-type=module", "--eval", source], { timeout: 10_000 })
})

test("mixed DNS answers and lookup failures fail closed on each socket lookup", async () => {
  const agent = fakeAgent({ close: async () => undefined })
  let answer = [{ address: "8.8.8.8", family: 4 }]
  let error: NodeJS.ErrnoException | null = null
  let lookups = 0
  const guard = createEgressGuard({
    AgentCtor: agent.AgentCtor,
    lookup: (_host, options, callback) => {
      assert.equal(options.all, true)
      lookups++
      callback(error, answer)
    },
    fetchImpl: async () => new Response(null),
  })
  await guard.fetch("https://example.test/")
  const lookup = agent.options()!.connect.lookup
  const resolve = () =>
    new Promise<Error | null>((done) => lookup("example.test", {}, (err) => done(err)))
  assert.equal(await resolve(), null)
  answer = [...answer, { address: "127.0.0.1", family: 4 }]
  assert.match((await resolve())?.message ?? "", /blocked/)
  error = Object.assign(new Error("fixture DNS failure"), { code: "ENOTFOUND" })
  assert.equal(await resolve(), error)
  assert.equal(lookups, 3)
  await guard.close()
})

test("an explicit signal overrides a Request signal without losing body or redirect policy", async () => {
  const controller = new AbortController()
  controller.abort()
  let body = ""
  const guard = createEgressGuard({
    allowPrivateNetwork: true,
    fetchImpl: async (input, init) => {
      const normalized = new Request(input, init)
      assert.equal(normalized.signal.aborted, false)
      assert.equal(normalized.redirect, "error")
      body = await normalized.text()
      return new Response("ok")
    },
  })
  await guard.fetch(
    new Request("http://127.0.0.1/", {
      method: "POST",
      body: "preserved",
      signal: controller.signal,
    }),
    { signal: null }
  )
  assert.equal(body, "preserved")
  await guard.close()
})

test("URL mutation after fetch cannot change the validated destination", async () => {
  for (const [allowPrivateNetwork, original] of [
    [false, "https://example.test/allowed"],
    [true, "http://127.0.0.1/allowed"],
  ] as const) {
    let received = ""
    const agent = fakeAgent({ close: async () => undefined })
    const guard = createEgressGuard({
      allowPrivateNetwork,
      AgentCtor: agent.AgentCtor,
      fetchImpl: async (input) => {
        received = String(input)
        return new Response(null)
      },
    })
    const url = new URL(original)
    const request = guard.fetch(url)
    url.href = allowPrivateNetwork
      ? "http://public.test/unvalidated"
      : "http://127.0.0.1/unvalidated"
    await request
    assert.equal(received, original)
    await guard.close()
  }
})

test("a failed Undici load refuses dispatch and still permits idempotent cleanup", () => {
  const source = `
    const assert=(await import("node:assert/strict")).default;
    const {registerHooks}=await import("node:module");
    registerHooks({resolve(specifier,context,next){
      if(specifier==="undici/index.js")throw Error("fixture import failed");
      return next(specifier,context);
    }});
    const {createEgressGuard}=await import(${JSON.stringify(new URL("./egress-guard.ts", import.meta.url).href)});
    let fetched=0;
    const guard=createEgressGuard({fetchImpl:async()=>{fetched++;return new Response(null)}});
    await assert.rejects(guard.fetch("https://example.test/"),/fixture import failed/);
    await assert.rejects(guard.fetch("https://example.test/"),/fixture import failed/);
    await Promise.all([guard.close(),guard.close()]);
    assert.equal(fetched,0);
  `
  execFileSync(process.execPath, ["--input-type=module", "--eval", source], { timeout: 10_000 })
})

test(
  "actual Bun preserves guarded socket dispatch with and without a configured proxy",
  {
    skip: !process.env.COGNIA_TEST_BUN,
  },
  () => {
    const guardUrl = new URL("./egress-guard.ts", import.meta.url).href
    const installerUrl = new URL("./install-fetch-interceptor.ts", import.meta.url).href
    for (const proxy of ["", "http://127.0.0.1:1"]) {
      const source = `
      await import(${JSON.stringify(installerUrl)});
      const { createEgressGuard } = await import(${JSON.stringify(guardUrl)});
      let calls=0;
      class Sentinel { dispatch(){calls++;throw Error("GUARDED_DISPATCH")} async close(){} }
      const guard = createEgressGuard({AgentCtor:Sentinel});
      try { await guard.fetch(new Request("https://guarded-dispatch.test/",{method:"POST",body:"guard-body"})) } catch(error) {
        if(error.cause?.message!=="GUARDED_DISPATCH") throw error;
      }
      if(calls!==1) throw Error("guarded dispatcher was bypassed");
      const controller=new AbortController();controller.abort();
      try { await guard.fetch(new Request("https://guarded-dispatch.test/",{signal:controller.signal})); throw Error("abort ignored") }
      catch(error) { if(error.name!=="AbortError") throw error }
      await guard.close();
      const dnsGuard = createEgressGuard({lookup:(_host,_options,callback)=>callback(null,[{address:"127.0.0.1",family:4}])});
      try { await dnsGuard.fetch("https://dns-rebinding.test/"); throw Error("private DNS was allowed") }
      catch(error) { if(!String(error.cause?.message ?? error.message).includes("blocked")) throw error }
      await dnsGuard.close();
      console.log("guarded-dispatch-ok");`
      const output = execFileSync(
        process.env.COGNIA_TEST_BUN!,
        ["--input-type=module", "--eval", source],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...process.env,
            HTTP_PROXY: proxy,
            HTTPS_PROXY: proxy,
            http_proxy: "",
            https_proxy: "",
            NO_PROXY: "",
            no_proxy: "",
          },
        }
      )
      assert.match(output, /guarded-dispatch-ok/)
    }
  }
)

/** A fake pool constructor recording the options the guard builds it with. */
function fakeAgent(dispatcher: object): {
  AgentCtor: GuardAgentConstructor
  options: () => { connect: { lookup: LookupFunction } } | undefined
} {
  let seen: { connect: { lookup: LookupFunction } } | undefined
  class FakeAgent {
    constructor(options: { connect: { lookup: LookupFunction } }) {
      seen = options
      return dispatcher
    }
  }
  // The fake stands in for undici's Agent; the guard only passes it to fetch and closes it.
  return { AgentCtor: FakeAgent as unknown as GuardAgentConstructor, options: () => seen }
}

function lookupReturning(addresses: { address: string; family: number }[]): LookupAll {
  return (_hostname, _options, callback) => callback(null, addresses)
}

test("isPrivateOrReservedHost classifies loopback, private, link-local and reserved targets", () => {
  for (const host of [
    "localhost",
    "api.localhost",
    "printer.local",
    "[::1]",
    "::",
    "fd12::1",
    "fe80::1",
    "::ffff:8.8.8.8",
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.8",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "224.0.0.1",
  ]) {
    assert.equal(isPrivateOrReservedHost(host), true, host)
  }
  for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateOrReservedHost(host), false, host)
  }
})

test("OAuth egress rejects insecure and private endpoints unless explicitly reviewed", () => {
  assert.throws(() => validateRemoteUrl("http://example.com/mcp"), /HTTPS/)
  assert.throws(() => validateRemoteUrl("https://127.0.0.1/mcp"), /private or reserved/)
  assert.equal(validateRemoteUrl("http://127.0.0.1/mcp", true).href, "http://127.0.0.1/mcp")
  assert.throws(() => validateRemoteUrl("http://example.com/mcp", true), /HTTPS/)
  assert.throws(() => validateRemoteUrl("not a url"), /not a valid URL/)
})

test("guarded OAuth fetch denies redirects and carries a socket-level DNS guard", async () => {
  const dispatcher = { close: async () => undefined }
  const agent = fakeAgent(dispatcher)
  let receivedInit: RequestInit | undefined
  const guard = createEgressGuard({
    AgentCtor: agent.AgentCtor,
    lookup: lookupReturning([{ address: "127.0.0.1", family: 4 }]),
    fetchImpl: async (_input, init) => {
      receivedInit = init
      return new Response(null)
    },
  })
  await guard.fetch("https://example.com/token", { redirect: "follow" })
  assert.equal(receivedInit?.redirect, "error")
  assert.equal((receivedInit as { dispatcher?: unknown } | undefined)?.dispatcher, dispatcher)
  const lookup = agent.options()?.connect.lookup
  assert.equal(typeof lookup, "function")
  const lookupError = await new Promise<Error | null>((resolve) => {
    lookup?.("rebinding.example", {}, (error) => resolve(error))
  })
  assert.match(lookupError?.message ?? "", /private or reserved/)
  await guard.close()
})

test("the guarded lookup answers in the caller's requested shape", async () => {
  const agent = fakeAgent({ close: async () => undefined })
  await createEgressGuard({
    AgentCtor: agent.AgentCtor,
    lookup: lookupReturning([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800::1", family: 6 },
    ]),
    fetchImpl: async () => new Response(null),
  }).fetch("https://example.com/")
  const lookup = agent.options()?.connect.lookup
  assert.ok(lookup)
  const single = await new Promise((resolve) =>
    lookup("example.com", {}, (error, address, family) => resolve({ error, address, family }))
  )
  assert.deepEqual(single, { error: null, address: "93.184.216.34", family: 4 })
  const all = await new Promise((resolve) =>
    lookup("example.com", { all: true }, (error, address) => resolve({ error, address }))
  )
  assert.deepEqual(all, {
    error: null,
    address: [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800::1", family: 6 },
    ],
  })
  const empty = createEgressGuard({
    AgentCtor: agent.AgentCtor,
    lookup: lookupReturning([]),
    fetchImpl: async () => new Response(null),
  })
  await empty.fetch("https://example.com/")
  const noAddresses = await new Promise<Error | null>((resolve) =>
    agent.options()?.connect.lookup("example.com", {}, (error) => resolve(error))
  )
  assert.match(noAddresses?.message ?? "", /returned no addresses/)
})

test("a reviewed private server skips the guarded pool but still refuses redirects", async () => {
  let built = false
  class NeverBuilt {
    constructor() {
      built = true
    }
  }
  let receivedInit: RequestInit | undefined
  const guard = createEgressGuard({
    allowPrivateNetwork: true,
    AgentCtor: NeverBuilt as unknown as GuardAgentConstructor,
    fetchImpl: async (_input, init) => {
      receivedInit = init
      return new Response(null)
    },
  })
  await guard.fetch("http://127.0.0.1:8080/mcp")
  assert.equal(built, false)
  assert.equal(receivedInit?.redirect, "error")
  assert.equal("dispatcher" in (receivedInit ?? {}), false)
  await guard.close()
})
