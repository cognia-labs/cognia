/** Stdio test transport to real Rust connector commands, never a JS fallback. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { deferred } from "./connector-loopback"

export function nativeReadyIdentity(
  frame: { runtime?: string; ipc?: string; pid?: number },
  pid: number | undefined,
  tauri: boolean
) {
  if (!tauri) return undefined
  if (frame.runtime !== "wry" || frame.ipc !== "webview-invoke" || !pid || frame.pid !== pid)
    throw new Error("Actual Tauri IPC runtime identity missing or mismatched")
  return { runtime: frame.runtime, ipc: frame.ipc, pid }
}

export class NativeConnectorBridge {
  readonly handles = new Set<string>()
  readonly profileId = randomUUID()
  origin = ""
  starts = 0
  crashes = 0
  readyStarts = 0
  private readonly sessions: { runtime: string; ipc: string; pid: number }[] = []
  private stopping = false
  private failure?: Error
  private lastExit?: { code: number | null; signal: NodeJS.Signals | null }
  private profile = ""
  private child?: ChildProcessWithoutNullStreams
  private exited?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  private sequence = 0
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  constructor(
    private readonly allowed: string,
    private readonly emit: (topic: string, payload: unknown) => void,
    private readonly testName?: string
  ) {}

  get pendingCount() {
    return this.pending.size
  }

  async start() {
    if (this.child) throw new Error("Native bridge already started")
    try {
      return await this.startProcess()
    } catch (error) {
      this.failure ??= error as Error
      await this.dispose()
      throw error
    }
  }

  private async startProcess() {
    const binary = process.env.COGNIA_IM_NATIVE_BINARY
    const expected = process.env.COGNIA_IM_NATIVE_DIGEST
    if (
      !binary ||
      !expected ||
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex") !== expected
    )
      throw new Error("Native build identity missing or stale; run pnpm im:test:native")
    if (!this.profile) {
      const directory = path.resolve(
        process.env.COGNIA_IM_NATIVE_REPORT_DIR ?? ".cache/test-results/im-native",
        "profiles"
      )
      await mkdir(directory, { recursive: true })
      this.profile = await mkdtemp(path.join(directory, "bridge-"))
      await writeFile(path.join(this.profile, "master.key"), randomBytes(32).toString("hex"), {
        mode: 0o600,
      })
    }
    const ready = deferred<void>()
    const child = spawn(binary, [this.profile, this.allowed], {
      env: {
        NODE_ENV: "test",
        HOME: this.profile,
        USERPROFILE: this.profile,
        APPDATA: path.join(this.profile, "data"),
        LOCALAPPDATA: path.join(this.profile, "cache"),
        XDG_DATA_HOME: path.join(this.profile, "data"),
        PATH: process.env.PATH,
        COGNIA_MASTER_KEY_FILE: path.join(this.profile, "master.key"),
      },
      stdio: "pipe",
    })
    this.child = child
    this.stopping = false
    this.starts++
    const lines = createInterface({ input: child.stdout })
    const timeout = setTimeout(
      () => ready.reject(new Error("Native bridge startup timed out")),
      10000
    )
    // Drain stderr without retaining credentials or callback bodies.
    child.stderr.resume()
    child.once("error", (error) => {
      this.failure = error
      ready.reject(error)
    })
    child.stdin.on("error", (error) => {
      if (!this.stopping) {
        this.failure = error
        ready.reject(error)
      }
    })
    this.exited = new Promise((resolve) =>
      child.once("close", (code, signal) => {
        lines.close()
        this.handles.clear()
        ready.reject(new Error(`Native bridge exited (${code ?? signal})`))
        for (const call of this.pending.values()) {
          clearTimeout(call.timer)
          call.reject(new Error("Native bridge exited"))
        }
        this.pending.clear()
        this.lastExit = { code, signal }
        if (!this.stopping) this.failure ??= new Error("Native bridge exited unexpectedly")
        resolve({ code, signal })
      })
    )
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line)
        if (value.ready) {
          const identity = nativeReadyIdentity(
            value,
            child.pid,
            process.env.COGNIA_IM_TAURI === "1"
          )
          if (identity) this.sessions.push(identity)
          this.origin = value.origin
          this.readyStarts++
          ready.resolve()
          return
        }
        if (typeof value.event === "string") {
          const match = /^connectors:\/\/ws\/([^/]+)\/(open|close)$/.exec(value.event)
          if (match?.[2] === "open") this.handles.add(match[1])
          if (match?.[2] === "close") this.handles.delete(match[1])
          this.emit(value.event, value.payload)
          return
        }
        const call = this.pending.get(value.id)
        if (call) {
          clearTimeout(call.timer)
          this.pending.delete(value.id)
          if (value.error) call.reject(new Error(value.error))
          else call.resolve(value.result)
        }
      } catch {
        this.failure = new Error("Invalid native bridge frame or event handler")
        ready.reject(this.failure)
      }
    })
    try {
      await ready.promise
    } finally {
      clearTimeout(timeout)
    }
    return this
  }

  call<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null)
      return Promise.reject(new Error("Native bridge is stopped"))
    const id = ++this.sequence
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Native command timed out: ${name}`))
      }, 15000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.child!.stdin.write(JSON.stringify({ id, name, args: args ?? {} }) + "\n")
    })
  }

  async stop(crash = false) {
    const child = this.child
    if (!child) return
    this.stopping = true
    let killSent = false
    if (crash) {
      killSent = child.kill("SIGKILL")
    } else if (child.exitCode === null && child.signalCode === null && !child.stdin.destroyed)
      child.stdin.end(JSON.stringify({ id: ++this.sequence, name: "fixture_shutdown" }) + "\n")
    const deadline = setTimeout(() => child.kill("SIGKILL"), 4000)
    try {
      const exit = await this.exited!
      if (crash) {
        if (!killSent || exit.signal !== "SIGKILL")
          throw new Error("Native process did not exit from the requested SIGKILL")
        this.crashes++
      }
      if (!crash && (exit.code !== 0 || exit.signal))
        throw new Error("Native bridge did not shut down cleanly")
    } catch (error) {
      this.failure ??= error as Error
      throw error
    } finally {
      clearTimeout(deadline)
      this.child = undefined
    }
  }

  async dispose() {
    let cleanupError = this.failure
    try {
      await this.stop()
    } catch (error) {
      cleanupError ??= error as Error
    } finally {
      // `close` drains stdout; a late event handler can fail during stop().
      cleanupError ??= this.failure
      if (this.profile) await rm(this.profile, { recursive: true, force: true })
      const directory = path.resolve(
        process.env.COGNIA_IM_NATIVE_REPORT_DIR ?? ".cache/test-results/im-native"
      )
      await mkdir(directory, { recursive: true })
      await writeFile(
        path.join(directory, `process-${this.profileId}.json`),
        JSON.stringify(
          {
            schema: "cognia.im-native-process/1",
            runId: process.env.COGNIA_IM_NATIVE_RUN,
            test: this.testName ?? expect.getState().currentTestName,
            sourceDigest: process.env.COGNIA_IM_NATIVE_SOURCE,
            binaryDigest: process.env.COGNIA_IM_NATIVE_DIGEST,
            starts: this.starts,
            readyStarts: this.readyStarts,
            crashes: this.crashes,
            exit: this.lastExit,
            cleanupError: cleanupError ? "Native process lifecycle failed" : undefined,
            lifecycle: cleanupError ? "failed" : "clean",
            pendingAfterCleanup: this.pending.size,
            socketsAfterCleanup: this.handles.size,
            profileRemoved: true,
            realPlatform: false,
            tauriSessions: this.sessions,
            boundary: this.sessions.length
              ? "Real Wry system webview invokes production Tauri commands; isolated encrypted store; optional Chromium operator UI; excludes full app boot, app ACL and vendor acceptance"
              : "Real Rust commands/router/events/encrypted store; stdio test transport, no Tauri GUI or vendor",
          },
          null,
          2
        ) + "\n"
      )
    }
    if (cleanupError) throw cleanupError
  }
}
