"use client"

/**
 * Keeps one module's slot component or effect from taking the host down
 * (ADR-0250 §14). A failure renders nothing in place of that one
 * contribution, and is logged with the module and what failed, so the rest
 * of the host, and every other module's contribution, keeps working.
 */

import { Component, type ErrorInfo, type ReactNode } from "react"

import { loggers } from "@cognia/logging"

interface Props {
  /** The contributing module's id. */
  module: string
  /** What it contributes here: `slot:<point>` or `effect:<name>`. */
  part: string
  children: ReactNode
}

interface State {
  failed: boolean
}

export class ModuleBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    loggers.ui.error(`module ${this.props.module} ${this.props.part} failed`, error, {
      componentStack: info.componentStack ?? undefined,
    })
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
