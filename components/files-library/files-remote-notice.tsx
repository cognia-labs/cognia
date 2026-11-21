"use client"

/**
 * The notice a paired device's Files page shows when its last read of the
 * host's library failed (ADR-0223 §9). What was already on screen stays; the
 * notice says why it may be stale and offers Retry. Nothing renders while
 * the library reads fine, or where it is this device's own (no `refresh`).
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertCircleIcon, CloudOffIcon, InfoIcon, RotateCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function FilesRemoteNotice({
  error,
  refresh,
  searchError,
  retrySearch,
  searchTruncated = false,
  searchBounded = false,
  touch = false,
  className,
}: {
  /** The `files.errors.*` code of the failed read. */
  error: string | undefined
  refresh: (() => Promise<void>) | undefined
  /** The `files.errors.*` code when a remote body search failed. */
  searchError?: string
  retrySearch?: () => void
  /** True when remote body search hit its result limit. */
  searchTruncated?: boolean
  /** True when the searched place includes path-only or bounded-excerpt items. */
  searchBounded?: boolean
  /** Touch-sized Retry. */
  touch?: boolean
  className?: string
}) {
  const t = useTranslations("files")
  const [retrying, setRetrying] = useState(false)
  const hasLoadError = Boolean(error && refresh)
  const hasSearchError = Boolean(searchError)
  if (!hasLoadError && !hasSearchError && !searchTruncated && !searchBounded) return null

  const errorReason = (code: string) => {
    const key = `errors.${code}`
    return t.has(key) ? t(key) : t("errors.unknown")
  }

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {hasLoadError ? (
        <Alert variant="destructive" className="items-center" data-testid="files-remote-notice">
          <CloudOffIcon aria-hidden />
          <AlertTitle>{t("remote.loadFailed")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{errorReason(error!)}</span>
            <Button
              variant="outline"
              size={touch ? "default" : "sm"}
              className={cn("text-foreground", touch && "h-10")}
              disabled={retrying}
              onClick={() => {
                setRetrying(true)
                void refresh!().finally(() => setRetrying(false))
              }}
              data-testid="files-remote-retry"
            >
              <RotateCwIcon className={cn(retrying && "animate-spin")} aria-hidden />
              {t("remote.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {hasSearchError ? (
        <Alert
          variant="destructive"
          className="items-center"
          data-testid="files-search-error-notice"
        >
          <AlertCircleIcon aria-hidden />
          <AlertTitle>{t("search.bodyFailed")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{t("search.bodyFailedHint", { reason: errorReason(searchError!) })}</span>
            {retrySearch ? (
              <Button
                variant="outline"
                size={touch ? "default" : "sm"}
                className={cn("text-foreground", touch && "h-10")}
                onClick={retrySearch}
                data-testid="files-search-retry"
              >
                <RotateCwIcon aria-hidden />
                {t("remote.retry")}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {searchTruncated || searchBounded ? (
        <p
          className="flex items-center gap-1.5 rounded-md bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground"
          role="status"
          data-testid={
            searchTruncated ? "files-search-truncated-notice" : "files-search-bounded-notice"
          }
        >
          <InfoIcon className="size-3.5 shrink-0" aria-hidden />
          <span>{searchTruncated ? t("search.truncatedNotice") : t("search.boundedNotice")}</span>
        </p>
      ) : null}
    </div>
  )
}
