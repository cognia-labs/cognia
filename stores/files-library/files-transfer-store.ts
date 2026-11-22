/**
 * Session-scoped Files transfer center (G03): tracks per-file upload and zip
 * export tasks in memory (Zustand) with byte progress, AbortSignal cancellation,
 * and session-scoped retry callbacks, without persisting `File` blobs in Dexie
 * or coupling to the desktop-only SFTP Dexie queue.
 */

import { create } from "zustand"

export type FilesTransferKind = "upload" | "export-zip"

export type FilesTransferStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export interface FilesTransferTask {
  id: string
  kind: FilesTransferKind
  name: string
  status: FilesTransferStatus
  loadedBytes: number
  totalBytes: number
  error?: string
  createdAt: number
  updatedAt: number
  abortController?: AbortController
  retryFn?: () => Promise<void>
}

export interface EnqueueFilesTransferInput {
  kind: FilesTransferKind
  name: string
  totalBytes: number
  status?: "queued" | "running"
  abortController?: AbortController
  retryFn?: () => Promise<void>
}

interface FilesTransferState {
  tasks: FilesTransferTask[]
  open: boolean
  enqueueTask: (input: EnqueueFilesTransferInput) => string
  markRunning: (id: string, abortController?: AbortController) => void
  updateProgress: (id: string, loadedBytes: number, totalBytes?: number) => void
  markCompleted: (id: string) => void
  markFailed: (id: string, error: string) => void
  cancelTask: (id: string) => void
  retryTask: (id: string) => Promise<void>
  dismissTask: (id: string) => void
  clearFinished: () => void
  setOpen: (open: boolean) => void
  reset: () => void
}

let transferSeq = 0

function nextTransferId(): string {
  transferSeq += 1
  return `fxf_${Date.now()}_${transferSeq}`
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const name = (error as { name?: unknown }).name
  return name === "AbortError"
}

export const useFilesTransferStore = create<FilesTransferState>((set, get) => ({
  tasks: [],
  open: false,

  enqueueTask: (input) => {
    const id = nextTransferId()
    const now = Date.now()
    const totalBytes = Math.max(0, Number.isFinite(input.totalBytes) ? input.totalBytes : 0)
    const task: FilesTransferTask = {
      id,
      kind: input.kind,
      name: input.name,
      status: input.status ?? "queued",
      loadedBytes: 0,
      totalBytes,
      createdAt: now,
      updatedAt: now,
      ...(input.abortController ? { abortController: input.abortController } : {}),
      ...(input.retryFn ? { retryFn: input.retryFn } : {}),
    }
    set((state) => ({
      tasks: [task, ...state.tasks].slice(0, 200),
      open: true,
    }))
    return id
  },

  markRunning: (id, abortController) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id && task.status !== "cancelled"
          ? {
              ...task,
              status: "running",
              error: undefined,
              updatedAt: Date.now(),
              ...(abortController ? { abortController } : {}),
            }
          : task
      ),
    })),

  updateProgress: (id, loadedBytes, totalBytes) =>
    set((state) => ({
      tasks: state.tasks.map((task) => {
        if (task.id !== id || task.status === "cancelled") return task
        const nextTotal =
          totalBytes !== undefined && Number.isFinite(totalBytes)
            ? Math.max(0, totalBytes)
            : task.totalBytes
        const clampedLoaded =
          nextTotal > 0 ? Math.min(Math.max(0, loadedBytes), nextTotal) : Math.max(0, loadedBytes)
        return {
          ...task,
          loadedBytes: clampedLoaded,
          totalBytes: nextTotal,
          updatedAt: Date.now(),
        }
      }),
    })),

  markCompleted: (id) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id
          ? {
              ...task,
              status: "completed",
              loadedBytes: task.totalBytes,
              error: undefined,
              abortController: undefined,
              updatedAt: Date.now(),
            }
          : task
      ),
    })),

  markFailed: (id, error) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id && task.status !== "cancelled"
          ? {
              ...task,
              status: "failed",
              error,
              abortController: undefined,
              updatedAt: Date.now(),
            }
          : task
      ),
      open: true,
    })),

  cancelTask: (id) => {
    const target = get().tasks.find((task) => task.id === id)
    if (!target || (target.status !== "queued" && target.status !== "running")) return
    target.abortController?.abort()
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id
          ? {
              ...task,
              status: "cancelled",
              abortController: undefined,
              updatedAt: Date.now(),
            }
          : task
      ),
    }))
  },

  retryTask: async (id) => {
    const target = get().tasks.find((task) => task.id === id)
    if (!target?.retryFn) return
    if (target.status !== "failed" && target.status !== "cancelled") return
    await target.retryFn()
  },

  dismissTask: (id) =>
    set((state) => {
      const target = state.tasks.find((task) => task.id === id)
      if (target && (target.status === "queued" || target.status === "running")) {
        target.abortController?.abort()
      }
      return { tasks: state.tasks.filter((task) => task.id !== id) }
    }),

  clearFinished: () =>
    set((state) => ({
      tasks: state.tasks.filter(
        (task) => task.status !== "completed" && task.status !== "cancelled"
      ),
    })),

  setOpen: (open) => set({ open }),

  reset: () => set({ tasks: [], open: false }),
}))
