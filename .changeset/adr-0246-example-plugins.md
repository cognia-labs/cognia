---
"cognia-next": patch
---

A consumer-grant revocation now also drops in-flight integration reads, both after the response arrives and after it is parsed. The SDK root exports the auth types a Host-managed provider needs. Four example plugins (auth provider, docs provider, issue sync, backup destination) prove the public ADR-0246 paths for third parties.
