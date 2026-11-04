import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"

import { aiSdkTelemetry, initializeTelemetry, shutdownTelemetry } from "./index.ts"
import { sanitizeLangfuseReadableSpan } from "./langfuse.ts"

for (const [name, executable] of [
  ["node", process.execPath],
  ["bun", process.env.COGNIA_TEST_BUN],
] as const) {
  test(`an unconfigured ${name} process never loads exporter SDKs`, { skip: !executable }, () => {
    const moduleUrl = new URL("./index.ts", import.meta.url).href
    const source = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      const { initializeTelemetry } = await import(${JSON.stringify(moduleUrl)});
      assert.equal(await initializeTelemetry({}), false);
      const loaded = Object.keys(createRequire(${JSON.stringify(moduleUrl)}).cache)
        .filter(file => /node_modules\\/(?:@opentelemetry\\/(?:sdk-node|sdk-trace-base|exporter-trace-otlp-http)|@posthog\\/ai)\\//.test(file));
      assert.equal(loaded.length, 0, loaded.slice(0, 3).join('\\n'));
    `
    const result = spawnSync(
      executable!,
      [...(name === "bun" ? ["--no-env-file"] : []), "--input-type=module", "--eval", source],
      { encoding: "utf8", timeout: 15_000 }
    )
    assert.equal(result.status, 0, result.stderr || String(result.error))
  })
}

/** A partial span literal standing in for the SDK's ReadableSpan. */
const span = (value: object): ReadableSpan => value as unknown as ReadableSpan

test("AI SDK telemetry is enabled only after configuration and never records content", async () => {
  // No OTLP endpoint configured → no telemetry options are ever attached to a
  // call. This is what keeps an unconfigured sidecar completely silent: AI SDK 7
  // telemetry is opt-OUT once an integration is registered, so registration is
  // deliberately tied to `initializeTelemetry` succeeding.
  assert.equal(aiSdkTelemetry({ provider: "openai" }), undefined)
  assert.equal(
    await initializeTelemetry({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
      OTEL_SERVICE_NAME: "test-sidecar",
    }),
    true
  )
  const options = aiSdkTelemetry({
    sessionId: "session-1",
    traceId: "a".repeat(32),
    surface: "chat",
    runId: "run-1",
    turnId: "turn-1",
    attemptId: "attempt-1",
    projectId: "project-1",
    feature: "chat",
    promptComponentIds: ["system.base", "mode.agent"],
    promptVersion: "7",
    promptFingerprint: "sha256:abc",
    provider: "openai",
  })
  assert.ok(options)
  // v7 removed both of these from the per-call options: telemetry is on by
  // default once registered, and a custom tracer now belongs to the
  // `OpenTelemetry` instance passed to `registerTelemetry`.
  const raw = options as unknown as Record<string, unknown>
  assert.equal(raw.isEnabled, undefined)
  assert.equal(raw.tracer, undefined)
  // Privacy contract, unchanged across the upgrade: no prompt or completion
  // content may enter a span.
  assert.equal(options.recordInputs, false)
  assert.equal(options.recordOutputs, false)
  assert.equal(options.functionId, "cognia.sidecar.openai")
  assert.equal(raw.metadata, undefined)
  assert.deepEqual(options.runtimeContext, {
    cogniaSessionId: "session-1",
    cogniaTraceId: "a".repeat(32),
    cogniaSurface: "chat",
    cogniaRunId: "run-1",
    cogniaTurnId: "turn-1",
    cogniaAttemptId: "attempt-1",
    cogniaProjectId: "project-1",
    cogniaFeature: "chat",
    cogniaPromptComponentIds: ["system.base", "mode.agent"],
    cogniaPromptVersion: "7",
    cogniaPromptFingerprint: "sha256:abc",
  })
  assert.deepEqual(options.includeRuntimeContext, {
    cogniaSessionId: true,
    cogniaTraceId: true,
    cogniaSurface: true,
    cogniaRunId: true,
    cogniaTurnId: true,
    cogniaAttemptId: true,
    cogniaProjectId: true,
    cogniaFeature: true,
    cogniaPromptComponentIds: true,
    cogniaPromptVersion: true,
    cogniaPromptFingerprint: true,
  })

  // A second init must not register the integration again — `registerTelemetry`
  // appends to a process-global list, so a duplicate would double every span.
  assert.equal(
    await initializeTelemetry({
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
    }),
    false
  )
  await shutdownTelemetry()
})

test("PostHog-only configuration initializes telemetry without a generic OTLP endpoint", async () => {
  assert.equal(
    await initializeTelemetry({
      COGNIA_POSTHOG_DESTINATIONS_JSON: JSON.stringify([
        {
          id: "managed",
          host: "https://us.i.posthog.com",
          projectToken: "phc_test",
        },
      ]),
      COGNIA_OBSERVABILITY_INSTALLATION_ID: "installation-1",
    }),
    true
  )
  const options = aiSdkTelemetry({ sessionId: "session-2", provider: "anthropic" })
  assert.equal(options?.recordInputs, false)
  assert.equal(options?.recordOutputs, false)
  await shutdownTelemetry()
})

test("Langfuse-only configuration enables AI SDK content only after explicit consent", async () => {
  const langfuseEnv: Record<string, string | undefined> = {
    LANGFUSE_PUBLIC_KEY: "pk-test",
    LANGFUSE_SECRET_KEY: "sk-test",
    LANGFUSE_BASE_URL: "https://langfuse.example",
    LANGFUSE_ENVIRONMENT: "test",
    COGNIA_LANGFUSE_CAPTURE_MODEL_CONTENT: "false",
    COGNIA_LANGFUSE_CAPTURE_TOOL_CONTENT: "true",
  }
  assert.equal(await initializeTelemetry(langfuseEnv), true)
  assert.equal(langfuseEnv.LANGFUSE_SECRET_KEY, undefined)
  const options = aiSdkTelemetry({ sessionId: "session-3", provider: "openai" })
  assert.equal(options?.recordInputs, true)
  assert.equal(options?.recordOutputs, true)

  const model = sanitizeLangfuseReadableSpan(
    span({
      attributes: {
        "langfuse.observation.type": "generation",
        "langfuse.observation.input": "model input",
        "langfuse.observation.output": "model output",
      },
    })
  )
  const tool = sanitizeLangfuseReadableSpan(
    span({
      name: "tool.search",
      status: { code: 2, message: "jane.doe@example.com" },
      events: [{ name: "exception", attributes: { message: "private stack" } }],
      attributes: {
        "langfuse.observation.type": "tool",
        "langfuse.observation.input": "tool input",
        "langfuse.observation.output": "tool output",
      },
    })
  )
  assert.equal(model?.attributes["langfuse.observation.input"], undefined)
  assert.equal(model?.attributes["langfuse.observation.output"], undefined)
  assert.equal(tool?.attributes["langfuse.observation.input"], "tool input")
  assert.equal(tool?.attributes["langfuse.observation.output"], "tool output")
  assert.deepEqual(tool?.status, { code: 2 })
  assert.deepEqual(tool?.events, [])
  await shutdownTelemetry()
})

test("an unconfigured process stays silent", async () => {
  assert.equal(await initializeTelemetry({}), false)
  assert.equal(aiSdkTelemetry({ provider: "openai" }), undefined)
  await shutdownTelemetry()
})

test("a concurrent unconfigured init cannot suppress a configured init", async () => {
  try {
    assert.deepEqual(
      await Promise.all([
        initializeTelemetry({}),
        initializeTelemetry({
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
        }),
        initializeTelemetry({
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
        }),
      ]),
      [false, true, false]
    )
    assert.ok(aiSdkTelemetry({ provider: "openai" }))
  } finally {
    await shutdownTelemetry()
  }
})

test("shutdown waits for pending exporter initialization and clears the session", async () => {
  const pending = initializeTelemetry({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
  })
  const stopping = shutdownTelemetry()
  assert.equal(await pending, true)
  await stopping
  assert.equal(aiSdkTelemetry({ provider: "openai" }), undefined)
})

test("shutdown cancels configured initialization already queued behind a silent init", async () => {
  const silent = initializeTelemetry({})
  const configured = initializeTelemetry({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:4318/v1/traces",
  })
  const stopping = shutdownTelemetry()
  try {
    assert.deepEqual(await Promise.all([silent, configured, stopping]), [false, false, undefined])
    assert.equal(aiSdkTelemetry({ provider: "openai" }), undefined)
  } finally {
    await shutdownTelemetry()
  }
})

test("configured initialization waits for delayed AI SDK integration registration", () => {
  const source = `
    import assert from 'node:assert/strict';
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      if (context.parentURL?.endsWith('/platform/telemetry/index.ts')) {
        const code = specifier === 'ai'
          ? 'export function registerTelemetry() { globalThis.integrationRegistered = true; }'
          : specifier === '@langfuse/vercel-ai-sdk'
            ? 'await new Promise(resolve => setTimeout(resolve, 100)); export class LangfuseVercelAiSdkIntegration {}'
            : undefined;
        if (code) return { url: 'data:text/javascript,' + encodeURIComponent(code), shortCircuit: true };
      }
      return next(specifier, context);
    } });
    const { initializeTelemetry, shutdownTelemetry } = await import(${JSON.stringify(new URL("./index.ts", import.meta.url).href)});
    assert.equal(await initializeTelemetry({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' }), true);
    assert.equal(globalThis.integrationRegistered, true, 'configured readiness must include AI SDK registration');
    await shutdownTelemetry();
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, OTEL_SDK_DISABLED: "true" },
  })
  assert.equal(result.status, 0, result.stderr || String(result.error))
})

