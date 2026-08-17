"use client"

// Per-package configuration, edited as plain JSON.
//
// **No schema, on purpose.** `~/.pi/agent/<name>.json` is a convention each
// extension invented; Pi's core does not define these files and no schema
// exists for them anywhere. Wiring Monaco's JSON validation to an invented
// schema would mark a package's own valid config as an error, which is worse
// than no validation at all. What the editor does give is syntax highlighting,
// bracket matching, and a parse check on save — plus a button that inserts the
// values a human actually reviewed, which is the part that carries knowledge.
//
// The save refuses on invalid JSON rather than writing it, because these files
// are read at Pi startup: a trailing comma here surfaces as a broken extension
// several minutes later, with nothing pointing back at this editor.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import Editor from "@monaco-editor/react"
import { useTheme } from "next-themes"
import { FileJsonIcon, WandSparklesIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { configureMonacoLoader } from "@/lib/canvas/monaco-loader"
import { exists, readTextFile, writeTextFile } from "@/lib/file/file-operations"
import { piConfigTemplateFor } from "@/lib/pi-packages/config-templates"
import { piPackageShortName } from "./pi-context-budget"

export interface PiPackageConfigEditorProps {
  /** The package spec whose config is being edited, or null when closed. */
  spec: string | null
  /** Absolute path of the config file. */
  path: string | null
  onClose: () => void
  /** Injected in tests, where the Tauri file IPC does not exist. */
  io?: {
    exists: (path: string) => Promise<boolean>
    readTextFile: (path: string) => Promise<string>
    writeTextFile: (path: string, contents: string) => Promise<void>
  }
}

export function PiPackageConfigEditor({
  spec,
  path,
  onClose,
  io = { exists, readTextFile, writeTextFile },
}: PiPackageConfigEditorProps) {
  const t = useTranslations("plugins.agentPackages.config")
  const { resolvedTheme } = useTheme()
  const [value, setValue] = useState("")
  const [loading, setLoading] = useState(true)
  const [parseError, setParseError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    configureMonacoLoader()
  }, [])

  useEffect(() => {
    if (!spec || !path) return
    let cancelled = false
    setLoading(true)
    setParseError(null)
    void (async () => {
      try {
        const present = await io.exists(path).catch(() => false)
        const text = present ? await io.readTextFile(path) : ""
        if (!cancelled) setValue(text)
      } catch {
        if (!cancelled) setValue("")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, path])

  const insertTemplate = useCallback(() => {
    if (!spec) return
    const template = piConfigTemplateFor(spec)
    if (template === null) return
    setValue(`${JSON.stringify(template, null, 2)}\n`)
    setParseError(null)
  }, [spec])

  const save = useCallback(async () => {
    if (!path) return
    const text = value.trim()
    if (text !== "") {
      try {
        JSON.parse(text)
      } catch (error) {
        setParseError(error instanceof Error ? error.message : String(error))
        return
      }
    }
    setSaving(true)
    try {
      await io.writeTextFile(path, value.endsWith("\n") ? value : `${value}\n`)
      toast.success(t("saved"))
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, value, t, onClose])

  if (!spec || !path) return null

  const hasTemplate = piConfigTemplateFor(spec) !== null

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl" data-testid="pi-config-editor">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJsonIcon className="size-4" />
            {t("title")} — {piPackageShortName(spec)}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <p className="text-muted-foreground font-mono text-xs break-all">{path}</p>

        <div className="h-72 overflow-hidden rounded-md border" aria-label={t("editorLabel")}>
          {!loading && (
            <Editor
              height="100%"
              language="json"
              value={value}
              theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
              onChange={(next) => {
                setValue(next ?? "")
                setParseError(null)
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                tabSize: 2,
                automaticLayout: true,
              }}
            />
          )}
        </div>

        {parseError && (
          <Alert variant="destructive" data-testid="pi-config-parse-error">
            <AlertDescription>
              {t("invalidJson")} {parseError}
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!hasTemplate}
            onClick={insertTemplate}
            data-testid="pi-config-insert-template"
          >
            <WandSparklesIcon className="size-3.5" />
            {hasTemplate ? t("insertTemplate") : t("noTemplate")}
          </Button>
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
