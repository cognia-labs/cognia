/**
 * Plugin Conflict Detector
 *
 * Detects and reports conflicts between plugins including:
 * - Version conflicts in shared dependencies
 * - API namespace collisions
 * - Resource conflicts
 * - Incompatible capability requirements
 */

import { intersects, validRange } from "semver"
import type { PluginManifest, PluginCapability } from "@/types/plugin"
import { satisfiesConstraint } from "./dependency-resolver"
import { slashCommandToken } from "@/lib/slash-commands/plugin-commands"

// =============================================================================
// Types
// =============================================================================

export interface PluginConflict {
  type: ConflictType
  severity: ConflictSeverity
  plugins: string[]
  description: string
  resolution?: string
  autoResolvable: boolean
}

export type ConflictType =
  "version" | "namespace" | "resource" | "capability" | "command" | "shortcut"

export type ConflictSeverity = "error" | "warning" | "info"

export interface ConflictDetectionResult {
  hasConflicts: boolean
  errors: PluginConflict[]
  warnings: PluginConflict[]
  info: PluginConflict[]
  canProceed: boolean
  autoResolutions: ConflictResolution[]
}

export interface ConflictResolution {
  conflict: PluginConflict
  action: "prioritize"
  targetPlugin?: string
  details: string
}

export interface PluginRegistration {
  manifest: PluginManifest
  commands?: string[]
  shortcuts?: string[]
  namespaces?: string[]
  resources?: string[]
}

/** Manifest-known shared keys. Runtime-only resources remain registration
 * metadata; plugin-local modes/templates are already namespaced by the host. */
export function createPluginRegistration(manifest: PluginManifest): PluginRegistration {
  return {
    manifest,
    commands: (manifest.commands ?? []).flatMap((command) => {
      const id = `${manifest.id}.${command.id}`
      const aliases = [
        ...new Set((command.aliases ?? []).map((a) => a.trim().toLowerCase())),
      ].filter((a) => a && a !== command.id.toLowerCase())
      return [
        `id:${id}`,
        `slash:${slashCommandToken({ id, name: command.name })}`,
        ...aliases.flatMap((alias) => {
          const aliasId = `${id}#alias:${alias}`
          return [`id:${aliasId}`, `slash:${slashCommandToken({ id: aliasId, name: alias })}`]
        }),
      ]
    }),
    shortcuts: [
      ...(manifest.quickActions ?? []).map((a) => a.accelerator),
      ...(manifest.trayItems ?? []).map((a) => a.accelerator),
      // Backward compatibility with older manifests carrying command shortcuts.
      ...(manifest.commands ?? []).map((c) => (c as { shortcut?: string }).shortcut),
    ].filter((s): s is string => Boolean(s)),
    namespaces: [
      ...(manifest.tools ?? []).map((tool) => `tool:${tool.name}`),
      ...(manifest.a2uiComponents ?? []).map((component) => `component:${component.type}`),
    ],
  }
}

// =============================================================================
// Conflict Detector
// =============================================================================

export class ConflictDetector {
  private registrations: Map<string, PluginRegistration> = new Map()

  constructor() {}

  // ===========================================================================
  // Registration
  // ===========================================================================

  registerPlugin(registration: PluginRegistration): void {
    this.registrations.set(registration.manifest.id, registration)
  }

  unregisterPlugin(pluginId: string): void {
    this.registrations.delete(pluginId)
  }

  setPlugins(registrations: PluginRegistration[]): void {
    this.registrations.clear()
    for (const reg of registrations) {
      this.registrations.set(reg.manifest.id, reg)
    }
  }

  // ===========================================================================
  // Conflict Detection
  // ===========================================================================

  detectAll(): ConflictDetectionResult {
    const conflicts: PluginConflict[] = []

    // Run all detection checks
    conflicts.push(...this.detectVersionConflicts())
    conflicts.push(...this.detectNamespaceConflicts())
    conflicts.push(...this.detectCommandConflicts())
    conflicts.push(...this.detectShortcutConflicts())
    conflicts.push(...this.detectCapabilityConflicts())
    conflicts.push(...this.detectResourceConflicts())

    // Categorize by severity
    const errors = conflicts.filter((c) => c.severity === "error")
    const warnings = conflicts.filter((c) => c.severity === "warning")
    const info = conflicts.filter((c) => c.severity === "info")

    // Generate auto-resolutions
    const autoResolutions = this.generateAutoResolutions(conflicts)

    return {
      hasConflicts: conflicts.length > 0,
      errors,
      warnings,
      info,
      canProceed: errors.length === 0,
      autoResolutions,
    }
  }

