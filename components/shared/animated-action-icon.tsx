"use client"

import {
  type ForwardRefExoticComponent,
  type HTMLAttributes,
  type RefAttributes,
  useCallback,
  useEffect,
  useRef,
} from "react"

import { motion } from "motion/react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { CheckIcon } from "@/components/ui/check"
import { CopyIcon } from "@/components/ui/copy"
import { SPRING_POP } from "@/lib/ui/motion"
import { cn } from "@/lib/utils"

const ICON_ANIMATION_DURATION_MS = 700
const INTERACTIVE_ANCESTOR_SELECTOR =
  'button, a, [role="button"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])'

export interface AnimatedIconHandle {
  startAnimation: () => void
  stopAnimation: () => void
}

export interface AnimatedIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number
}

export type AnimatedIconComponent = ForwardRefExoticComponent<
  AnimatedIconProps & RefAttributes<AnimatedIconHandle>
>

export interface AnimatedActionIconProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  icon: AnimatedIconComponent
  size?: number
  /** Replays the icon whenever this value changes after the initial render. */
  animateOnChange?: string | number | boolean
}

export function AnimatedActionIcon({
  icon: Icon,
  size = 16,
  animateOnChange,
  className,
  style,
  ...props
}: AnimatedActionIconProps) {
  const { reduce, durationScale } = useFlowMotion()
  const iconRef = useRef<AnimatedIconHandle>(null)
  const containerRef = useRef<HTMLSpanElement>(null)
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(false)

  const clearStopTimer = useCallback(() => {
    if (stopTimerRef.current !== null) {
      clearTimeout(stopTimerRef.current)
      stopTimerRef.current = null
    }
  }, [])

  const startAnimation = useCallback(() => {
    if (reduce) return
    clearStopTimer()
    iconRef.current?.startAnimation()
  }, [clearStopTimer, reduce])

  const stopAnimation = useCallback(() => {
    clearStopTimer()
    iconRef.current?.stopAnimation()
  }, [clearStopTimer])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const trigger = container.closest<HTMLElement>(INTERACTIVE_ANCESTOR_SELECTOR) ?? container

    trigger.addEventListener("mouseenter", startAnimation)
    trigger.addEventListener("mouseleave", stopAnimation)
    trigger.addEventListener("focusin", startAnimation)
    trigger.addEventListener("focusout", stopAnimation)

    return () => {
      trigger.removeEventListener("mouseenter", startAnimation)
      trigger.removeEventListener("mouseleave", stopAnimation)
      trigger.removeEventListener("focusin", startAnimation)
      trigger.removeEventListener("focusout", stopAnimation)
    }
  }, [startAnimation, stopAnimation])

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    if (animateOnChange === undefined || reduce) return

    startAnimation()
    stopTimerRef.current = setTimeout(stopAnimation, ICON_ANIMATION_DURATION_MS * durationScale)
    return clearStopTimer
  }, [animateOnChange, clearStopTimer, durationScale, reduce, startAnimation, stopAnimation])

  useEffect(() => clearStopTimer, [clearStopTimer])

  return (
    <span
      ref={containerRef}
      aria-hidden="true"
      data-slot="animated-action-icon"
      className={cn("inline-flex shrink-0", className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      <Icon ref={iconRef} size={size} className="inline-flex size-full" />
    </span>
  )
}

export interface CopyFeedbackIconProps extends Omit<
  AnimatedActionIconProps,
  "animateOnChange" | "icon"
> {
  copied: boolean
}

/** The check fades back to the copy glyph on the same ease-out as streamed text. */
const COPY_FEEDBACK_FADE = { duration: 0.32, ease: [0.215, 0.61, 0.355, 1] } as const
const COPY_GLYPH_SWAP = { duration: 0.18, ease: [0.215, 0.61, 0.355, 1] } as const
const INSTANT = { duration: 0 } as const

/**
 * Copy glyph that confirms a copy and then puts itself out. Both glyphs stay
 * mounted, stacked: on `copied` the check pops in on an under-damped spring
 * (one small rebound — a reward, not a toy) and draws itself, and when the
 * caller's `copied` flag resets (`COPY_FEEDBACK_MS`, 2.5s) the check fades out
 * while the copy glyph fades back. Swapping a single glyph made the tick vanish
 * in one frame. Reduced motion keeps the swap and drops the movement.
 */
export function CopyFeedbackIcon({
  copied,
  size = 16,
  className,
  style,
  ...props
}: CopyFeedbackIconProps) {
  const { reduce } = useFlowMotion()
  return (
    <span
      aria-hidden="true"
      data-slot="copy-feedback-icon"
      data-state={copied ? "copied" : "idle"}
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      <motion.span
        data-layer="copy"
        data-visible={!copied}
        className="absolute inset-0 inline-flex"
        initial={false}
        animate={copied ? { opacity: 0, scale: 0.8 } : { opacity: 1, scale: 1 }}
        transition={reduce ? INSTANT : COPY_GLYPH_SWAP}
      >
        <AnimatedActionIcon icon={CopyIcon} size={size} />
      </motion.span>
      <motion.span
        data-layer="check"
        data-visible={copied}
        className="absolute inset-0 inline-flex"
        initial={false}
        animate={copied ? { opacity: 1, scale: 1 } : { opacity: 0, scale: 0.6 }}
        transition={reduce ? INSTANT : copied ? SPRING_POP : COPY_FEEDBACK_FADE}
      >
        <AnimatedActionIcon icon={CheckIcon} size={size} animateOnChange={copied} />
      </motion.span>
    </span>
  )
}
