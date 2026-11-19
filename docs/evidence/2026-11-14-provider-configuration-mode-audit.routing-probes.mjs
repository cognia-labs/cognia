/**
 * Read-only model-consumption probes. Requests terminate in an injected fetch;
 * the child process receives a small allowlisted environment and no secrets.
 * Run from the repository root with Node. Output stays under .cache/.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { transformSync } from "esbuild"

const root = process.cwd()
const output = resolve(root, ".cache/provider-configuration-mode-audit")
mkdirSync(output, { recursive: true })

// Extract the actual projection rather than restating it in the fixture.
const rendererPath = "lib/ai/renderer-llm-client.ts"
const rendererSource = readFileSync(resolve(root, rendererPath), "utf8")
const projectionStart = rendererSource.indexOf("function llmConfigOf(")
assert.ok(projectionStart > 0, "llmConfigOf moved; review this probe")
assert.equal(rendererSource.indexOf("function llmConfigOf(", projectionStart + 1), -1)
const projectionEnd = rendererSource.indexOf("\n}\n", projectionStart)
assert.ok(projectionEnd > projectionStart)
const projectionCode = transformSync(rendererSource.slice(projectionStart, projectionEnd + 2), {
  loader: "ts",
}).code
const llmConfigOf = new Function(`${projectionCode}; return llmConfigOf`)()
const projected = llmConfigOf(
  {
    providerId: "commandcode",
    protocol: "openai",
    apiKey: "synthetic-key",
    baseURL: "https://synthetic-relay.invalid/v1",
    headers: { "X-Synthetic-Tenant": "tenant-a" },
  },
  "claude-synthetic"
)
assert.equal(projected.provider, "openai")
assert.equal(projected.headers, undefined)

const sourcePaths = [
  rendererPath,
  "lib/ai/provider-consumption.ts",
  "lib/claude/provider-attempt-options.ts",
  "sidecar/src/providers/protocol-adapters/ai-sdk-adapter.ts",
  "lib/ai/agent/external/config/cognia-model-options.ts",
]
const sourceHashes = Object.fromEntries(
  sourcePaths.map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(resolve(root, path)))
      .digest("hex"),
  ])
)

const childCode = String.raw`
import assert from "node:assert/strict";
import { createProviderSettingsSnapshot, resolveFeatureProvider, createFeatureProviderModel } from "./lib/ai/provider-consumption.ts";
import { resolveProviderAttemptOptions } from "./lib/claude/provider-attempt-options.ts";
import { buildRendererLlmClient } from "./lib/ai/renderer-llm-client.ts";
import { makeAiSdkAdapter } from "./sidecar/src/providers/protocol-adapters/ai-sdk-adapter.ts";
import { listHostProfileGatewayModelOptions } from "./lib/ai/agent/external/config/cognia-model-options.ts";
import { buildGatewaySnapshot } from "./lib/gateway/snapshot-publisher.ts";

const observations = [];
let requests = [];
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const headers = Object.fromEntries(request.headers);
  requests.push({url: request.url, headers});
  throw new Error("AUDIT_CAPTURE_ONLY");
};
const settingsFor = (providerId, config) => ({
  defaultProvider: providerId,
  defaultModel: config.defaultModel ?? "synthetic-model",
  providerSettings: {[providerId]: {providerId, enabled:true, defaultModel:"synthetic-model", ...config}},
  customProviders: [],
});
const resolveFor = (settings, providerId) => resolveFeatureProvider({
  featureId:"audit", routeProfile:"general-text", selectionMode:"explicit-provider", providerId, fallbackMode:"none",
}, createProviderSettingsSnapshot(settings));
const generateOptions = {prompt:[{role:"user",content:[{type:"text",text:"Synthetic probe"}]}],maxOutputTokens:16};
async function captureModel(model) {
  requests = [];
  let error;
  try { await model.doGenerate(generateOptions); }
  catch (caught) { error = String(caught?.message ?? caught); }
  return {requests:[...requests], error};
}
async function sidecarModel(providerId, options) {
  let model;
  await makeAiSdkAdapter(options.providerCredentials.protocol).start({
    providerId, model:"synthetic-model", messages:[{role:"user",content:"Synthetic probe"}],
    credentials:options.providerCredentials,
    streamTextFn: (args) => {model=args.model; return {stream:(async function*(){})()};},
  });
  assert.ok(model, "sidecar adapter did not create its real SDK model");
  return model;
}

// Main-chat resolution -> actual sidecar adapter -> installed SDK request.
const keylessSettings = settingsFor("ollama", {});
const keylessOptions = await resolveProviderAttemptOptions("ollama", keylessSettings);
assert.equal(keylessOptions.providerCredentials?.apiKey, undefined);
assert.equal(keylessOptions.providerCredentials?.baseURL, "http://localhost:11434/v1");
const withoutAmbient = await captureModel(await sidecarModel("ollama", keylessOptions));
assert.match(withoutAmbient.error, /OpenAI API key is missing/);
assert.equal(withoutAmbient.requests.length, 0);
observations.push({id:"keyless-sidecar-requires-openai-key", reproduced:true, ...withoutAmbient});
process.env.OPENAI_API_KEY = "synthetic-ambient-key";
const withAmbient = await captureModel(await sidecarModel("ollama", keylessOptions));
assert.equal(withAmbient.requests.length, 1);
assert.equal(withAmbient.requests[0].headers.authorization, "Bearer synthetic-ambient-key");
observations.push({id:"keyless-sidecar-forwards-ambient-openai-key", reproduced:true, ...withAmbient});
delete process.env.OPENAI_API_KEY;
const directKeyless = await captureModel(createFeatureProviderModel(resolveFor(keylessSettings,"ollama")));
assert.match(directKeyless.error, /OpenAI API key is missing/);
assert.equal(directKeyless.requests.length, 0);
observations.push({id:"keyless-direct-model-requires-openai-key", reproduced:true, ...directKeyless});

// Root is appropriate for local management, but inference needs /v1.
const rootSettings = settingsFor("ollama", {apiKey:"synthetic-local-placeholder",baseURL:"http://synthetic-engine.invalid:11434"});
const rootOptions = await resolveProviderAttemptOptions("ollama", rootSettings);
const rootRequest = await captureModel(await sidecarModel("ollama", rootOptions));
assert.equal(rootRequest.requests[0].url, "http://synthetic-engine.invalid:11434/chat/completions");
observations.push({id:"explicit-local-root-loses-v1", reproduced:true, ...rootRequest});
const defaultOptions = await resolveProviderAttemptOptions("ollama",settingsFor("ollama",{apiKey:"synthetic-local-placeholder"}));
const defaultRequest = await captureModel(await sidecarModel("ollama",defaultOptions));
assert.equal(defaultRequest.requests[0].url,"http://localhost:11434/v1/chat/completions");
observations.push({id:"implicit-local-default-keeps-v1",reproduced:true,...defaultRequest});

// The utility factory rejects a usable keyless local endpoint before dispatch.
const utility = buildRendererLlmClient({session:null,appSettings:keylessSettings,featureId:"audit"});
assert.equal(utility,null);
observations.push({id:"keyless-local-utility-is-null",reproduced:true,result:utility});

// Exact same custom header reaches chat but is dropped on the utility rail.
const headerSettings = settingsFor("openai",{apiKey:"synthetic-key",baseURL:"https://synthetic-relay.invalid/v1",customHeaders:{"X-Synthetic-Tenant":"tenant-a"}});
requests=[];
try { await buildRendererLlmClient({session:null,appSettings:headerSettings,featureId:"audit"}).complete("Synthetic probe",{maxRetries:0}); } catch {}
assert.equal(requests.length,1);
assert.equal(requests[0].headers["x-synthetic-tenant"],undefined);
const utilityRequests=[...requests];
const chatRequest=await captureModel(createFeatureProviderModel(resolveFor(headerSettings,"openai")));
assert.equal(chatRequest.requests[0].headers["x-synthetic-tenant"],"tenant-a");
observations.push({id:"utility-drops-provider-headers",reproduced:true,utilityRequests,chatRequests:chatRequest.requests});

// A configured rotation pool serves the gateway, but direct/utility drops it.
const poolSettings=settingsFor("openai",{apiKey:"",apiKeys:["synthetic-pool-key"],apiKeyRotationEnabled:true,baseURL:"https://synthetic-relay.invalid/v1"});
const poolSnapshot=buildGatewaySnapshot(poolSettings,1);
assert.equal(poolSnapshot.providers.find(provider=>provider.id==="openai").apiKey,"synthetic-pool-key");
assert.equal(buildRendererLlmClient({session:null,appSettings:poolSettings,featureId:"audit"}),null);
const directPool=await captureModel(createFeatureProviderModel(resolveFor(poolSettings,"openai")));
assert.match(directPool.error,/OpenAI API key is missing/);
observations.push({id:"pool-only-credential-is-gateway-only",reproduced:true,gatewayPickedPoolKey:true,utility:null,...directPool});

// The provider id is needed for CommandCode's per-model protocol switch.
const commandSettings=settingsFor("commandcode",{apiKey:"synthetic-key",defaultModel:"claude-synthetic",baseURL:"https://synthetic-commandcode.invalid/provider/v1"});
requests=[];
try {await buildRendererLlmClient({session:null,appSettings:commandSettings,featureId:"audit"}).complete("Synthetic probe",{maxRetries:0});}catch{}
assert.equal(requests[0].url,"https://synthetic-commandcode.invalid/provider/v1/chat/completions");
const commandUtilityRequests=[...requests];
const commandChat=await captureModel(createFeatureProviderModel(resolveFor(commandSettings,"commandcode")));
assert.equal(commandChat.requests[0].url,"https://synthetic-commandcode.invalid/provider/v1/messages");
assert.equal(commandChat.requests[0].headers["x-api-key"],"synthetic-key");
observations.push({id:"utility-commandcode-loses-model-protocol",reproduced:true,utilityRequests:commandUtilityRequests,chatRequests:commandChat.requests});

// Anthropic-compatible catalog/settings roots need the shared /v1 transform.
const anthropicSettings=settingsFor("anthropic",{apiKey:"synthetic-key",baseURL:"https://synthetic-anthropic.invalid/coding"});
requests=[];
try {await buildRendererLlmClient({session:null,appSettings:anthropicSettings,featureId:"audit"}).complete("Synthetic probe",{maxRetries:0});}catch{}
assert.equal(requests[0].url,"https://synthetic-anthropic.invalid/coding/messages");
const anthropicUtilityRequests=[...requests];
const anthropicChat=await captureModel(createFeatureProviderModel(resolveFor(anthropicSettings,"anthropic")));
assert.equal(anthropicChat.requests[0].url,"https://synthetic-anthropic.invalid/coding/v1/messages");
observations.push({id:"utility-anthropic-root-misses-v1",reproduced:true,utilityRequests:anthropicUtilityRequests,chatRequests:anthropicChat.requests});

// Headless catalog applies an older protocol ceiling than actual gateway tasks.
const profileDocs={deploymentProfiles:[{id:"deployment",enabled:true,models:[{id:"synthetic-model"}]}]};
const headlessCatalog=(protocol)=>listHostProfileGatewayModelOptions(profileDocs,{snapshot:true,providers:[{id:"deployment",protocol,enabled:true,credentialPool:1,models:[{id:"synthetic-model"}]}]});
const google=headlessCatalog("google"), gemini=headlessCatalog("gemini"), openai=headlessCatalog("openai");
assert.equal(google.length,0); assert.equal(gemini.length,0); assert.equal(openai.length,1);
observations.push({id:"headless-catalog-hides-native-gemini",reproduced:true,google,gemini,openai});
console.log(JSON.stringify(observations));
`

// Avoid importing any ambient provider key, proxy credential or settings path.
const child = spawnSync(
  process.execPath,
  ["--import", "tsx", "--input-type=module", "-e", childCode],
  {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NODE_ENV: "test" },
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  }
)
assert.equal(child.status, 0, child.stderr || child.stdout || String(child.error))
const observations = JSON.parse(child.stdout.trim())
const result = {
  scope:
    "Actual source resolution, model construction and SDK serialization with intercepted fetch; no live provider or real Host",
  sourceHashes,
  projection: {
    id: "utility-projection-drops-provider-identity-and-headers",
    reproduced: true,
    output: projected,
  },
  observations,
}
writeFileSync(resolve(output, "routing-probe-results.json"), `${JSON.stringify(result, null, 2)}\n`)
console.log(
  JSON.stringify({
    passed: observations.length + 1,
    output: ".cache/provider-configuration-mode-audit/routing-probe-results.json",
  })
)