  detectForPlugin(pluginId: string): ConflictDetectionResult {
    const all = this.detectAll()
    const errors = all.errors.filter((c) => c.plugins.includes(pluginId))
    const warnings = all.warnings.filter((c) => c.plugins.includes(pluginId))
    const info = all.info.filter((c) => c.plugins.includes(pluginId))
    const conflicts = [...errors, ...warnings, ...info]
    return {
      hasConflicts: conflicts.length > 0,
      errors,
      warnings,
      info,
      canProceed: errors.length === 0,
      autoResolutions: this.generateAutoResolutions(conflicts),
    }
  }

  // ===========================================================================
  // Version Conflict Detection
  // ===========================================================================

  private detectVersionConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const dependencyRequirements: Map<
      string,
      Array<{ pluginId: string; constraint: string }>
    > = new Map()

    // Collect all dependency requirements
    for (const [pluginId, reg] of this.registrations.entries()) {
      const deps = reg.manifest.dependencies
      if (!deps) continue

      for (const [depId, constraint] of Object.entries(deps)) {
        if (!dependencyRequirements.has(depId)) {
          dependencyRequirements.set(depId, [])
        }
        dependencyRequirements.get(depId)!.push({ pluginId, constraint })
      }
    }

    // Check for conflicting requirements
    for (const [depId, requirements] of dependencyRequirements.entries()) {
      if (requirements.length === 0) continue

      // Check if all constraints can be satisfied by a single version
      const installedDep = this.registrations.get(depId)
      const unsatisfied = installedDep
        ? requirements.filter(
            (req) => !satisfiesConstraint(installedDep.manifest.version, req.constraint)
          )
        : []

      if (installedDep && unsatisfied.length > 0) {
        conflicts.push({
          type: "version",
          severity: "error",
          plugins: [depId, ...unsatisfied.map((u) => u.pluginId)],
          description: `Version conflict for ${depId}: installed ${installedDep.manifest.version} does not satisfy constraints from ${unsatisfied.map((u) => `${u.pluginId}(${u.constraint})`).join(", ")}`,
          resolution: `Update ${depId} to a version that satisfies all constraints`,
          autoResolvable: false,
        })
      }

      // Check for mutually exclusive constraints
      for (let i = 0; i < requirements.length; i++) {
        for (let j = i + 1; j < requirements.length; j++) {
          if (!this.constraintsCompatible(requirements[i].constraint, requirements[j].constraint)) {
            conflicts.push({
              type: "version",
              severity: "warning",
              plugins: [requirements[i].pluginId, requirements[j].pluginId],
              description: `Potentially incompatible version constraints for ${depId}: ${requirements[i].constraint} vs ${requirements[j].constraint}`,
              autoResolvable: false,
            })
          }
        }
      }
    }

