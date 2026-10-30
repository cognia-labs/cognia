"use client"

/**
 * A2UI Button Component
 * Maps to shadcn/ui Button
 */

import React, { memo, useRef } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { Loader2 } from "lucide-react"
import type { A2UIComponentProps, A2UIButtonComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { useConfirmDialog } from "@/components/shared/confirm-dialog"

const variantMap: Record<
  string,
  "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
> = {
  default: "default",
  primary: "default",
  secondary: "secondary",
  destructive: "destructive",
  outline: "outline",
  ghost: "ghost",
  link: "link",
}

export const A2UIButton = memo(function A2UIButton({
  component,
  onAction,
  onDataChange,
  triggerProps,
}: A2UIComponentProps<A2UIButtonComponent> & {
  triggerProps?: React.ComponentPropsWithRef<"button">
}) {
  const { resolveString, resolveBoolean } = useA2UIData()
  const { confirm, dialog } = useConfirmDialog()
  const awaitingConfirmation = useRef(false)

  const text = resolveString(component.text, "")
  const isLoading = component.loading ? resolveBoolean(component.loading, false) : false
  const groupPath = component.exclusiveGroup
    ? `/__a2uiExclusiveGroups/group:${encodeURIComponent(component.exclusiveGroup)}`
    : undefined
  const selectedGroupButton = groupPath ? resolveString({ path: groupPath }, "") : ""
  const isDisabled =
    (component.disabled ? resolveBoolean(component.disabled, false) : false) ||
    Boolean(selectedGroupButton)
  const Icon = component.icon ? resolveIcon(component.icon) : undefined
  const variant = variantMap[component.variant || "default"] || "default"

  const handleClick = async (event: React.MouseEvent<HTMLButtonElement>) => {
    triggerProps?.onClick?.(event)
    if (event.defaultPrevented) return
    if (!isDisabled && !isLoading && !awaitingConfirmation.current && component.action) {
      awaitingConfirmation.current = true
      try {
        if (
          component.confirmation &&
          !(await confirm({
            title: text,
            description: component.confirmation.message,
            confirmLabel: component.confirmation.confirmLabel,
            cancelLabel: component.confirmation.cancelLabel,
            destructive: component.variant === "destructive",
          }))
        )
          return
        if (groupPath) onDataChange(groupPath, component.id)
        onAction(component.action, { text })
      } finally {
        awaitingConfirmation.current = false
      }
    }
  }

  return (
    <>
      <Button
        {...triggerProps}
        type="button"
        variant={variant}
        disabled={isDisabled || isLoading}
        onClick={handleClick}
        className={cn(component.className, triggerProps?.className)}
        style={component.style as React.CSSProperties}
      >
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {!isLoading && Icon && component.iconPosition !== "right" && (
          <Icon className="size-4" aria-hidden="true" />
        )}
        {text}
        {!isLoading && Icon && component.iconPosition === "right" && (
          <Icon className="size-4" aria-hidden="true" />
        )}
      </Button>
      {dialog}
    </>
  )
})
