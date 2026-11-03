"use client"

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  ArrowUpIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  FolderOpenIcon,
  PencilIcon,
  RotateCwIcon,
  SearchIcon,
  ServerIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { defaultExportDir } from "@/lib/claude/ipc"
import { listWorkspaceDir, listWorkspaceRoots } from "@/lib/files/workspace-fs"
import type { WorkspaceEntry, WorkspaceRoot } from "@/lib/files/types"
import { cn } from "@/lib/utils"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPath?: string
  onSelect: (path: string) => void
}

/** The rel of a root itself. Children carry a real, `/`-separated relPath. */
const ROOT_REL = ""
/** Fixed row height: the list is virtualized, so rows must not size themselves. */
const ROW_HEIGHT = 34

/**
 * Why a listing failed. The Host refusing the path is not the same problem as
 * the Host being unreachable.
 *
 * Both used to render "This folder could not be opened. Check the path and
 * server connection.", which sends the user to debug a connection that is
 * working. A headless Host confines browsing to its workspaces root
 * (`COGNIA_WORKSPACES_DIR`, default `<data dir>/workspaces`) and answers
 * anything outside it with a non-retryable refusal that names that root, so the
 * one fact that resolves the situation was being thrown away.
 */
interface LoadFailure {
  kind: "refused" | "unreachable"
  /** The Host's own words, when it gave any. */
  detail: string | null
}

/**
 * A Host refusal is shape-checked, not `instanceof`-checked: the error crosses
 * a module boundary, and every companion error carries `code` + `retryable`.
 * `retryable: false` is the Host saying "this will not work however many times
 * you ask", which is exactly the distinction the UI needs to draw.
 */
function classifyLoadFailure(error: unknown): LoadFailure {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; retryable?: unknown }
    if (typeof candidate.code === "string" && candidate.retryable === false) {
      const message = error instanceof Error ? error.message.trim() : ""
      return { kind: "refused", detail: message || null }
    }
  }
  return { kind: "unreachable", detail: null }
}

function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "")
  if (!trimmed || trimmed === "/" || /^[A-Za-z]:$/.test(trimmed)) return null
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  if (separatorIndex < 0) return null
  if (separatorIndex === 0) return "/"
  if (separatorIndex === 2 && /^[A-Za-z]:/.test(trimmed)) return `${trimmed.slice(0, 2)}\\`
  return trimmed.slice(0, separatorIndex)
}

/**
 * Compare host paths without pretending to know the host OS. Separators are
 * folded because a Windows Host answers with backslashes while a user pastes
 * either, but case is left alone: folding it would make two distinct
 * directories look like one on the Linux and macOS hosts this mostly runs on.
 */
function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

/** The path of `target` relative to `root`, or null when it is not inside it. */
function relativeToRoot(root: string, target: string): string | null {
  const base = normalizeForCompare(root)
  const path = normalizeForCompare(target)
  if (path === base) return ROOT_REL
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null
}

function parentRel(rel: string): string {
  const index = rel.lastIndexOf("/")
  return index < 0 ? ROOT_REL : rel.slice(0, index)
}

function displayName(rel: string, root: string): string {
  if (rel) return rel.split("/").pop() ?? rel
  const trimmed = normalizeForCompare(root)
  return trimmed.split("/").pop() || root
}

/** Absolute path of `rel` under `root`, in the separator style the root uses. */
function joinPath(root: string, rel: string): string {
  if (!rel) return root
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/"
  const base = root.replace(/[\\/]+$/, "")
  return `${base}${separator}${separator === "/" ? rel : rel.replace(/\//g, "\\")}`
}

/** Cache key for one directory listing. NUL cannot appear in a path. */
function listingKey(root: string, rel: string): string {
  return `${normalizeForCompare(root)}\u0000${rel}`
}

/**
 * One folder's listing. `loading` keeps the rows it is replacing, if any, so a
 * reload dims the list in place instead of blanking it.
 */
type Listing =
  | { status: "loading"; folders: WorkspaceEntry[] | null }
  | { status: "ready"; folders: WorkspaceEntry[] }
  | { status: "error"; failure: LoadFailure }

interface Location {
  root: string
  rel: string
}

/** Which way the last move went, for the list's slide-in. */
type Travel = "into" | "out" | "jump"

const TRAVEL_ANIMATION: Record<Travel, string> = {
  into: "slide-in-from-right-3",
  out: "slide-in-from-left-3",
  jump: "zoom-in-[0.99]",
}

