---
"cognia-next": patch
---

`provider usage` and the provider usage report now read every page of the OpenAI and Anthropic usage reports, count Anthropic cache writes, print an unpriced model as "cost unknown" (a partly priced one as "≥ $x") instead of `$0.0000`, and count only CLI sessions that ran inside the chosen window.
