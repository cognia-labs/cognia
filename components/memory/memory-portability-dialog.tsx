"use client"

/**
 * Scoped memory export + reviewed import preview dialog (`G7`).
 *
 * Bridges the gap between full-database backup (`BackupRestoreDialog`) and raw
 * external agent markdown discovery (`ExternalMemoryTab`): users can export a
 * scoped subset of their memory corpus (current filtered view, global, or one
 * workspace) as versioned JSON or Markdown, and import JSON/Markdown bundles
 * through a deterministic dry-run preview that flags exact duplicates,
 * conflicting facts, PII-blocked lines, and conservative quarantine / review
 * states before any write runs.
 */

import { useMemo, useState, type ChangeEvent } from "react"
import { useTranslations } from "next-intl"
import { CopyIcon, DownloadIcon, UploadIcon } from "lucide-react"
import { toast } from "sonner"
import { hasNoLeakingPii } from "@cognia/redact"
import {
  exportMemoriesBundle,
  previewMemoryImport,
  type MemoryExportFormat,
} from "@cognia/memory/portability/memory-portability"

import type { Memory, MemoryScope } from "@/types/memory/memory"
import type { ManageMemoryCommand } from "@/lib/memory/control-plane/manage"
import type { MemoryCreateInput } from "@/hooks/memory/use-memory-console"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

export type ExportScopeChoice = "filtered" | "all" | MemoryScope
export type ImportScopeChoice = "preserve" | "global" | "workspace"
export type ImportConflictStrategy = "skip" | "keep-both" | "overwrite"

export interface MemoryPortabilityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  allMemories: readonly Memory[]
  filteredRows: readonly Memory[]
  projectNames: Readonly<Record<string, string>>
  onCreate: (input: MemoryCreateInput) => Promise<boolean>
  onRunCommand: (command: ManageMemoryCommand) => Promise<boolean>
  onCopyText: (text: string) => void
}

