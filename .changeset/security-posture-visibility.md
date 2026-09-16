---
"@reservajs/astro": patch
---

Security posture is now reported instead of silently assumed. `OpsHealthResponse` gains `security: { csrfTokenLayer, tokenEncryption, adminAuth }`, and the admin dashboard's Attention area shows a warning card naming the secret to set when the CSRF or token-encryption layer is off. A Cloudflare Access assertion with neither `email` nor `sub` is now rejected (403) with a warning instead of resolving to an empty subject, and reading a secret outside `secretBindings` warns once per isolate per name.
