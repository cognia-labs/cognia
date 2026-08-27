---
"cognia-next": minor
---

Plugin authors now import only the package roots. `cognia plugin lint` and `cognia plugin build` reject any `@/` alias or `@cognia/plugin-{sdk,ui}` subpath in a plugin's own source, before esbuild runs — previously such a plugin built cleanly and was refused at load time, or worse, had the host module inlined into its bundle where the loader's text scan could no longer see it. The load-time boundary now covers every `@/` directory rather than four of them.
