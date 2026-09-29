---
'@reservajs/astro': patch
---

A per-recipient confirmation email that the configured email provider cannot send on its own (no `sendToRecipient`, e.g. after switching providers) is now abandoned with the operator's side-effect-abandoned log, instead of being marked delivered without being sent.
