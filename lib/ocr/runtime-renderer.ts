/**
 * The OCR runtime in a window, desktop and phone alike (ADR-0024,
 * ADR-0250 §14): every built-in provider into the shared registry before any
 * surface extracts, and the native engines wired to their Tauri / Capacitor
 * invokers. It replaced the desktop's `OcrRuntimeInitializer`.
 *
 * `cloudFetch` is the cloud providers' single outbound seam: `proxyFetch`
 * routes them through the Rust proxy bridge on the desktop, where a renderer
 * `fetch` would meet the packaged shell's `connect-src` CSP and skip the
 * configured proxy. Off Tauri it passes through to the platform `fetch`.
 *
 * Installing is idempotent and holds nothing per account, so the restart an
 * account change brings keeps the registry: providers a plugin registered
 * stay until the plugin is disabled.
 */

import type { RendererRuntimeContext } from "@/lib/modules/manifest-types"

export async function start(ctx: Pick<RendererRuntimeContext, "log">): Promise<void> {
  const [{ installOcrRuntime }, { proxyFetch }] = await Promise.all([
    import("./runtime"),
    import("@/lib/network/proxy-fetch"),
  ])
  try {
    await installOcrRuntime({ cloudFetch: (input, init) => proxyFetch(input, init) })
  } catch (err) {
    ctx.log(
      "warn",
      `ocr runtime install failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}
