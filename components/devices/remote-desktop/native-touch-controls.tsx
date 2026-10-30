"use client"

import { useEffect, useLayoutEffect, useState } from "react"
import {
  KEYSYM,
  MODIFIER_KEYSYM,
  TouchKeyBar,
  TouchTrackpadLayer,
  type Modifier,
  type TouchInputMode,
  type TouchLabels,
  type TouchPoint,
  type TouchSurfaceSink,
} from "@cognia/plugin-ui"
import type { Point } from "@/lib/automation/types"
import type { NativeUiAction } from "@/lib/remote-desktop/frames"

type SendInput = (action: NativeUiAction, point: Point | null) => void
interface Geometry {
  width: number
  height: number
  displayWidth: number
  displayHeight: number
}

/** Gesture-to-UiAction adapter belongs to the native viewer, not the kit or RFB. */
export class NativeTouchAdapter implements TouchSurfaceSink {
  private down: {
    point: Point
    at: number
    button: "left" | "right"
    longPress: boolean
    width: number
    height: number
  } | null = null
  private click: { point: Point; timer: ReturnType<typeof setTimeout> } | null = null
  private modifiers = new Set<Modifier>()
  constructor(
    private geometry: () => Geometry | null,
    private send: SendInput
  ) {}
  update(geometry: () => Geometry | null, send: SendInput) {
    this.geometry = geometry
    this.send = send
  }
  private point(at: TouchPoint): Point | null {
    const size = this.geometry()
    if (!size?.displayWidth || !size.displayHeight) return null
    return {
      x: Math.max(0, Math.min(size.width - 1, Math.floor((at.x * size.width) / size.displayWidth))),
      y: Math.max(
        0,
        Math.min(size.height - 1, Math.floor((at.y * size.height) / size.displayHeight))
      ),
    }
  }
  pointer = (at: TouchPoint, buttons: number, longPress = false) => {
    const point = this.point(at)
    const size = this.geometry()
    if (!point || !size) return
    if (buttons && !this.down) {
      this.down = {
        point,
        at: Date.now(),
        button: buttons & 2 ? "right" : "left",
        longPress,
        width: size.width,
        height: size.height,
      }
    } else if (!buttons && this.down) {
      const from = this.down
      this.down = null
      if (size.width !== from.width || size.height !== from.height) return
      if (Math.hypot(point.x - from.point.x, point.y - from.point.y) > 4) {
        this.send({ kind: "drag", to: point, opts: { button: from.button } }, from.point)
      } else if (from.button === "right" || from.longPress || Date.now() - from.at >= 500) {
        this.send({ kind: "click", button: "right", count: 1 }, point)
      } else if (
        this.click &&
        Math.hypot(point.x - this.click.point.x, point.y - this.click.point.y) <= 4
      ) {
        clearTimeout(this.click.timer)
        this.click = null
        this.send({ kind: "click", button: "left", count: 2 }, point)
      } else {
        this.flushClick()
        this.click = { point, timer: setTimeout(() => this.flushClick(), 300) }
      }
    }
  }
  scroll = (at: TouchPoint, dy: number) => {
    const point = this.point(at)
    if (point) this.send({ kind: "scroll", opts: { dx: 0, dy: Math.round(dy) } }, point)
  }
  private flushClick() {
    if (!this.click) return
    const { point, timer } = this.click
    clearTimeout(timer)
    this.click = null
    this.send({ kind: "click", button: "left", count: 1 }, point)
  }
  cancel = () => {
    this.down = null
    this.modifiers.clear()
    if (this.click) clearTimeout(this.click.timer)
    this.click = null
  }
  sendKey = (keysym: number, down?: boolean) => {
    const modifier = (Object.keys(MODIFIER_KEYSYM) as Modifier[]).find(
      (key) => MODIFIER_KEYSYM[key] === keysym
    )
    if (modifier) {
      if (down) this.modifiers.add(modifier)
      else this.modifiers.delete(modifier)
      return
    }
    if (down) return
    const names: Record<number, string> = {
      [KEYSYM.BackSpace]: "Backspace",
      [KEYSYM.Tab]: "Tab",
      [KEYSYM.Return]: "Enter",
      [KEYSYM.Escape]: "Escape",
      [KEYSYM.Left]: "ArrowLeft",
      [KEYSYM.Up]: "ArrowUp",
      [KEYSYM.Right]: "ArrowRight",
      [KEYSYM.Down]: "ArrowDown",
    }
    const char =
      keysym < 0x100
        ? String.fromCodePoint(keysym)
        : keysym >= 0x01000000
          ? String.fromCodePoint(keysym - 0x01000000)
          : null
    if (names[keysym] || this.modifiers.size) {
      this.send(
        {
          kind: "pressKey",
          chord: [
            ...this.modifiers,
            names[keysym] ?? (char === " " ? "Space" : char === "+" ? "Plus" : char),
          ].join("+"),
        },
        null
      )
    } else if (char) this.send({ kind: "typeText", text: char }, null)
  }
  sendText = (text: string, modifiers: readonly Modifier[]) => {
    if (!text) return
    if (!modifiers.length) {
      this.send({ kind: "typeText", text }, null)
      return
    }
    const [first, ...rest] = Array.from(text)
    this.send(
      {
        kind: "pressKey",
        chord: [...modifiers, first === " " ? "Space" : first === "+" ? "Plus" : first].join("+"),
      },
      null
    )
    if (rest.length) this.send({ kind: "typeText", text: rest.join("") }, null)
  }
}

/** Mounted only while this viewer holds control. The adapter never sends held input. */
export function NativeTouchControls({
  surface,
  width,
  height,
  labels,
  input,
}: {
  surface: () => HTMLElement | null
  width: number
  height: number
  labels: TouchLabels
  input: SendInput
}) {
  const [mode, setMode] = useState<TouchInputMode>("trackpad")
  const geometry = () => {
    const rect = surface()?.getBoundingClientRect()
    return rect ? { width, height, displayWidth: rect.width, displayHeight: rect.height } : null
  }
  const [adapter] = useState(() => new NativeTouchAdapter(geometry, input))
  useLayoutEffect(() => {
    adapter.update(geometry, input)
  })
  useEffect(() => () => adapter.cancel(), [adapter])
  return (
    <>
      <TouchTrackpadLayer canvas={surface} labels={labels} inputMode={mode} sink={adapter} />
      <div className="relative">
        <TouchKeyBar
          labels={labels}
          sendKey={adapter.sendKey}
          sendText={adapter.sendText}
          sendCtrlAltDel={() => input({ kind: "pressKey", chord: "ctrl+alt+Delete" }, null)}
          inputMode={mode}
          onInputModeChange={(next) => {
            adapter.cancel()
            setMode(next)
          }}
        />
      </div>
    </>
  )
}
