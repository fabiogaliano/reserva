import { describe, expect, it } from 'vitest';
import {
  INCIDENT_DELAY_THRESHOLD_MS,
  actionForSideEffectKind,
  buildOperationalAlert,
  computeNextAttemptAt,
  isDelayIncidentDue,
  isEligibleForAutomaticClaim,
  isMutationEmailOrTourflowKind,
  ownerFacingIncidentTitle,
  projectIncident,
} from '../src/reconciliation-helpers';

describe('computeNextAttemptAt', () => {
  it('follows the 5/10/20/40/60-minute schedule exactly at each attempt boundary', () => {
    const now = new Date('2026-08-14T10:00:00.000Z');
    expect(computeNextAttemptAt(now, 1)).toBe('2026-08-14T10:05:00.000Z');
    expect(computeNextAttemptAt(now, 2)).toBe('2026-08-14T10:10:00.000Z');
    expect(computeNextAttemptAt(now, 3)).toBe('2026-08-14T10:20:00.000Z');
    expect(computeNextAttemptAt(now, 4)).toBe('2026-08-14T10:40:00.000Z');
    expect(computeNextAttemptAt(now, 5)).toBe('2026-08-14T11:00:00.000Z');
  });

  it('caps at 60 minutes for every attempt beyond the fifth', () => {
    const now = new Date('2026-08-14T10:00:00.000Z');
    expect(computeNextAttemptAt(now, 6)).toBe('2026-08-14T11:00:00.000Z');
    expect(computeNextAttemptAt(now, 9)).toBe('2026-08-14T11:00:00.000Z');
  });

  it('treats a sub-1 attempt number the same as attempt 1 (defensive floor)', () => {
    const now = new Date('2026-08-14T10:00:00.000Z');
    expect(computeNextAttemptAt(now, 0)).toBe('2026-08-14T10:05:00.000Z');
  });
});

describe('isEligibleForAutomaticClaim', () => {
  const now = '2026-08-14T10:00:00.000Z';
  it('is eligible when next_attempt_at is null (first pending execution is immediate)', () => {
    expect(isEligibleForAutomaticClaim(null, now)).toBe(true);
  });
  it('is eligible exactly at the boundary (next_attempt_at == now)', () => {
    expect(isEligibleForAutomaticClaim(now, now)).toBe(true);
  });
  it('is eligible after the boundary', () => {
    expect(isEligibleForAutomaticClaim('2026-08-14T09:59:59.999Z', now)).toBe(true);
  });
  it('is ineligible before the boundary', () => {
    expect(isEligibleForAutomaticClaim('2026-08-14T10:00:00.001Z', now)).toBe(false);
  });
});

describe('isDelayIncidentDue', () => {
  it('is not due before the ten-minute threshold', () => {
    const failureStartedAt = '2026-08-14T10:00:00.000Z';
    const now = new Date(Date.parse(failureStartedAt) + INCIDENT_DELAY_THRESHOLD_MS - 1).toISOString();
    expect(isDelayIncidentDue(failureStartedAt, now)).toBe(false);
  });
  it('is due exactly at the ten-minute threshold', () => {
    const failureStartedAt = '2026-08-14T10:00:00.000Z';
    const now = new Date(Date.parse(failureStartedAt) + INCIDENT_DELAY_THRESHOLD_MS).toISOString();
    expect(isDelayIncidentDue(failureStartedAt, now)).toBe(true);
  });
  it('stays due well past the threshold', () => {
    expect(isDelayIncidentDue('2026-08-14T10:00:00.000Z', '2026-08-14T11:00:00.000Z')).toBe(true);
  });
});

describe('actionForSideEffectKind', () => {
  it('maps calendar kinds', () => {
    expect(actionForSideEffectKind('calendar_create')).toBe('calendar');
    expect(actionForSideEffectKind('calendar_delete')).toBe('calendar');
  });
  it('maps the confirmation email kinds (combined and both split recipients)', () => {
    expect(actionForSideEffectKind('email_confirmation')).toBe('confirmation_email');
    expect(actionForSideEffectKind('email:booking.confirmed:customer')).toBe('confirmation_email');
    expect(actionForSideEffectKind('email:booking.confirmed:owner')).toBe('confirmation_email');
  });
  it('maps a non-confirmation email mutation kind to customer_notification', () => {
    expect(actionForSideEffectKind('email:booking.cancelled_by_customer')).toBe('customer_notification');
    expect(actionForSideEffectKind('email:booking.rescheduled:2')).toBe('customer_notification');
  });
  it('maps a tourflow kind to operations_sync', () => {
    expect(actionForSideEffectKind('tourflow:booking.confirmed')).toBe('operations_sync');
    expect(actionForSideEffectKind('tourflow:booking.no_show')).toBe('operations_sync');
  });
  it('maps oversell to oversell', () => {
    expect(actionForSideEffectKind('oversell')).toBe('oversell');
  });
});

describe('isMutationEmailOrTourflowKind', () => {
  it('accepts calendar_delete and email:/tourflow: kinds', () => {
    expect(isMutationEmailOrTourflowKind('calendar_delete')).toBe(true);
    expect(isMutationEmailOrTourflowKind('email:booking.cancelled_by_customer')).toBe(true);
    expect(isMutationEmailOrTourflowKind('tourflow:booking.confirmed')).toBe(true);
  });
  it('rejects confirmation-path-only kinds', () => {
    expect(isMutationEmailOrTourflowKind('calendar_create')).toBe(false);
    expect(isMutationEmailOrTourflowKind('email_confirmation')).toBe(false);
    expect(isMutationEmailOrTourflowKind('oversell')).toBe(false);
  });
});

