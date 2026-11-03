"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ArrowUpCircleIcon,
  FolderDownIcon,
  FolderIcon,
  LayoutTemplateIcon,
  LinkIcon,
  PackageIcon,
  PlusIcon,
  RefreshCcwIcon,
  RefreshCwIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
  VideoIcon,
} from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { openRecorder } from "@/stores/skills/recorder-store"
import { useRecorderAvailable } from "@/hooks/skills/use-skill-recorder"
import type {
  FeatureHeaderAction,
  FeatureHeaderPrimaryAction,
} from "@/components/feature-shell/feature-page-header"
import { SkillDiscovery } from "./skill-discovery"
import { SkillTemplateDialog } from "./skill-template-dialog"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { pickAndReadBinaryFiles, pickAndReadFiles, pickDirectory } from "@/lib/files/file-bridge"
import { isTauri } from "@/lib/tauri"
import { canReadHostSkills, canWriteHostSkills } from "@/lib/skills/sync"
import { loadBundle, type BundleResult } from "@/lib/skills/bundle/loader"
import { listSkills } from "@/lib/db/skills"
import { nameFromFilename, parseSkillMarkdown } from "@/lib/claude/skills-io"
import { scanClaudeSkills, skillsEmptyTrash, skillsListTrash } from "@/lib/claude/ipc"
import { useSkillsStore } from "@/stores/skills"
import type { ImportStaging } from "@/stores/skills"
import { useSkillSync, useSkillUpdate } from "@/hooks/skills"
import { exportSkillsToDirWithFeedback } from "@/lib/skills/export-toast"
import { loggers } from "@cognia/logging"

const SKILL_FILE_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown"] }]
const BUNDLE_FILE_FILTERS = [{ name: "Skill bundle", extensions: ["zip"] }]

function slug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  )
}

function toBundleImportDraft(
  result: BundleResult,
  source: "zip" | "folder",
  nativeDirectory?: string
): ImportStaging["drafts"][number] {
  const draft = result.draft
  return {
    name: draft.name,
    slug: draft.slug,
    description: draft.description,
    compatibility: draft.compatibility,
    metadata: draft.metadata,
    invocationPolicy: draft.invocationPolicy,
    frontmatterExtensions: draft.frontmatterExtensions,
    codexOpenAiYaml: draft.codexOpenAiYaml,
    content: draft.content,
    tags: draft.tags,
    allowedTools: draft.allowedTools,
    category: draft.category,
    canonicalId: `bundle:${source}:${draft.slug ?? slug(draft.name)}`,
    resources: result.resources,
    validationErrors:
      result.nonFatalValidationErrors.length > 0 ? result.nonFatalValidationErrors : undefined,
    ...(nativeDirectory ? { nativeDirectory } : {}),
  }
}

/**
 * What the Skills page header shows for the panel's own actions.
 *
 * The header draws typed actions in one fixed order: New is the
 * primary button and sits last, Record is a secondary button, and the
 * occasional jobs (export, update check, native push/pull, empty trash) fold
 * into the header's own "⋯". Only the Import menu stays free-form, because
 * every entry carries a one-line hint that a typed overflow item cannot.
 * The mirror-target switches and the host-reachability note are settings, not
 * actions, so they live in the preferences popover (`SkillSyncTargets`).
 */
export interface SkillPanelToolbarModel {
  primaryAction: FeatureHeaderPrimaryAction
  secondaryActions: FeatureHeaderAction[]
  overflowActions: FeatureHeaderAction[]
  /** The Import menu, plus the template dialog and discovery sheet it opens. */
  importMenu: ReactNode
}

