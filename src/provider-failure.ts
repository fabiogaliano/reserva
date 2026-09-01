// Plan 016 (audit finding #12, scoped): internal-only provider failure classification. Never
// re-exported by src/index.ts, src/providers/index.ts, or src/core/index.ts — the audit's full
// finding (an EXPORTED cross-provider error contract with adapter contract tests) was explicitly
// rejected/deferred (see docs/plans/README.md's rejected-findings list). This module exists solely
// to feed the outbox attempt cap (src/confirmation.ts): "was this failure worth retrying, and what
// HTTP status (if any) should the abandonment log carry".

const MAX_MESSAGE_CHARS = 500;

export interface ProviderFailureInit {
  // Explicit `| undefined` (not just optional): exactOptionalPropertyTypes lets a caller pass an
  // already-optional `response?.status` straight through without an extra narrowing step.
  status?: number | undefined;
  retryable?: boolean;
  message: string;
}

// Default HTTP retryability policy (plan 016 decision 1): 408 (timeout), 425 (too early), and 429
// (rate limited), plus every 5xx, are transient — worth another attempt. Every other 4xx (401,
// 403, 404, 422, ...) is a permanent rejection of this exact request; retrying it unchanged would
// never succeed. A missing status (a non-HTTP throw — a network TypeError, a DNS failure, a
// malformed-response guard) defaults retryable: an ambiguous failure should keep being retried
// rather than be silently abandoned.
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

// The internal base a classified provider failure extends. The two adapters with an existing
// EXPORTED error class (BrevoResponseError, WebhookResponseError) extend this directly, so
// `instanceof BrevoResponseError`/`instanceof WebhookResponseError` and their `.status` property
// keep working unchanged for existing consumers (design decision 2: "existing public class names
// can extend the internal base where compatibility requires them").
export class ProviderFailure extends Error {
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(init: ProviderFailureInit) {
    super(init.message.slice(0, MAX_MESSAGE_CHARS));
    this.name = 'ProviderFailure';
    this.status = init.status;
    this.retryable = init.retryable ?? isRetryableStatus(init.status);
  }
}

// Classifies an arbitrary caught error into the {status, retryable} shape the outbox attempt cap
// needs (src/confirmation.ts), without requiring every throw site to construct a ProviderFailure —
// any error exposing a numeric `.status` (including a plain object, not just a ProviderFailure
// subclass) is read structurally; anything else (a non-HTTP error) defaults retryable via
// isRetryableStatus(undefined).
export function classifyProviderError(error: unknown): { status: number | undefined; retryable: boolean } {
  if (error instanceof ProviderFailure) return { status: error.status, retryable: error.retryable };
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return { status, retryable: isRetryableStatus(status) };
  }
  return { status: undefined, retryable: true };
}
