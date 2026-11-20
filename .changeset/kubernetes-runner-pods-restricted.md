---
"cognia-next": patch
---

Kubernetes runner pods now pass a Restricted namespace: they run as uid 10001 with the default seccomp profile, take the server pod's RuntimeClass and image pull secrets, and declare an ephemeral-storage limit. A pod that fails to start reports why (unschedulable, image pull, crash). A pod that fails after it starts is deleted at once instead of waiting for the next boot. Docker runner pulls now send the registry credentials from `COGNIA_REGISTRY_AUTH_FILE`.