export function MemoryPortabilityDialog({
  open,
  onOpenChange,
  allMemories,
  filteredRows,
  projectNames,
  onCreate,
  onRunCommand,
  onCopyText,
}: MemoryPortabilityDialogProps) {
  const t = useTranslations("memory.portability")
  const tTypes = useTranslations("memory.types")
  const tScopes = useTranslations("memory.scopes")

  const [mode, setMode] = useState<"export" | "import">("export")

  // Export state
  const [exportScope, setExportScope] = useState<ExportScopeChoice>("filtered")
  const [exportFormat, setExportFormat] = useState<MemoryExportFormat>("json")
  const [includeArchived, setIncludeArchived] = useState(false)

  // Import state
  const [rawImport, setRawImport] = useState("")
  const [importScope, setImportScope] = useState<ImportScopeChoice>("preserve")
  const projectEntries = useMemo(() => Object.entries(projectNames), [projectNames])
  const [targetProjectId, setTargetProjectId] = useState<string>("")
  const [conflictStrategy, setConflictStrategy] = useState<ImportConflictStrategy>("skip")
  const [importing, setImporting] = useState(false)

  const effectiveProjectId = targetProjectId || projectEntries[0]?.[0] || ""

  const exportSource = useMemo(() => {
    if (exportScope === "filtered") return filteredRows
    if (exportScope === "all") return allMemories
    return allMemories.filter((row) => row.scope === exportScope)
  }, [exportScope, filteredRows, allMemories])

  const exportedText = useMemo(
    () =>
      exportMemoriesBundle(exportSource, {
        format: exportFormat,
        includeArchived: exportScope === "filtered" ? true : includeArchived,
      }),
    [exportSource, exportFormat, includeArchived, exportScope]
  )

  const exportedCount = useMemo(() => {
    return exportSource.filter((row) => {
      if (row.revisionOf !== undefined) return false
      if (exportScope !== "filtered" && !includeArchived && row.status !== "active") return false
      return Boolean(row.text.trim())
    }).length
  }, [exportSource, exportScope, includeArchived])

  const preview = useMemo(
    () =>
      rawImport.trim()
        ? previewMemoryImport(rawImport, allMemories, {
            overrideScope: importScope === "preserve" ? undefined : importScope,
            defaultProjectId: effectiveProjectId || undefined,
            isPiiSafe: hasNoLeakingPii,
            allowSensitiveTopics: false,
          })
        : null,
    [rawImport, allMemories, importScope, effectiveProjectId]
  )

  const actionableItems = useMemo(() => {
    if (!preview?.ok) return []
    return preview.items.filter((item) => {
      if (item.disposition === "add") return true
      if (item.disposition === "conflict") return conflictStrategy !== "skip"
      return false
    })
  }, [preview, conflictStrategy])

  const handleDownload = () => {
    if (typeof document === "undefined") return
    const ext = exportFormat === "json" ? "json" : "md"
    const mime = exportFormat === "json" ? "application/json" : "text/markdown"
    const blob = new Blob([exportedText], { type: `${mime};charset=utf-8` })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `cognia-memories-${exportScope}.${ext}`
    link.click()
    URL.revokeObjectURL(url)
    toast.success(t("export.downloadedToast", { count: exportedCount }))
  }

  const handleFileUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setRawImport(reader.result)
      }
    }
    reader.readAsText(file)
  }

  const handleApplyImport = async () => {
    if (actionableItems.length === 0 || importing) return
    setImporting(true)
    let succeeded = 0
    try {
      for (const item of actionableItems) {
        const { candidate } = item
        if (
          item.disposition === "conflict" &&
          conflictStrategy === "overwrite" &&
          item.existingId
        ) {
          const ok = await onRunCommand({
            kind: "update",
            id: item.existingId,
            patch: {
              text: candidate.text,
              tags: candidate.tags,
              importance: candidate.importance,
              ...(candidate.key ? { key: candidate.key } : {}),
            },
          })
          if (ok) succeeded += 1
          continue
        }

        const resolvedScope: MemoryScope =
          candidate.scope === "workspace" && !candidate.projectId ? "global" : candidate.scope
        const ok = await onCreate({
          text: candidate.text,
          type: candidate.type,
          importance: candidate.importance,
          tags: candidate.tags,
          ...(candidate.key ? { key: candidate.key } : {}),
          scope: resolvedScope,
          ...(resolvedScope === "workspace" ? { projectId: candidate.projectId } : {}),
          ...(resolvedScope === "character" ? { characterId: candidate.characterId } : {}),
          ...(resolvedScope === "agent" ? { agentId: candidate.agentId } : {}),
          ...(candidate.branch ? { branch: candidate.branch } : {}),
          ...(candidate.pathPattern ? { pathPattern: candidate.pathPattern } : {}),
          reviewStatus: item.disposition === "conflict" ? "conflict" : item.effectiveReviewStatus,
          trustState: item.effectiveTrustState,
          sensitivity: item.effectiveSensitivity,
        })
        if (ok) succeeded += 1
      }
      if (succeeded > 0) {
        toast.success(t("import.importedToast", { count: succeeded }))
        setRawImport("")
        onOpenChange(false)
      } else {
        toast.error(t("import.failedToast"))
      }
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-testid="memory-portability-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(v) => setMode(v as "export" | "import")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="export" data-testid="memory-portability-tab-export">
              {t("tabs.export")}
            </TabsTrigger>
            <TabsTrigger value="import" data-testid="memory-portability-tab-import">
              {t("tabs.import")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="export" className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mem-export-scope" className="text-xs font-medium">
                  {t("export.scopeLabel")}
                </Label>
                <Select
                  value={exportScope}
                  onValueChange={(v) => setExportScope(v as ExportScopeChoice)}
                >
                  <SelectTrigger id="mem-export-scope" aria-label={t("export.scopeLabel")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="filtered">{t("export.scopes.filtered")}</SelectItem>
                    <SelectItem value="all">{t("export.scopes.all")}</SelectItem>
                    <SelectItem value="global">{tScopes("global")}</SelectItem>
                    <SelectItem value="workspace">{tScopes("workspace")}</SelectItem>
                    <SelectItem value="character">{tScopes("character")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="mem-export-format" className="text-xs font-medium">
                  {t("export.formatLabel")}
                </Label>
                <Select
                  value={exportFormat}
                  onValueChange={(v) => setExportFormat(v as MemoryExportFormat)}
                >
                  <SelectTrigger id="mem-export-format" aria-label={t("export.formatLabel")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json">{t("export.formats.json")}</SelectItem>
                    <SelectItem value="markdown">{t("export.formats.markdown")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {exportScope !== "filtered" ? (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="mem-export-archived"
                  checked={includeArchived}
                  onCheckedChange={(checked) => setIncludeArchived(checked === true)}
                />
                <Label htmlFor="mem-export-archived" className="text-xs font-normal">
                  {t("export.includeArchived")}
                </Label>
              </div>
            ) : null}

            <p className="text-xs text-muted-foreground" data-testid="memory-export-count">
              {t("export.summary", { count: exportedCount })}
            </p>

            <Textarea
              readOnly
              rows={7}
              value={exportedText}
              aria-label={t("export.previewAria")}
              className="font-mono text-xs"
              data-testid="memory-export-preview"
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={exportedCount === 0}
                onClick={() => onCopyText(exportedText)}
                data-testid="memory-export-copy"
              >
                <CopyIcon className="size-4" />
                {t("export.copy")}
              </Button>
              <Button
                type="button"
                disabled={exportedCount === 0}
                onClick={handleDownload}
                data-testid="memory-export-download"
              >
                <DownloadIcon className="size-4" />
                {t("export.download")}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="import" className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="mem-import-input" className="text-xs font-medium">
                {t("import.inputLabel")}
              </Label>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-primary hover:underline">
                <UploadIcon className="size-3.5" />
                <span>{t("import.uploadFile")}</span>
                <input
                  type="file"
                  accept=".json,.md,.markdown,.txt"
                  className="sr-only"
                  onChange={handleFileUpload}
                  data-testid="memory-import-file"
                />
              </label>
            </div>

            <Textarea
              id="mem-import-input"
              rows={5}
              value={rawImport}
              onChange={(event) => setRawImport(event.target.value)}
              placeholder={t("import.placeholder")}
              className="font-mono text-xs"
              data-testid="memory-import-textarea"
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mem-import-scope" className="text-xs font-medium">
                  {t("import.targetScopeLabel")}
                </Label>
                <Select
                  value={importScope}
                  onValueChange={(v) => setImportScope(v as ImportScopeChoice)}
                >
                  <SelectTrigger id="mem-import-scope" aria-label={t("import.targetScopeLabel")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="preserve">{t("import.targetScopes.preserve")}</SelectItem>
                    <SelectItem value="global">{tScopes("global")}</SelectItem>
                    <SelectItem value="workspace">{tScopes("workspace")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="mem-import-conflict" className="text-xs font-medium">
                  {t("import.conflictLabel")}
                </Label>
                <Select
                  value={conflictStrategy}
                  onValueChange={(v) => setConflictStrategy(v as ImportConflictStrategy)}
                >
                  <SelectTrigger id="mem-import-conflict" aria-label={t("import.conflictLabel")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="skip">{t("import.conflicts.skip")}</SelectItem>
                    <SelectItem value="keep-both">{t("import.conflicts.keepBoth")}</SelectItem>
                    <SelectItem value="overwrite">{t("import.conflicts.overwrite")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {importScope === "workspace" && projectEntries.length > 0 ? (
              <div className="space-y-1.5">
                <Label htmlFor="mem-import-workspace" className="text-xs font-medium">
                  {tScopes("workspace")}
                </Label>
                <Select value={effectiveProjectId} onValueChange={setTargetProjectId}>
                  <SelectTrigger id="mem-import-workspace" aria-label={tScopes("workspace")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {projectEntries.map(([id, name]) => (
                      <SelectItem key={id} value={id}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {preview ? (
              preview.ok ? (
                <div
                  className="space-y-2 rounded-md border p-2.5"
                  data-testid="memory-import-preview"
                >
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    <Badge variant="secondary">
                      {t("import.badges.add", { count: preview.counts.add })}
                    </Badge>
                    {preview.counts.conflict > 0 ? (
                      <Badge variant="destructive">
                        {t("import.badges.conflict", { count: preview.counts.conflict })}
                      </Badge>
                    ) : null}
                    {preview.counts.duplicate > 0 ? (
                      <Badge variant="outline">
                        {t("import.badges.duplicate", { count: preview.counts.duplicate })}
                      </Badge>
                    ) : null}
                    {preview.counts.blockedPii > 0 ? (
                      <Badge variant="destructive">
                        {t("import.badges.pii", { count: preview.counts.blockedPii })}
                      </Badge>
                    ) : null}
                    {preview.counts.sensitive > 0 ? (
                      <Badge variant="outline">
                        {t("import.badges.sensitive", { count: preview.counts.sensitive })}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t("import.trustNote")}</p>
                  <div className="max-h-36 space-y-1 overflow-y-auto pr-1 text-xs">
                    {preview.items.slice(0, 20).map((item) => (
                      <div
                        key={item.index}
                        className="flex items-start justify-between gap-2 rounded border border-border/50 px-2 py-1"
                      >
                        <span className="min-w-0 flex-1 truncate">{item.candidate.text}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          <Badge variant="outline" className="h-4 px-1 text-[10px]">
                            {tTypes(item.candidate.type)}
                          </Badge>
                          <Badge
                            variant={
                              item.disposition === "conflict" || item.disposition === "blocked_pii"
                                ? "destructive"
                                : "secondary"
                            }
                            className="h-4 px-1 text-[10px]"
                          >
                            {t(`import.disposition.${item.disposition}`)}
                          </Badge>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-xs text-destructive" data-testid="memory-import-error">
                  {t(`import.errors.${preview.error ?? "invalid_json"}`)}
                </p>
              )
            ) : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                {t("cancel")}
              </Button>
              <Button
                type="button"
                disabled={actionableItems.length === 0 || importing}
                onClick={() => void handleApplyImport()}
                data-testid="memory-import-confirm"
              >
                {t("import.confirm", { count: actionableItems.length })}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
