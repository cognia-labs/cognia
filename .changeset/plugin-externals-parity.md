---
"cognia-next": patch
---

Plugin bundles no longer carry `@/types/plugin` and `@/lib/*` as esbuild externals. Those two entries guaranteed the artifact could never load — the loader refuses any surviving `@/` specifier before evaluating a bundle — so a plugin that used them built cleanly and died on install. Author build scripts now also leave `lucide-react` external, which the host shares and a bundle should never carry a second copy of.