describe('ownerFacingIncidentTitle', () => {
  it('never contains the internal word "abandoned" for any action', () => {
    const actions = ['confirmation_email', 'customer_notification', 'calendar', 'operations_sync', 'refund', 'oversell'] as const;
    for (const action of actions) {
      expect(ownerFacingIncidentTitle(action).toLowerCase()).not.toContain('abandoned');
    }
  });
  it('uses plain language for each card', () => {
    expect(ownerFacingIncidentTitle('confirmation_email')).toBe('Confirmation email not delivered');
    expect(ownerFacingIncidentTitle('calendar')).toBe('Calendar booking not created');
    expect(ownerFacingIncidentTitle('refund')).toBe('Refund needs attention');
    expect(ownerFacingIncidentTitle('oversell')).toBe('Booking may exceed capacity');
  });
});

describe('projectIncident', () => {
  const detectedDelayed = { detected: true, severity: 'delayed', action: 'calendar', attemptCount: 3, sourceUpdatedAt: 't1' } as const;
  const detectedFinal = { detected: true, severity: 'action_required', action: 'calendar', attemptCount: 10, sourceUpdatedAt: 't2' } as const;
  const notDetected = { detected: false, severity: 'delayed', action: 'calendar', attemptCount: 0, sourceUpdatedAt: 't3' } as const;

  it('opens a brand-new incident when none exists yet', () => {
    expect(projectIncident(detectedDelayed, null)).toEqual({ action: 'open', escalate: false });
  });

  it('updates (no escalation) when severity is unchanged and the incident is already open', () => {
    const existing = { status: 'open', severity: 'delayed', sourceUpdatedAt: 't1', resolutionKind: null } as const;
    expect(projectIncident(detectedDelayed, existing)).toEqual({ action: 'update', escalate: false });
  });

  it('escalates when severity worsens from delayed to action_required on an open incident', () => {
    const existing = { status: 'open', severity: 'delayed', sourceUpdatedAt: 't1', resolutionKind: null } as const;
    expect(projectIncident(detectedFinal, existing)).toEqual({ action: 'update', escalate: true });
  });

  it('never de-escalates: action_required -> delayed on an open incident is an update, not an escalation', () => {
    const existing = { status: 'open', severity: 'action_required', sourceUpdatedAt: 't1', resolutionKind: null } as const;
    expect(projectIncident(detectedDelayed, existing)).toEqual({ action: 'update', escalate: false });
  });

  it('resolves automatically when the source clears while an incident is open', () => {
    const existing = { status: 'open', severity: 'delayed', sourceUpdatedAt: 't1', resolutionKind: null } as const;
    expect(projectIncident(notDetected, existing)).toEqual({ action: 'resolve-automatic' });
  });

  it('does nothing when the source is clear and there is no existing incident', () => {
    expect(projectIncident(notDetected, null)).toEqual({ action: 'skip' });
  });

  it('does nothing when the source is clear and the incident is already resolved', () => {
    const existing = { status: 'resolved', severity: 'delayed', sourceUpdatedAt: 't1', resolutionKind: 'automatic' } as const;
    expect(projectIncident(notDetected, existing)).toEqual({ action: 'skip' });
  });

  it('stays resolved (skip) when manually resolved and the source fingerprint is unchanged', () => {
    const existing = { status: 'resolved', severity: 'delayed', sourceUpdatedAt: 't1', resolutionKind: 'manual' } as const;
    expect(projectIncident(detectedDelayed, existing)).toEqual({ action: 'skip' });
  });

  it('reopens a manually resolved incident once the source fingerprint changes', () => {
    const existing = { status: 'resolved', severity: 'delayed', sourceUpdatedAt: 'stale', resolutionKind: 'manual' } as const;
    expect(projectIncident(detectedDelayed, existing)).toEqual({ action: 'open', escalate: false });
  });

  it('reopens an automatically resolved incident when the source detects debt again', () => {
    const existing = { status: 'resolved', severity: 'delayed', sourceUpdatedAt: 't1', resolutionKind: 'automatic' } as const;
    expect(projectIncident(detectedDelayed, existing)).toEqual({ action: 'open', escalate: false });
  });
});

describe('buildOperationalAlert', () => {
  it('produces exactly the seven approved fields, nothing else', () => {
    const alert = buildOperationalAlert({
      incidentId: 'inc-1', reference: 'BKT-2026-001', action: 'calendar', severity: 'delayed',
      attemptCount: 3, firstDetectedAt: '2026-08-14T10:00:00.000Z', adminUrl: 'https://example.test/admin',
    });
    expect(Object.keys(alert).sort()).toEqual(
      ['action', 'adminUrl', 'attemptCount', 'firstDetectedAt', 'incidentId', 'reference', 'severity'].sort(),
    );
    expect(alert).toEqual({
      incidentId: 'inc-1', reference: 'BKT-2026-001', action: 'calendar', severity: 'delayed',
      attemptCount: 3, firstDetectedAt: '2026-08-14T10:00:00.000Z', adminUrl: 'https://example.test/admin',
    });
  });

  it('never carries a bookingId/customer field even if a caller tries to pass one through excess props', () => {
    const alert = buildOperationalAlert({
      incidentId: 'inc-1', reference: 'BKT-2026-001', action: 'refund', severity: 'action_required',
      attemptCount: 1, firstDetectedAt: '2026-08-14T10:00:00.000Z', adminUrl: 'https://example.test/admin',
      // @ts-expect-error -- excess property outside the declared input type, proving the return
      // shape is constructed field-by-field rather than spread from an arbitrary object.
      bookingId: 'bk-should-never-appear',
    });
    expect('bookingId' in alert).toBe(false);
  });
});