test(
  "configured exporters work in a relocated dependency-free release-style bundle",
  {
    timeout: 60_000,
  },
  async () => {
    const { build } = await import("esbuild")
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      write: false,
      // Match the ESM require shim used by build-cli-binary.mjs.
      banner: {
        js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
      },
    })
    // Outside the checkout: ancestor node_modules must not rescue an omitted dep.
    const directory = await mkdtemp(path.join(os.tmpdir(), "cognia-telemetry-bundle-"))
    try {
      const entry = path.join(directory, "telemetry.mjs")
      await writeFile(entry, bundle.outputFiles[0]!.contents)
      const source = `
      import assert from 'node:assert/strict';
      const { initializeTelemetry, shutdownTelemetry } = await import(${JSON.stringify(pathToFileURL(entry).href)});
      for (const env of [
        { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:4318/v1/traces' },
        { COGNIA_POSTHOG_DESTINATIONS_JSON: JSON.stringify([{ id:'fixture', host:'https://posthog.example', projectToken:'phc_test' }]) },
        { LANGFUSE_PUBLIC_KEY:'pk-test', LANGFUSE_SECRET_KEY:'sk-test', LANGFUSE_BASE_URL:'https://langfuse.example' },
      ]) {
        assert.equal(await initializeTelemetry(env), true);
        await shutdownTelemetry();
      }
      console.log('BUNDLE_TELEMETRY_OK');
    `
      for (const executable of [process.execPath, process.env.COGNIA_TEST_BUN].filter(Boolean)) {
        const result = spawnSync(executable!, ["--input-type=module", "--eval", source], {
          cwd: directory,
          env: {
            PATH: process.env.PATH,
            HOME: directory,
            NODE_ENV: "production",
            OTEL_SDK_DISABLED: "true",
          },
          encoding: "utf8",
          timeout: 30_000,
        })
        assert.equal(result.status, 0, result.stderr || String(result.error))
        assert.match(result.stdout, /BUNDLE_TELEMETRY_OK/)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)