/**
 * Browse folders on the Host that runs the agent — a paired server, or this
 * desktop — and return the absolute path the user picks.
 *
 * One directory at a time, not a tree. The tree mounted every expanded level
 * at once with no windowing, so a remote monorepo or a home directory turned
 * into thousands of rows and a recursive render, and its "select a row, then
 * choose" model did not survive a touch screen. Here a click enters a folder,
 * the breadcrumb is the way back, and "Choose" takes the folder you are in.
 *
 * The Host can be a network round trip away, so listings are fetched once per
 * folder per opening of the dialog and kept: going back is instant, a request
 * already in flight for a folder is joined rather than repeated, and because a
 * result is stored under its own folder's key, a slow answer for a folder the
 * user already left can never land in the one they are looking at. Hovering a
 * row long enough to mean it prefetches that folder. Reload re-asks the Host.
 */
export function WorkspaceFolderPicker({ open, onOpenChange, initialPath, onSelect }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        Header and footer stay put, the body scrolls. With no height cap the
        dialog ran past a short window, which put the Choose button, the one
        control that finishes the task, out of reach.
      */}
      <DialogContent className="flex max-h-[min(90dvh,44rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        {/* Radix unmounts the content on close, so every opening mounts a
            fresh browser that starts from what the Host says now. */}
        <FolderBrowser
          initialPath={initialPath}
          onCancel={() => onOpenChange(false)}
          onChoose={(path) => {
            onSelect(path)
            onOpenChange(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

interface FolderBrowserProps {
  initialPath?: string
  onCancel: () => void
  onChoose: (path: string) => void
}

function FolderBrowser({ initialPath, onCancel, onChoose }: FolderBrowserProps) {
  const t = useTranslations("workspace.manage.remotePicker")

  /** Set on unmount: answers arriving after the dialog closed are dropped. */
  const disposedRef = useRef(false)
  const inflightRef = useRef(new Map<string, Promise<void>>())
  const [listings, setListings] = useState<Record<string, Listing>>({})
  const [roots, setRoots] = useState<WorkspaceRoot[]>([])
  const [location, setLocation] = useState<Location | null>(null)
  /** The last folder shown in full, held on screen while the next one loads. */
  const [heldKey, setHeldKey] = useState<string | null>(null)
  const [startFailure, setStartFailure] = useState<LoadFailure | null>(null)
  const [travel, setTravel] = useState<Travel>("jump")
  const [filter, setFilter] = useState("")
  const [showHidden, setShowHidden] = useState(false)
  const [editingPath, setEditingPath] = useState(false)
  const [pathDraft, setPathDraft] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)

  // The callbacks below read the latest cache and location through refs so
  // their identities stay stable for the effect and timers that hold them.
  const listingsRef = useRef(listings)
  const locationRef = useRef(location)
  useLayoutEffect(() => {
    listingsRef.current = listings
    locationRef.current = location
  }, [listings, location])

  const loadListing = useCallback((root: string, rel: string, force = false): Promise<void> => {
    const key = listingKey(root, rel)
    const existing = inflightRef.current.get(key)
    if (existing) return existing
    const cached = listingsRef.current[key]
    if (!force && cached?.status === "ready") return Promise.resolve()
    setListings((previous) => ({
      ...previous,
      [key]: {
        status: "loading",
        folders: cached?.status === "ready" ? cached.folders : null,
      },
    }))
    const request = listWorkspaceDir(root, rel || undefined)
      .then(
        (entries): Listing => ({
          status: "ready",
          folders: entries.filter((entry) => entry.isDir),
        }),
        (error): Listing => ({ status: "error", failure: classifyLoadFailure(error) })
      )
      .then((listing) => {
        if (!disposedRef.current) setListings((previous) => ({ ...previous, [key]: listing }))
      })
      .finally(() => {
        if (inflightRef.current.get(key) === request) inflightRef.current.delete(key)
      })
    inflightRef.current.set(key, request)
    return request
  }, [])

  const navigate = useCallback(
    (root: string, rel: string, how: Travel) => {
      const target = root.trim()
      if (!target) return
      const leaving = locationRef.current
      if (leaving) {
        const leavingKey = listingKey(leaving.root, leaving.rel)
        if (listingsRef.current[leavingKey]?.status === "ready") setHeldKey(leavingKey)
      }
      // Updated now, not after the commit: two hops in one tick must each see
      // the folder the previous one moved to.
      locationRef.current = { root: target, rel }
      setLocation({ root: target, rel })
      setTravel(how)
      setFilter("")
      setActiveIndex(0)
      setEditingPath(false)
      setStartFailure(null)
      void loadListing(target, rel)
    },
    [loadListing]
  )

  useEffect(() => {
    disposedRef.current = false
    void (async () => {
      // An old Host answers `unknown_command` here, which resolves to an empty
      // list rather than throwing. Empty means "this Host did not say", so the
      // fallback below still has to run.
      const reported = await listWorkspaceRoots()
      if (disposedRef.current) return
      setRoots(reported)
      const requested = initialPath?.trim()
      if (requested) {
        const containing = reported.find((root) => relativeToRoot(root.path, requested) !== null)
        if (containing) {
          navigate(containing.path, relativeToRoot(containing.path, requested) ?? ROOT_REL, "jump")
        } else {
          navigate(requested, ROOT_REL, "jump")
        }
        return
      }
      if (reported.length > 0) {
        navigate(reported[0].path, ROOT_REL, "jump")
        return
      }
      try {
        const fallback = await defaultExportDir()
        if (!disposedRef.current) navigate(fallback, ROOT_REL, "jump")
      } catch (error) {
        if (!disposedRef.current) setStartFailure(classifyLoadFailure(error))
      }
    })()
    return () => {
      disposedRef.current = true
    }
  }, [initialPath, navigate])

  const currentKey = location ? listingKey(location.root, location.rel) : null
  const current = currentKey ? listings[currentKey] : undefined
  const loading = location !== null && (current === undefined || current.status === "loading")
  const failure = current?.status === "error" ? current.failure : startFailure

  // While the next folder loads, keep the one being left on screen (dimmed and
  // inert) rather than flashing a skeleton for every hop on a fast Host. A
  // reload keeps its own rows the same way.
  const held = heldKey ? listings[heldKey] : undefined
  const shown =
    current?.status === "ready" && currentKey ? { key: currentKey, folders: current.folders } : null
  const stale = shown
    ? null
    : current?.status === "loading" && current.folders && currentKey
      ? { key: currentKey, folders: current.folders }
      : loading && held?.status === "ready" && heldKey
        ? { key: heldKey, folders: held.folders }
        : null
  const folders = shown?.folders ?? stale?.folders ?? null

  const hiddenCount = useMemo(
    () => (folders ? folders.filter(isHiddenFolder).length : 0),
    [folders]
  )
  const deferredFilter = useDeferredValue(filter.trim().toLowerCase())
  const visible = useMemo(() => {
    if (!folders) return []
    return folders.filter((entry) => {
      if (!showHidden && isHiddenFolder(entry)) return false
      if (!deferredFilter) return true
      return displayName(entry.relPath, "").toLowerCase().includes(deferredFilter)
    })
  }, [deferredFilter, folders, showHidden])

  const boundedActive = Math.min(activeIndex, Math.max(visible.length - 1, 0))

  const declaredRoot = location
    ? roots.find((root) => samePath(root.path, location.root))
    : undefined
  const atRoot = location?.rel === ROOT_REL
  const parentOfRoot = location && atRoot ? parentDirectory(location.root) : null
  // A declared root is a wall: the Host refuses anything above it.
  const canGoUp = Boolean(location) && (!atRoot || (!declaredRoot && parentOfRoot !== null))
  const goUp = useCallback(() => {
    if (!location) return
    if (location.rel !== ROOT_REL) navigate(location.root, parentRel(location.rel), "out")
    else if (!declaredRoot && parentOfRoot) navigate(parentOfRoot, ROOT_REL, "out")
  }, [declaredRoot, location, navigate, parentOfRoot])

  const enter = useCallback(
    (entry: WorkspaceEntry) => {
      if (location) navigate(location.root, entry.relPath, "into")
    },
    [location, navigate]
  )

  // Hover intent prefetch: a pointer that rests on a row for a moment is about
  // to open it, so the round trip starts before the click instead of after.
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPrefetch = useCallback(() => {
    if (prefetchTimer.current) clearTimeout(prefetchTimer.current)
    prefetchTimer.current = null
  }, [])
  const prefetch = useCallback(
    (entry: WorkspaceEntry) => {
      cancelPrefetch()
      if (!location) return
      const root = location.root
      prefetchTimer.current = setTimeout(() => void loadListing(root, entry.relPath), 180)
    },
    [cancelPrefetch, loadListing, location]
  )
  useEffect(() => cancelPrefetch, [cancelPrefetch])

  const submitPath = useCallback(
    (raw: string) => {
      const target = raw.trim()
      if (!target) return
      const containing = roots.find((root) => relativeToRoot(root.path, target) !== null)
      if (containing) {
        navigate(containing.path, relativeToRoot(containing.path, target) ?? ROOT_REL, "jump")
        return
      }
      // Not inside anything the Host declared. Try it anyway as its own root:
      // a desktop Host browses any absolute path the local user names, and only
      // the Host can say whether this one is refused.
      navigate(target, ROOT_REL, "jump")
    },
    [navigate, roots]
  )

  const moveActive = useCallback(
    (index: number) => {
      if (visible.length === 0) return
      setActiveIndex(Math.max(0, Math.min(visible.length - 1, index)))
    },
    [visible.length]
  )

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowDown") moveActive(boundedActive + 1)
    else if (event.key === "ArrowUp") moveActive(boundedActive - 1)
    else if (event.key === "Home") moveActive(0)
    else if (event.key === "End") moveActive(visible.length - 1)
    else if (event.key === "PageDown") moveActive(boundedActive + 8)
    else if (event.key === "PageUp") moveActive(boundedActive - 8)
    else if ((event.key === "Enter" || event.key === "ArrowRight") && visible[boundedActive]) {
      enter(visible[boundedActive])
    } else if (event.key === "Backspace" || event.key === "ArrowLeft") {
      if (event.currentTarget instanceof HTMLInputElement && event.key === "ArrowLeft") return
      if (event.currentTarget instanceof HTMLInputElement && filter) return
      goUp()
    } else return
    event.preventDefault()
  }

  // The Host's own absolute path for a folder, read from its parent's listing:
  // a Windows Host or a symlinked root spells it differently from a join.
  const absoluteOf = (root: string, rel: string): string => {
    if (rel === ROOT_REL) return root
    const parent = listings[listingKey(root, parentRel(rel))]
    const entry =
      parent?.status === "ready" ? parent.folders.find((folder) => folder.relPath === rel) : null
    return entry?.absolutePath ?? joinPath(root, rel)
  }
  const currentPath = location ? absoluteOf(location.root, location.rel) : ""
  const crumbs = location
    ? [
        { rel: ROOT_REL, name: displayName(ROOT_REL, location.root) },
        ...location.rel
          .split("/")
          .filter(Boolean)
          .map((name, index, all) => ({ rel: all.slice(0, index + 1).join("/"), name })),
      ]
    : []

  // Keep the deepest crumb in view: the trail scrolls, it never wraps.
  const crumbsRef = useRef<HTMLOListElement>(null)
  useLayoutEffect(() => {
    const trail = crumbsRef.current
    if (trail) trail.scrollLeft = trail.scrollWidth
  }, [currentPath])

  const ready = current?.status === "ready"

  return (
    <>
      <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
        <DialogTitle className="flex items-center gap-2">
          <ServerIcon aria-hidden className="size-4 text-muted-foreground" />
          {t("title")}
        </DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:h-[min(28rem,62dvh)] sm:flex-none sm:flex-row sm:overflow-hidden"
        data-testid="workspace-folder-body"
      >
        {roots.length > 0 ? (
          <nav
            aria-label={t("rootsLabel")}
            className="shrink-0 border-b bg-muted/20 sm:w-52 sm:overflow-y-auto sm:border-e sm:border-b-0"
          >
            <p className="hidden px-4 pt-3 pb-1.5 text-[0.7rem] font-medium tracking-wide text-muted-foreground uppercase sm:block">
              {t("rootsLabel")}
            </p>
            <ul className="flex gap-1.5 overflow-x-auto px-3 py-2 [scrollbar-width:none] sm:flex-col sm:gap-0.5 sm:px-2 sm:pt-0">
              {roots.map((root) => {
                const active = Boolean(location) && samePath(root.path, location!.root)
                return (
                  <li key={root.path} className="min-w-0 max-w-full shrink-0 sm:shrink">
                    <button
                      type="button"
                      onClick={() => navigate(root.path, ROOT_REL, "jump")}
                      aria-label={t("openRootAction", { path: root.path })}
                      aria-current={active ? "location" : undefined}
                      title={root.path}
                      className={cn(
                        "flex w-full max-w-[16rem] min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors sm:max-w-none sm:border-transparent",
                        active
                          ? "border-border bg-background text-foreground shadow-xs sm:border-border/60"
                          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                      )}
                    >
                      <FolderIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate text-xs font-medium">
                          {displayName(ROOT_REL, root.path)}
                        </span>
                        <span className="truncate font-mono text-[0.65rem] text-muted-foreground">
                          {root.path}
                        </span>
                        <span className="hidden text-[0.65rem] leading-snug text-muted-foreground/80 sm:block">
                          {root.source === "headless-workspaces-dir"
                            ? t("rootHeadless")
                            : t("rootDesktop")}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>
        ) : null}

        {/* `group/browser`: the keyboard's active row is painted only while
            focus is in here — on a touch screen an unasked-for highlight on the
            first folder reads as a selection. Hover paints it either way. */}
        <section className="group/browser flex min-h-0 min-w-0 flex-1 flex-col">
          {/* Toolbar: up, the trail (or the path field), reload. */}
          <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!canGoUp}
              aria-label={t("up")}
              title={location && atRoot && declaredRoot ? t("upConfined") : t("up")}
              onClick={goUp}
            >
              <ArrowUpIcon className="size-4" />
            </Button>

            {editingPath || !location ? (
              <form
                className="flex min-w-0 flex-1 items-center gap-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  submitPath(pathDraft)
                }}
              >
                <Input
                  // Opened on demand, so focus belongs here.
                  autoFocus={editingPath}
                  value={pathDraft}
                  onChange={(event) => setPathDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && location) {
                      event.preventDefault()
                      event.stopPropagation()
                      setEditingPath(false)
                    }
                  }}
                  aria-label={t("pathLabel")}
                  placeholder={t("pathPlaceholder")}
                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  className="h-7"
                  disabled={!pathDraft.trim()}
                >
                  {t("go")}
                </Button>
              </form>
            ) : (
              <>
                <ol
                  ref={crumbsRef}
                  aria-label={t("breadcrumb")}
                  className="flex min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none]"
                >
                  {crumbs.map((crumb, index) => {
                    const last = index === crumbs.length - 1
                    return (
                      <li key={crumb.rel || "/"} className="flex shrink-0 items-center">
                        {index > 0 ? (
                          <ChevronRightIcon
                            aria-hidden
                            className="size-3 text-muted-foreground/50"
                          />
                        ) : null}
                        <button
                          type="button"
                          disabled={last}
                          aria-current={last ? "location" : undefined}
                          title={absoluteOf(location.root, crumb.rel)}
                          onClick={() => navigate(location.root, crumb.rel, "out")}
                          className={cn(
                            "max-w-[12rem] truncate rounded px-1.5 py-0.5 text-xs transition-colors",
                            last
                              ? "font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                          )}
                        >
                          {crumb.name}
                        </button>
                      </li>
                    )
                  })}
                </ol>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("editPath")}
                  title={t("editPath")}
                  onClick={() => {
                    setPathDraft(currentPath)
                    setEditingPath(true)
                  }}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
              </>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={!location || loading}
              aria-label={t("refresh")}
              title={t("refresh")}
              onClick={() => location && void loadListing(location.root, location.rel, true)}
            >
              {loading ? <Spinner className="size-3.5" /> : <RotateCwIcon className="size-3.5" />}
            </Button>
          </div>

          {/* Filter + hidden toggle, only once there is a listing to act on. */}
          {folders && !failure ? (
            <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
              <div className="relative min-w-0 flex-1">
                <SearchIcon
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value)
                    setActiveIndex(0)
                  }}
                  onKeyDown={onListKeyDown}
                  aria-label={t("filterLabel")}
                  aria-controls="workspace-folder-list"
                  aria-activedescendant={
                    visible.length > 0 ? folderOptionId(boundedActive) : undefined
                  }
                  placeholder={t("filterPlaceholder")}
                  className="h-7 ps-7 pe-7 text-xs"
                />
                {filter ? (
                  <button
                    type="button"
                    aria-label={t("clearFilter")}
                    onClick={() => setFilter("")}
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="size-3" />
                  </button>
                ) : null}
              </div>
              {hiddenCount > 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={showHidden}
                  onClick={() => setShowHidden((value) => !value)}
                  className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
                >
                  {showHidden ? (
                    <EyeOffIcon className="size-3.5" />
                  ) : (
                    <EyeIcon className="size-3.5" />
                  )}
                  {showHidden ? t("hideHidden") : t("showHidden", { count: hiddenCount })}
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* The listing. Fixed height on a phone (the body scrolls instead),
                flexible beside the locations column. */}
          <div className="relative flex h-72 min-h-0 flex-col p-2 sm:h-auto sm:min-h-[18rem] sm:flex-1">
            {failure ? (
              <div
                role="alert"
                className="flex flex-1 animate-in flex-col items-center justify-center gap-2 px-6 py-4 text-center fade-in-0 motion-reduce:animate-none"
              >
                <span className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                  <TriangleAlertIcon aria-hidden className="size-4" />
                </span>
                <p className="text-sm font-medium">{t("errorTitle")}</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  {failure.kind === "refused" ? t("loadRefused") : t("loadError")}
                </p>
                {failure.detail ? (
                  <code className="max-w-full rounded bg-muted px-2 py-1 font-mono text-[0.7rem] break-all text-muted-foreground">
                    {failure.detail}
                  </code>
                ) : null}
                <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                  {failure.kind === "unreachable" && location ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => void loadListing(location.root, location.rel, true)}
                    >
                      <RotateCwIcon className="size-3.5" />
                      {t("retry")}
                    </Button>
                  ) : null}
                  {canGoUp ? (
                    <Button type="button" size="sm" variant="ghost" onClick={goUp}>
                      <ArrowUpIcon className="size-3.5" />
                      {t("up")}
                    </Button>
                  ) : null}
                  {/* The recovery is one click, not a path the user has to
                        reconstruct from the error text. */}
                  {roots
                    .filter((root) => !location || !samePath(root.path, location.root) || !atRoot)
                    .map((root) => (
                      <Button
                        key={root.path}
                        type="button"
                        size="sm"
                        variant="outline"
                        className="max-w-full font-mono text-xs"
                        onClick={() => navigate(root.path, ROOT_REL, "jump")}
                      >
                        <span className="truncate">{root.path}</span>
                      </Button>
                    ))}
                </div>
              </div>
            ) : !folders ? (
              <div
                className="flex flex-1 flex-col gap-1.5 p-1"
                aria-busy="true"
                aria-label={t("loading")}
                role="status"
              >
                {Array.from({ length: 7 }, (_, index) => (
                  <div key={index} className="flex h-7 items-center gap-2 px-2">
                    <Skeleton className="size-4 rounded" />
                    <Skeleton
                      className="h-3 rounded"
                      style={{ width: `${30 + ((index * 37) % 45)}%` }}
                    />
                  </div>
                ))}
              </div>
            ) : visible.length === 0 ? (
              <div className="flex flex-1 animate-in flex-col items-center justify-center gap-2 text-center fade-in-0 motion-reduce:animate-none">
                <FolderOpenIcon aria-hidden className="size-7 text-muted-foreground/50" />
                <p className="text-xs text-muted-foreground">
                  {filter.trim() ? t("noMatches", { query: filter.trim() }) : t("empty")}
                </p>
              </div>
            ) : (
              <FolderList
                folders={visible}
                activeIndex={boundedActive}
                animationKey={shown?.key ?? stale?.key ?? ""}
                travel={travel}
                stale={Boolean(stale)}
                label={t("folderList")}
                rowLabel={(name) => t("openFolder", { name })}
                onKeyDown={onListKeyDown}
                onEnter={enter}
                onHover={(index, entry) => {
                  setActiveIndex(index)
                  prefetch(entry)
                }}
                onLeave={cancelPrefetch}
              />
            )}
          </div>
          {folders && !failure ? (
            <p
              className="shrink-0 px-4 pb-2 text-[0.7rem] text-muted-foreground"
              aria-live="polite"
            >
              {t("folderCount", { count: visible.length })}
            </p>
          ) : null}
        </section>
      </div>

      {/* `flex-col`, not the stock `flex-col-reverse`: on a phone the folder
          being chosen reads above the button that chooses it. */}
      <DialogFooter className="shrink-0 flex-col items-center gap-3 border-t bg-muted/20 px-5 py-3 sm:flex-row sm:justify-between">
        <div
          className="flex min-w-0 items-center gap-2 self-stretch sm:self-auto"
          title={currentPath}
        >
          <FolderIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium" data-testid="workspace-folder-current">
              {location ? displayName(location.rel, location.root) : "—"}
            </span>
            <span className="truncate font-mono text-[0.7rem] text-muted-foreground">
              {currentPath}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2 self-stretch sm:self-auto [&>*]:flex-1 sm:[&>*]:flex-none">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            disabled={!location || !ready}
            onClick={() => onChoose(currentPath)}
          >
            {t("chooseCurrent")}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

const folderOptionId = (index: number) => `workspace-folder-option-${index}`

interface FolderListProps {
  folders: WorkspaceEntry[]
  activeIndex: number
  /** Changes per folder shown, so each arrival plays its slide-in once. */
  animationKey: string
  travel: Travel
  /** The previous folder held on screen while the next one loads. */
  stale: boolean
  label: string
  rowLabel: (name: string) => string
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  onEnter: (entry: WorkspaceEntry) => void
  onHover: (index: number, entry: WorkspaceEntry) => void
  onLeave: () => void
}

/**
 * The windowed folder rows. Its own component because `useVirtualizer` opts
 * whatever calls it out of React Compiler memoization; kept here, only the list
 * pays that, not the dialog around it.
 *
 * Only the rows in view (plus a small overscan) are mounted, so a directory of
 * ten thousand folders costs the same to render as one of twenty.
 */
function FolderList({
  folders,
  activeIndex,
  animationKey,
  travel,
  stale,
  label,
  rowLabel,
  onKeyDown,
  onEnter,
  onHover,
  onLeave,
}: FolderListProps) {
  const listRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual returns non-memoizable functions by design; isolated in this component
  const virtualizer = useVirtualizer({
    count: folders.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => folders[index]?.relPath ?? index,
  })

  // Keyboard moves the active row; keep it in view. `auto` is a no-op for a
  // row already visible, so pointer hover never scrolls the list.
  useEffect(() => {
    if (folders.length > 0) virtualizer.scrollToIndex(activeIndex, { align: "auto" })
  }, [activeIndex, folders.length, virtualizer])

  return (
    <div
      ref={listRef}
      id="workspace-folder-list"
      role="listbox"
      tabIndex={0}
      aria-label={label}
      aria-busy={stale ? true : undefined}
      aria-activedescendant={folderOptionId(activeIndex)}
      onKeyDown={onKeyDown}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto rounded-md outline-none focus-visible:ring-1 focus-visible:ring-ring",
        stale && "pointer-events-none opacity-50 transition-opacity duration-150"
      )}
    >
      <div
        key={animationKey}
        className={cn(
          "relative w-full animate-in duration-200 ease-out fade-in-0 motion-reduce:animate-none",
          TRAVEL_ANIMATION[travel]
        )}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const entry = folders[item.index]
          if (!entry) return null
          const name = displayName(entry.relPath, "")
          const active = item.index === activeIndex
          return (
            <div
              key={item.key}
              id={folderOptionId(item.index)}
              role="option"
              aria-selected={active}
              aria-label={rowLabel(name)}
              title={entry.absolutePath}
              onClick={() => onEnter(entry)}
              onPointerEnter={() => onHover(item.index, entry)}
              onPointerLeave={onLeave}
              className={cn(
                "group absolute inset-x-0 flex cursor-pointer items-center gap-2 rounded-md px-2 text-sm transition-colors",
                "text-foreground/90 hover:bg-accent hover:text-accent-foreground",
                active &&
                  "group-focus-within/browser:bg-accent group-focus-within/browser:text-accent-foreground"
              )}
              style={{ height: item.size, transform: `translateY(${item.start}px)` }}
            >
              <FolderIcon
                aria-hidden
                className="size-4 shrink-0 fill-current/15 text-muted-foreground group-hover:text-foreground group-aria-selected:group-focus-within/browser:text-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <ChevronRightIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100 group-aria-selected:group-focus-within/browser:opacity-100"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Dot-folders (`.git`, `.cache`, `.venv`) are hidden until asked for: in a home
 * directory they outnumber the folders anyone means to open. The Host already
 * leaves out what `.gitignore` excludes.
 */
function isHiddenFolder(entry: WorkspaceEntry): boolean {
  return displayName(entry.relPath, "").startsWith(".")
}

export default WorkspaceFolderPicker