export function useSkillPanelToolbar(): SkillPanelToolbarModel {
  const t = useTranslations("skills.toolbar")
  const tRecorder = useTranslations("skills.recorder")
  const recorderAvailable = useRecorderAvailable()
  const tCommon = useTranslations("skills")
  const tToasts = useTranslations("skills.toasts")
  const tSync = useTranslations("skills.sync")
  const tDiscovery = useTranslations("skills.discovery")
  const [busy, setBusy] = useState(false)
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const openCreate = useSkillsStore((s) => s.openCreate)
  const setImportStaging = useSkillsStore((s) => s.setImportStaging)
  const setUrlInstallOpen = useSkillsStore((s) => s.setUrlInstallOpen)
  const sync = useSkillSync()
  const updates = useSkillUpdate()
  const [trashCount, setTrashCount] = useState(0)

  // Refresh the trash badge on mount. Tauri-only — outside Tauri the listing
  // call is a no-op error. setTrashCount runs only after the awaited IPC call,
  // so it never fires synchronously during the effect commit.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void (async () => {
      try {
        const entries = await skillsListTrash()
        if (!cancelled) setTrashCount(entries.length)
      } catch {
        if (!cancelled) setTrashCount(0)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleEmptyTrash = async () => {
    if (!isTauri()) return
    setBusy(true)
    try {
      const removed = await skillsEmptyTrash()
      setTrashCount(0)
      toast.success(tSync("trashEmptied", { count: removed }))
      loggers.skills.info("trash emptied", { removed })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("empty trash failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromMarkdown = async () => {
    setBusy(true)
    try {
      const files = await pickAndReadFiles({
        filters: SKILL_FILE_FILTERS,
        multiple: true,
      })
      if (files.length === 0) return
      const drafts: ImportStaging["drafts"] = []
      const parseErrors: ImportStaging["parseErrors"] = []
      for (const file of files) {
        try {
          const fallback = nameFromFilename(file.name)
          const { draft, portabilityIssues } = parseSkillMarkdown(file.content, {
            fallbackName: fallback,
          })
          drafts.push({
            ...draft,
            validationErrors: portabilityIssues.length > 0 ? portabilityIssues : undefined,
          })
        } catch (err) {
          parseErrors.push({
            name: file.name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (drafts.length === 0) {
        toast.error(
          parseErrors.length > 0
            ? tToasts("importNoFilesParsed", { count: parseErrors.length })
            : tToasts("importNoSkills")
        )
        loggers.skills.warn("import.markdown none parsed", {
          attempted: files.length,
          errors: parseErrors.length,
        })
        return
      }
      setImportStaging({
        drafts,
        sourceLabel: `${files.length} markdown file(s)`,
        parseErrors,
      })
      loggers.skills.info("import.markdown staged", {
        drafts: drafts.length,
        errors: parseErrors.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.markdown failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromBundleZip = async () => {
    setBusy(true)
    try {
      const files = await pickAndReadBinaryFiles({
        filters: BUNDLE_FILE_FILTERS,
        multiple: false,
      })
      if (files.length === 0) return
      const picked = files[0]
      const fallback = picked.name.replace(/\.zip$/i, "")
      const result = await loadBundle({
        kind: "zip-blob",
        bytes: picked.bytes,
        fallbackName: fallback,
      })
      const draft = toBundleImportDraft(result, "zip")
      setImportStaging({
        drafts: [draft],
        sourceLabel: picked.name,
        parseErrors: [],
        flavor: result.flavor,
      })
      loggers.skills.info("import.bundleZip staged", {
        name: result.draft.name,
        flavor: result.flavor,
        resources: result.resources.length,
        warnings: result.warnings.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.bundleZip failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromBundleFolder = async () => {
    if (!isTauri()) {
      toast.error(tToasts("importFromClaudeDesktopOnly"))
      return
    }
    setBusy(true)
    try {
      const dir = await pickDirectory()
      if (!dir) return
      const fallback =
        dir
          .replace(/\\/g, "/")
          .split("/")
          .filter((s) => s.length > 0)
          .pop() ?? "skill"
      const result = await loadBundle({
        kind: "folder",
        path: dir,
        fallbackName: fallback,
      })
      const draft = toBundleImportDraft(result, "folder", dir)
      setImportStaging({
        drafts: [draft],
        sourceLabel: dir,
        parseErrors: [],
        flavor: result.flavor,
      })
      loggers.skills.info("import.bundleFolder staged", {
        name: result.draft.name,
        flavor: result.flavor,
        resources: result.resources.length,
        warnings: result.warnings.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.bundleFolder failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleImportFromClaudeCode = async () => {
    if (!isTauri()) {
      toast.error(tToasts("importFromClaudeDesktopOnly"))
      return
    }
    setBusy(true)
    try {
      const discovered = await scanClaudeSkills()
      if (discovered.length === 0) {
        toast.info(tToasts("importNoSkillMd"))
        loggers.skills.info("import.claudeCode empty")
        return
      }
      const drafts: ImportStaging["drafts"] = []
      const parseErrors: ImportStaging["parseErrors"] = []
      for (const file of discovered) {
        try {
          const { draft, portabilityIssues } = parseSkillMarkdown(file.content, {
            fallbackName: file.dirName,
          })
          const tags = Array.from(new Set([...(draft.tags ?? []), "claude-code"]))
          drafts.push({
            ...draft,
            tags,
            validationErrors: portabilityIssues.length > 0 ? portabilityIssues : undefined,
          })
        } catch (err) {
          parseErrors.push({
            name: file.dirName,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      if (drafts.length === 0) {
        toast.error(
          tToasts("importNoneParsed", {
            found: discovered.length,
            first: parseErrors[0]?.error ?? "",
          })
        )
        loggers.skills.warn("import.claudeCode none parsed", {
          found: discovered.length,
          errors: parseErrors.length,
        })
        return
      }
      setImportStaging({
        drafts,
        sourceLabel: "~/.claude/skills/",
        parseErrors,
      })
      loggers.skills.info("import.claudeCode staged", {
        drafts: drafts.length,
        errors: parseErrors.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("import.claudeCode failed", err)
    } finally {
      setBusy(false)
    }
  }

  const handleCheckUpdates = async () => {
    try {
      const count = await updates.checkAll()
      if (count > 0) toast.success(tToasts("updatesFound", { count }))
      else toast.info(tToasts("updatesNone"))
      loggers.skills.info("update check done", { updates: count })
    } catch (err) {
      toast.error(
        tToasts("updatesError", { error: err instanceof Error ? err.message : String(err) })
      )
      loggers.skills.error("update check failed", err)
    }
  }

  const handleExportAll = async () => {
    setBusy(true)
    try {
      const all = await listSkills()
      const customSkills = all.filter((s) => !s.isBuiltIn)
      await exportSkillsToDirWithFeedback(customSkills, tToasts, {
        source: "exportAll",
        total: customSkills.length,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
      loggers.skills.error("export all failed", err)
    } finally {
      setBusy(false)
    }
  }

  const importItemClass = "text-xs"
  const importMenu = (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={t("import")}
            data-testid="skill-panel-toolbar-import"
            className="size-8 px-0 @2xl/feature-header:h-8 @2xl/feature-header:w-auto @2xl/feature-header:px-3"
          >
            <UploadIcon className="size-3.5" aria-hidden="true" />
            <span className="hidden @2xl/feature-header:inline">{t("import")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => setTemplateOpen(true)} className={importItemClass}>
              <LayoutTemplateIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{tCommon("templates.fromTemplate")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {tCommon("templates.fromTemplateHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void handleImportFromMarkdown()}
              className={importItemClass}
            >
              <UploadIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("importFromMarkdown")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("importFromMarkdownHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleImportFromBundleZip()}
              className={importItemClass}
              data-testid="skill-panel-toolbar-import-bundle-zip"
            >
              <PackageIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("importFromBundle")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("importFromBundleHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleImportFromBundleFolder()}
              disabled={!isTauri()}
              className={importItemClass}
              data-testid="skill-panel-toolbar-import-bundle-folder"
            >
              <FolderIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("importFromBundleFolder")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("importFromBundleFolderHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleImportFromClaudeCode()}
              disabled={!isTauri()}
              className={importItemClass}
            >
              <SparklesIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("importFromClaudeCode")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {t("importFromClaudeCodeHint")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setDiscoveryOpen(true)}
              disabled={!isTauri()}
              className={importItemClass}
            >
              <SearchIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{tDiscovery("title")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {tDiscovery("scanCustom")}
                </span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setUrlInstallOpen(true)}
              className={importItemClass}
              data-testid="skill-panel-toolbar-install-from-url"
            >
              <LinkIcon className="mr-2 size-3.5" />
              <div className="flex flex-col gap-0.5">
                <span>{t("installFromUrl")}</span>
                <span className="text-[10px] text-muted-foreground">
                  {tCommon("marketplace.urlInstall.description")}
                </span>
              </div>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <SkillTemplateDialog open={templateOpen} onOpenChange={setTemplateOpen} />

      <Sheet open={discoveryOpen} onOpenChange={setDiscoveryOpen}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-5 py-3">
            <SheetTitle>{tDiscovery("title")}</SheetTitle>
            <SheetDescription>
              {tDiscovery("scanHome")} · {tDiscovery("scanCustom")}
            </SheetDescription>
          </SheetHeader>
          <SkillDiscovery />
        </SheetContent>
      </Sheet>
    </>
  )

  return {
    primaryAction: {
      id: "new",
      label: t("new"),
      icon: PlusIcon,
      onSelect: () => openCreate(),
      disabled: busy,
      testId: "skill-panel-toolbar-new",
    },
    // Gated on the owning plugin rather than on `isTauri()`: disabling the
    // Skill Recorder must take every entry point with it, and the plugin is
    // the thing that holds the native grants.
    secondaryActions: recorderAvailable
      ? [
          {
            id: "record",
            label: tRecorder("entry.toolbarButton"),
            icon: VideoIcon,
            onSelect: () => openRecorder("toolbar"),
            disabled: busy,
            testId: "skill-panel-toolbar-record",
          },
        ]
      : [],
    // Export, update check, sync and trash are occasional, so they live in the
    // header's "⋯" at every width. Inline, they made five outline buttons of
    // equal weight next to New, and the row wrapped below xl.
    overflowActions: [
      {
        id: "export-all",
        label: t("exportAll"),
        icon: FolderDownIcon,
        onSelect: () => void handleExportAll(),
        disabled: busy,
        testId: "skill-panel-toolbar-export-all",
      },
      {
        id: "check-updates",
        label: updates.checking ? t("checkingUpdates") : t("checkUpdates"),
        icon: ArrowUpCircleIcon,
        onSelect: () => void handleCheckUpdates(),
        disabled: busy || updates.checking,
        testId: "skill-panel-toolbar-check-updates",
      },
      {
        id: "sync-push",
        label: tSync("pushAll"),
        icon: RefreshCwIcon,
        onSelect: () => void sync.push(),
        disabled: !canWriteHostSkills() || busy || sync.busy,
        testId: "skill-panel-toolbar-sync-push",
      },
      {
        id: "sync-pull",
        label: tSync("pullAll"),
        // The counter-clockwise glyph: the old menu drew push mirrored.
        icon: RefreshCcwIcon,
        onSelect: () => void sync.pull(),
        disabled: !canReadHostSkills() || busy || sync.busy,
        testId: "skill-panel-toolbar-sync-pull",
      },
      {
        id: "empty-trash",
        label: tSync("emptyTrash", { count: trashCount }),
        icon: Trash2Icon,
        onSelect: () => void handleEmptyTrash(),
        disabled: !isTauri() || trashCount === 0 || busy,
        destructive: true,
        testId: "skill-panel-toolbar-empty-trash",
      },
    ],
    importMenu,
  }
}