    return conflicts
  }

  private constraintsCompatible(a: string, b: string): boolean {
    const rangeA = a.trim() === "latest" ? "*" : a
    const rangeB = b.trim() === "latest" ? "*" : b
    return validRange(rangeA) !== null && validRange(rangeB) !== null && intersects(rangeA, rangeB)
  }

  // ===========================================================================
  // Namespace Conflict Detection
  // ===========================================================================

  private detectNamespaceConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const namespaceOwners: Map<string, string[]> = new Map()

    for (const [pluginId, reg] of this.registrations.entries()) {
      const namespaces = new Set(reg.namespaces || [pluginId])

      for (const ns of namespaces) {
        if (!namespaceOwners.has(ns)) {
          namespaceOwners.set(ns, [])
        }
        namespaceOwners.get(ns)!.push(pluginId)
      }
    }

    for (const [namespace, owners] of namespaceOwners.entries()) {
      if (owners.length > 1) {
        conflicts.push({
          type: "namespace",
          severity: "error",
          plugins: owners,
          description: `Namespace collision: "${namespace}" is claimed by multiple plugins`,
          resolution:
            "The first registered plugin keeps this key; disable it to select another provider",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  // ===========================================================================
  // Command Conflict Detection
  // ===========================================================================

  private detectCommandConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const commandOwners: Map<string, string[]> = new Map()

    for (const [pluginId, reg] of this.registrations.entries()) {
      const commands = new Set(reg.commands || [])

      for (const cmd of commands) {
        if (!commandOwners.has(cmd)) {
          commandOwners.set(cmd, [])
        }
        commandOwners.get(cmd)!.push(pluginId)
      }
    }

    for (const [command, owners] of commandOwners.entries()) {
      if (owners.length > 1) {
        conflicts.push({
          type: "command",
          severity: "warning",
          plugins: owners,
          description: `Command collision: "${command}" is registered by multiple plugins`,
          resolution: "The first registered plugin keeps this command",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  // ===========================================================================
  // Shortcut Conflict Detection
  // ===========================================================================

  private detectShortcutConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const shortcutOwners: Map<string, string[]> = new Map()

    for (const [pluginId, reg] of this.registrations.entries()) {
      const shortcuts = new Set((reg.shortcuts || []).map((s) => this.normalizeShortcut(s)))

      for (const shortcut of shortcuts) {
        const normalized = this.normalizeShortcut(shortcut)
        if (!shortcutOwners.has(normalized)) {
          shortcutOwners.set(normalized, [])
        }
        shortcutOwners.get(normalized)!.push(pluginId)
      }
    }

    for (const [shortcut, owners] of shortcutOwners.entries()) {
      if (owners.length > 1) {
        conflicts.push({
          type: "shortcut",
          severity: "warning",
          plugins: owners,
          description: `Shortcut collision: "${shortcut}" is registered by multiple plugins`,
          resolution: "The first registered binding keeps this shortcut",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  private normalizeShortcut(shortcut: string): string {
    return shortcut
      .toLowerCase()
      .split("+")
      .map((key) => key.trim())
      .filter(Boolean)
      .sort()
      .join("+")
  }

  // ===========================================================================
  // Capability Conflict Detection
  // ===========================================================================

  private detectCapabilityConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const exclusiveCapabilities: PluginCapability[] = ["themes"]

    for (const capability of exclusiveCapabilities) {
      const pluginsWithCapability: string[] = []

      for (const [pluginId, reg] of this.registrations.entries()) {
        if (reg.manifest.capabilities?.includes(capability)) {
          pluginsWithCapability.push(pluginId)
        }
      }

      if (pluginsWithCapability.length > 1) {
        conflicts.push({
          type: "capability",
          severity: "info",
          plugins: pluginsWithCapability,
          description: `Multiple plugins provide "${capability}" capability`,
          resolution: "Select the active theme in settings; theme providers can remain installed",
          autoResolvable: false,
        })
      }
    }

    return conflicts
  }

  // ===========================================================================
  // Resource Conflict Detection
  // ===========================================================================

  private detectResourceConflicts(): PluginConflict[] {
    const conflicts: PluginConflict[] = []
    const resourceOwners: Map<string, string[]> = new Map()

    for (const [pluginId, reg] of this.registrations.entries()) {
      const resources = new Set(reg.resources || [])

      for (const resource of resources) {
        if (!resourceOwners.has(resource)) {
          resourceOwners.set(resource, [])
        }
        resourceOwners.get(resource)!.push(pluginId)
      }
    }

    for (const [resource, owners] of resourceOwners.entries()) {
      if (owners.length > 1) {
        conflicts.push({
          type: "resource",
          severity: "warning",
          plugins: owners,
          description: `Resource conflict: "${resource}" is used by multiple plugins`,
          resolution: "The first-registered plugin gets priority for this resource",
          autoResolvable: true,
        })
      }
    }

    return conflicts
  }

  // Resolution plans describe executable policy, never promise an unimplemented
  // rename/rebind or an unverified dependency version. Version changes are
  // reviewed and installed through the marketplace dependency flow.
  private generateAutoResolutions(conflicts: PluginConflict[]): ConflictResolution[] {
    return conflicts
      .filter((c) => c.autoResolvable && c.type !== "version")
      .map((conflict) => ({
        conflict,
        action: "prioritize" as const,
        targetPlugin: conflict.plugins[0],
        details:
          "Keep the first registered provider; replacing it requires explicit disable confirmation.",
      }))
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  getRegisteredPlugins(): string[] {
    return Array.from(this.registrations.keys())
  }

  getPluginRegistration(pluginId: string): PluginRegistration | undefined {
    return this.registrations.get(pluginId)
  }

  clear(): void {
    this.registrations.clear()
  }
}

// =============================================================================
// Singleton Instance
// =============================================================================

let conflictDetectorInstance: ConflictDetector | null = null

export function getConflictDetector(): ConflictDetector {
  if (!conflictDetectorInstance) {
    conflictDetectorInstance = new ConflictDetector()
  }
  return conflictDetectorInstance
}

export function resetConflictDetector(): void {
  if (conflictDetectorInstance) {
    conflictDetectorInstance.clear()
    conflictDetectorInstance = null
  }
}
