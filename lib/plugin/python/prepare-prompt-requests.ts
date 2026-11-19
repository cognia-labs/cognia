/**
 * Asking the user to prepare a Python plugin's environment (ENV01, ADR-0258).
 *
 * Installing a plugin does not install its Python dependencies: that downloads
 * packages and writes an environment, so it keeps its own consent. Right
 * after a user installs plugins (marketplace, Git, a local folder, a
 * cogpack), and when an enable fails because the environment is not ready,
 * the plugin is queued here; `PythonPreparePromptHost` asks the Host whether
 * there is anything to prepare and, if so, offers to prepare it now or
 * later, wherever the user is.
 *
 * Plugin ids, not questions: the host decides per plugin, from the Host's
 * readiness at the moment it is shown, whether to ask at all. A plugin
 * already queued is not queued twice. A headless Host has nobody to ask.
 */
import { isHeadlessHost } from "@/lib/platform/detect"

export interface PythonPreparePromptState {
  /** The plugin being asked about. */
  current: string | null
  queue: string[]
}

type Listener = (state: PythonPreparePromptState) => void

const listeners = new Set<Listener>()
let state: PythonPreparePromptState = { current: null, queue: [] }

function notify(): void {
  const snapshot = { current: state.current, queue: [...state.queue] }
  for (const listener of listeners) listener(snapshot)
}

export function requestPythonPreparePrompt(pluginId: string): void {
  if (isHeadlessHost()) return
  if (state.current === pluginId || state.queue.includes(pluginId)) return
  state = state.current
    ? { ...state, queue: [...state.queue, pluginId] }
    : { ...state, current: pluginId }
  notify()
}

/** The prompt for `pluginId` is done: prepared, put off, or nothing to ask. */
export function finishPythonPreparePrompt(pluginId: string): void {
  if (state.current === pluginId) {
    const [next = null, ...rest] = state.queue
    state = { current: next, queue: rest }
  } else {
    state = { ...state, queue: state.queue.filter((id) => id !== pluginId) }
  }
  notify()
}

export function subscribePythonPreparePrompts(listener: Listener): () => void {
  listeners.add(listener)
  listener({ current: state.current, queue: [...state.queue] })
  return () => {
    listeners.delete(listener)
  }
}

/** Test helper: drop every queued prompt. */
export function __resetPythonPreparePromptsForTests(): void {
  state = { current: null, queue: [] }
  notify()
}
