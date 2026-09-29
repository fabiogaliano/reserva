---
'@reservajs/stripe': minor
---

The Stripe adapter no longer depends on the Stripe SDK. It calls Stripe's REST API with `fetch` and verifies webhook signatures with WebCrypto, matching the SDK's API version, request encoding, retries, error classes and signature checks. A Worker no longer loads about 550 KB of SDK code on the first payment request in each isolate, which could exceed the Workers Free plan's 10 ms CPU limit and fail checkouts, refunds and webhooks with error 1102. The `stripe()` options and exported types are unchanged. A stripe-node instance can still be injected through `client`.
