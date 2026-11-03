"use client"

/**
 * Absolute-path field with a native directory picker.
 *
 * The common layout for the pairing every path field needs: a text input that
 * is the real control on every shell, plus a Browse shortcut only where a
 * picker exists. Rendering a Browse button that silently does nothing on web
 * is the failure mode this avoids.
 *
 * The decision behind that gate lives in `useDirectoryPicker`, shared with the
 * surfaces whose layout is a compact icon button rather than this one. Read
 * that hook for why there is no remote-host fallback.
 *
 * Labels are props rather than a namespace lookup so each caller keeps its own
 * i18n keys. The component never owns user-facing text.
 *
 * A FILE path uses the same layout: pass a `pick` that opens a file dialog
 * (`pickFilePath`). The field is the pairing, not the dialog kind.
 */

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useDirectoryPicker } from "@/hooks/files/use-directory-picker"

export interface DirectoryFieldProps {
  /** For a `<label htmlFor>` / `FieldLabel` outside the field. */
  id?: string
  value: string
  onChange: (next: string) => void
  /**
   * Persist. Fired on blur, and immediately after a successful pick. Optional
   * for a form that persists on submit and only needs `onChange`.
   */
  onCommit?: (next: string) => void
  placeholder?: string
  ariaLabel: string
  browseLabel: string
  disabled?: boolean
  /** Defaults to the native directory picker; a file field passes its own. */
  pick?: () => Promise<string | null>
  /**
   * Defaults to the real shell check. A caller narrows it when a native pick
   * would name the wrong machine (a Docker daemon on another host).
   */
  hasPicker?: () => boolean
}

export function DirectoryField({
  id,
  value,
  onChange,
  onCommit,
  placeholder,
  ariaLabel,
  browseLabel,
  disabled,
  pick,
  hasPicker,
}: DirectoryFieldProps) {
  const picker = useDirectoryPicker({
    ...(pick ? { pick } : {}),
    ...(hasPicker ? { hasPicker } : {}),
  })

  async function browse() {
    const picked = await picker.browse()
    if (!picked) return // cancelled, or no picker on this shell
    onChange(picked)
    onCommit?.(picked)
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => onCommit?.(value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        className="min-w-0 flex-1"
      />
      {picker.available && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={disabled || picker.busy}
          onClick={() => void browse()}
        >
          {browseLabel}
        </Button>
      )}
    </div>
  )
}
