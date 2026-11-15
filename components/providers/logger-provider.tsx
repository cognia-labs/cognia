"use client"

/**
 * LoggerProvider — boots the unified logging system for the renderer.
 *
 * It owns three effects and nothing else: the one `bootstrapLogger()` call,
 * the global uncaught-error / unhandled-rejection capture, and (on Tauri) the
 * Rust → renderer log bridge. Code that logs imports `loggers` / `createLogger`
 * from `@/lib/logging` directly; there is no React logging context.
 */

import { useEffect, useState, type ReactNode } from "react"
import { bootstrapLogger } from "@/lib/logging"
import { cleanupTauriLogBridge, initTauriLogBridge } from "@/lib/native/tauri-log-bridge"
import { getNativeLoggingReadiness } from "@/lib/native/native-logging"
import { installGlobalErrorHandlers } from "@cognia/logging/global-error-handlers"
import { isTauri } from "@/lib/tauri"

export function LoggerProvider({ children }: { children: ReactNode }) {
  // Bootstrap once, during the first render, so every child effect that logs
  // already sees the persisted level and transports.
  useState(() => bootstrapLogger())

  // Install global uncaught-error / unhandled-rejection capture. Runs on web
  // *and* desktop — on web it feeds the recent-errors ring (so the error page
  // can export them), on desktop it additionally reaches the native log file +
  // crash breadcrumbs. The handler is idempotent; this returns the cleanup.
  useEffect(() => {
    return installGlobalErrorHandlers()
  }, [])

  // Bridge Rust → frontend log records via the `log://log` event emitted by
  // tauri-plugin-log's webview target. Without this, native logs never reach
  // the in-app Log Panel. Also kicks off a one-shot readiness query so the
  // settings panel can surface platform-logging health on first paint.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void initTauriLogBridge().then(() => {
      if (cancelled) return
      void getNativeLoggingReadiness()
    })
    return () => {
      cancelled = true
      void cleanupTauriLogBridge()
    }
  }, [])

  return <>{children}</>
}
