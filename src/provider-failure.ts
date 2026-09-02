// Internal-only provider failure classification, never re-exported. An EXPORTED cross-provider
// error contract with adapter contract tests was considered and rejected. This module exists
// solely to answer: was this failure worth retrying, and what HTTP status should the log carry.

const MAX_MESSAGE_CHARS = 500;

export interface ProviderFailureInit {
  // Explicit `| undefined` (not just optional): exactOptionalPropertyTypes lets a caller pass an
  // already-optional `response?.status` straight through without an extra narrowing step.
  status?: number | undefined;
  retryable?: boolean;
  message: string;
}

// Default retryability policy: 408, 425, 429, and every 5xx are transient — worth another attempt.
// Every other 4xx is a permanent rejection of this exact request. A missing status (a non-HTTP
// throw) defaults retryable: an ambiguous failure should keep being retried, not silently abandoned.
export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500;
}

// The internal base a classified provider failure extends. BrevoResponseError and
// WebhookResponseError extend this directly, so `instanceof`/`.status` keep working unchanged
// for existing consumers.
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
// needs, without requiring every throw site to construct a ProviderFailure — any error exposing a
// numeric `.status` is read structurally; anything else defaults retryable.
export function classifyProviderError(error: unknown): { status: number | undefined; retryable: boolean } {
  if (error instanceof ProviderFailure) return { status: error.status, retryable: error.retryable };
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status;
    if (typeof status === 'number') return { status, retryable: isRetryableStatus(status) };
  }
  return { status: undefined, retryable: true };
}
