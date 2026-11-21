---
"cognia-next": patch
---

Spending limits no longer let two requests through together near a ceiling (past the warning level they run one at a time, each judged on what the last one booked), one "allow one more request" approval now lets exactly one request through, a limit whose spend cannot be read asks before sending instead of sending unchecked, a replayed turn is checked against the limit when it is sent, and the settings page says the limits count booked spend and that a hard cap needs Router + Fusion.
