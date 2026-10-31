---
title: "0245 — A paired device is granted workspaces, not a Host"
description: "Besides the Owner invitation for a person's own devices, a Host can issue a restricted invitation that starts with no access. A restricted device is granted per workspace: read files, write files, read session history. The Host resolves each workspace from its own trusted roots, so a requester's paths or allowedRoots never widen a grant. Running an agent, a terminal or a browser stays a Host-level grant unless the Host can enforce a sandbox on that workspace. Host management keeps its own name and is never relabelled as a workspace grant."
---

# ADR 0245 — A paired device is granted workspaces, not a Host

**Status:** Proposed
**Date:** 2026-10-31
**Related:** [ADR-0143](./0143-device-console) (device console, unknown is not offline), [ADR-0149](./0149-a-person-is-not-a-device) (person, device, membership), [ADR-0172](./0172-remote-access-is-verified-not-assumed) (verified reachability), [ADR-0182](./0182-a-project-names-the-image-it-runs-in) and [ADR-0183](./0183-the-agent-is-brought-to-the-image) (sandboxed execution), [ADR-0222](./0222-a-conversations-files-are-a-view-and-sharing-them-is-a-grant) (file-share grants), [ADR-0244](./0244-a-remote-run-has-stopped-only-when-its-worker-says-so) (revocation is not stop)

## Context

Pairing and device lifecycle are solid: an invitation is a hashed, single-use secret with a 300 s or 600 s TTL; revocation is terminal; a revoked device id or key cannot re-enrol (`crates/cognia-companion-security/src/security_store.rs`). Authorization is not fine-grained:

- **Every invitation mints an Owner.** `register_owner_device` inserts `role = 'owner'` with default grants including `host.admin`, `terminal.open`, `process.spawn` and `secret.manage`. Pairing is full access.
- **Grants are per device.** `capability_grants` is `(tenant, device, capability)` with no root. `Control` bundles `agent.run`, `workspace.read`, `workspace.write`, `git.write` and `workflow.run`.
- **Per-root grants exist elsewhere.** External Bridge grants roots by `WorkspaceRoot.id` per MCP caller (`lib/external-bridge/workspace/grants.ts`); file-share grants (ADR-0222) cover WebDAV, SFTP and collaboration members. Neither applies to paired devices.
- **Containment trusted the requester.** The remote `write_text_file_confined` and `ensure_dir_confined` arms took `allowedRoots` from the RPC arguments, and a `..` after a not-yet-existing component passed the ancestor check and escaped on write. Both are fixed alongside this ADR (Host roots bound the request; unresolved traversal is refused before any directory is created).
- **Direct-path identity is weaker than relay.** The relay path verifies the Host signing key from the QR code. The direct path pins TLS only on Capacitor native; elsewhere `serverFingerprint` is dropped, and the post-pairing fingerprint check compares the invitation's own `fp`, not the certificate seen on the wire.

The primary scenario is one person's devices (a laptop delegating to a desktop or an always-on box). Multi-person Hosts reuse the organization membership model (ADR-0149), not this ADR.

## Decision

1. **Two invitations.** The Owner invitation stays for a person's own devices and keeps today's grants. A restricted invitation enrols a device with no workspace grants and no Host management. "Pairing does not grant everything" is the restricted invitation's meaning, and the console says which kind a device holds.

2. **Workspace grants.** A grant is `(device, workspaceId, capabilities)` with capabilities drawn from `files.read`, `files.write` and `sessions.read`. `workspaceId` names a Host workspace (a registered desktop project root, or a directory under a headless Host's spawn-policy workspaces root). It is listed, granted, revoked and audited from the device console. No grant means no access.

3. **The Host resolves paths.** Every file, session or execution request names a `workspaceId`, and the Host resolves it to a canonical root from its own trusted source: the desktop registry or the headless spawn policy. Requester paths and `allowedRoots` can narrow, never widen. Containment canonicalizes the deepest existing ancestor, refuses unresolved `..`/`.` traversal before creating anything, re-checks after creating directories, and refuses a symlinked final component. Windows prefixes are compared only on canonical forms.

4. **Execution is not scoped by file tools.** `agent.run`, terminal and browser access stay Host-level grants. A workspace-scoped `agent.run` exists only when the Host advertises an enforceable sandbox for that workspace (ADR-0182/0183), and such a run never falls back to an unsandboxed spawn. The grant UI states this: with shell access, file-tool limits do not confine directory access.

5. **Host management keeps its name.** Owner and admin capabilities (`host.admin`, `secret.manage`, lifecycle actions) are shown as Host management. They are never presented as, or migrated into, workspace grants, and existing Owner devices keep them.

6. **Changes re-check.** A grant change or revocation takes effect for the next operation. Queued tasks and pending interrupts re-check at dispatch or decision time (ADR-0244 decision 7); in-flight runs follow the ADR-0244 stop path.

7. **Identity is verified on every path.** A direct-path pairing pins the Host's SPKI on every client that can (desktop through its own TLS stack, Capacitor native), compares the pin against the certificate on the wire before the invitation is spent, and refuses a mismatch. The pairing room closes when the invitation is redeemed, not only at expiry.

## Consequences

- Restricted devices are useful for reading and editing files and history on a workspace. Running agents there needs either Host-level trust or a sandboxed workspace. This is deliberate: anything weaker would claim a boundary that a shell crosses.
- New records and wire fields: invitation kind, the `workspace_grants` table on the Host, and `workspaceId` on file and session requests. Old clients that send raw paths are refused for restricted devices.
- Remote `@file` references in the composer use `files.read` on a granted workspace.

## Not done

- Org-wide or cross-person delegation (ADR-0149's membership owns that).
- A per-workspace browser profile.
- Grants on git or workflow operations beyond what `files.write` and Host-level `agent.run` already cover.

## Alternatives considered

- **Every pairing starts with nothing.** It matches "pairing grants nothing", but it adds a step to a person's own devices, the dominant case. The restricted invitation covers the other case.
- **Soft workspace scoping for agents, with a warning.** Rejected: it claims a confinement that a shell defeats.
