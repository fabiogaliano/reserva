import type { D1Database } from '@cloudflare/workers-types';
import { parsePartnerOffer, type PartnerOffer } from './core/partner-offers.js';
import type { AdminChangeAudit } from './repo.js';

/** Operator-only current partner state. Never serialize this record in a customer response. */
export interface PartnerRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly state: 'active' | 'archived';
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly offer: PartnerOffer | null;
}

/** Parsed changes exclude immutable codes and caller-authored timestamps/revisions. */
export interface PartnerChanges {
  readonly name: string;
  readonly state: 'active' | 'archived';
  readonly offer: PartnerOffer | null;
}

/** Expected persistence failures remain distinguishable from unavailable referral codes. */
export class PartnerStoreError extends Error {
  readonly _tag = 'PartnerStoreError' as const;
  constructor(readonly reason: 'invalid_input' | 'conflict' | 'unavailable', message: string, readonly cause?: unknown) {
    super(message);
  }
}

/** Public result of a partner persistence operation. */
export type PartnerStoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PartnerStoreError };

/** Operator totals for attributed bookings, using their stable association rather than live labels. */
export interface PartnerBookingCount {
  readonly partnerId: string;
  readonly upcoming: number;
  readonly past: number;
}

/**
 * Registry persistence capability. Code lookup is single-record only; list is operator-only.
 * Service eligibility/payment floors must be checked by the application before a save.
 */
export interface PartnerStore {
  findByCode(code: string): Promise<PartnerStoreResult<PartnerRecord | null>>;
  list(): Promise<PartnerStoreResult<readonly PartnerRecord[]>>;
  bookingCounts(now: string): Promise<PartnerStoreResult<readonly PartnerBookingCount[]>>;
  create(input: { readonly id: string; readonly code: string; readonly changes: PartnerChanges }, audit: AdminChangeAudit): Promise<PartnerStoreResult<PartnerRecord>>;
  save(id: string, expectedRevision: number, changes: PartnerChanges, audit: AdminChangeAudit): Promise<PartnerStoreResult<PartnerRecord>>;
}

function fail(reason: PartnerStoreError['reason'], message: string, cause?: unknown): PartnerStoreResult<never> {
  return { ok: false, error: new PartnerStoreError(reason, message, cause) };
}

/** Referral codes are exact, lowercase, bounded identifiers; no public registry is needed to parse one. */
export function parseReferralCode(input: unknown): PartnerStoreResult<string> {
  if (typeof input !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input)) {
    return fail('invalid_input', 'Referral code must be 1–64 lowercase letters, numbers, hyphens or underscores, starting with a letter or number.');
  }
  return { ok: true, value: input };
}

function parseChanges(input: PartnerChanges): PartnerStoreResult<PartnerChanges> {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 200) return fail('invalid_input', 'Partner name must contain 1–200 characters.');
  if (input.state !== 'active' && input.state !== 'archived') return fail('invalid_input', 'Partner state must be active or archived.');
  const parsed = input.offer === null ? null : parsePartnerOffer(input.offer);
  if (parsed && !parsed.ok) return fail('invalid_input', parsed.error.message);
  return { ok: true, value: { name: input.name.trim(), state: input.state, offer: parsed?.ok ? parsed.value : null } };
}

interface PartnerRow {
  id: string;
  code: string;
  name: string;
  state: string;
  revision: number;
  created_at: string;
  updated_at: string;
  enabled: number | null;
  basis_points: number | null;
  waived_pickup_ids: string | null;
}

const selectPartners = `SELECT p.id, p.code, p.name, p.state, p.revision, p.created_at, p.updated_at,
  o.enabled, o.basis_points, o.waived_pickup_ids FROM partners p LEFT JOIN partner_offers o ON o.partner_id = p.id`;

function parseRow(row: PartnerRow): PartnerStoreResult<PartnerRecord> {
  const code = parseReferralCode(row.code);
  if (!code.ok || !row.id || !Number.isSafeInteger(row.revision) || row.revision < 1) return fail('unavailable', 'Stored partner record is invalid.');
  let offer: PartnerOffer | null = null;
  if (row.enabled !== null) {
    if (row.enabled !== 0 && row.enabled !== 1) return fail('unavailable', 'Stored offer switch is invalid.');
    const parsed = parsePartnerOffer({ enabled: row.enabled === 1, basisPoints: row.basis_points, waivedPickupIds: JSON.parse(row.waived_pickup_ids ?? 'null') });
    if (!parsed.ok) return fail('unavailable', 'Stored partner offer is invalid.', parsed.error);
    offer = parsed.value;
  }
  const changes = parseChanges({ name: row.name, state: row.state === 'active' ? 'active' : 'archived', offer });
  if (!changes.ok || (row.state !== 'active' && row.state !== 'archived')) return fail('unavailable', 'Stored partner state is invalid.');
  return { ok: true, value: { id: row.id, code: code.value, ...changes.value, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } };
}

/**
 * D1 adapter for the registry and atomic revision-checked audit writes.
 * changes() chains the winning CAS into the audit and offer writes within one D1 batch.
 * A losing stale form cannot modify benefits or append misleading history.
 */
export function createPartnerStore(db: D1Database): PartnerStore {
  async function persist(
    input: { readonly id: string; readonly code?: string; readonly expectedRevision?: number; readonly changes: PartnerChanges },
    audit: AdminChangeAudit,
  ): Promise<PartnerStoreResult<PartnerRecord>> {
    const parsed = parseChanges(input.changes);
    if (!parsed.ok) return parsed;
    if (!input.id || input.id.length > 100 || !Number.isFinite(Date.parse(audit.changedAt))) return fail('invalid_input', 'Partner ID and audit timestamp are required.');
    const changes = parsed.value;
    const creating = input.code !== undefined;
    if (creating) {
      const code = parseReferralCode(input.code);
      if (!code.ok) return code;
    } else if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision ?? 0) < 1) {
      return fail('invalid_input', 'Expected revision must be a positive integer.');
    }
    try {
      const mutation = creating
        ? db.prepare(`INSERT INTO partners(id, code, name, state, revision, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`)
          .bind(input.id, input.code, changes.name, changes.state, audit.changedAt, audit.changedAt)
        : db.prepare(`UPDATE partners SET name = ?, state = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND revision = ?`)
          .bind(changes.name, changes.state, audit.changedAt, input.id, input.expectedRevision);
      const history = db.prepare(`INSERT INTO admin_change_history(domain, item_key, action, value, actor, changed_at)
          SELECT 'partner', ?, 'upsert', ?, ?, ? WHERE changes() = 1`)
        .bind(input.id, JSON.stringify(changes), audit.actor, audit.changedAt);
      const offer = changes.offer;
      const offerMutation = offer === null
        ? db.prepare(`DELETE FROM partner_offers WHERE partner_id = ? AND changes() = 1`).bind(input.id)
        : db.prepare(`INSERT INTO partner_offers(partner_id, enabled, basis_points, waived_pickup_ids, revision, created_at, updated_at)
            SELECT ?, ?, ?, ?, 1, ?, ? WHERE changes() = 1
            ON CONFLICT(partner_id) DO UPDATE SET enabled = excluded.enabled, basis_points = excluded.basis_points,
              waived_pickup_ids = excluded.waived_pickup_ids, revision = partner_offers.revision + 1, updated_at = excluded.updated_at`)
          .bind(input.id, offer.enabled ? 1 : 0, offer.basisPoints, JSON.stringify(offer.waivedPickupIds), audit.changedAt, audit.changedAt);
      const results = await db.batch([mutation, history, offerMutation, db.prepare(`${selectPartners} WHERE p.id = ?`).bind(input.id)]);
      if (results[0]?.meta.changes !== 1) return fail('conflict', creating ? 'Referral code or partner ID is already reserved.' : 'Partner changed since this form was opened. Reload before saving.');
      // SAFETY: The fourth statement selects only the explicitly aliased PartnerRow columns above;
      // parseRow checks domain invariants before exposing the record.
      const row = results[3]?.results[0] as PartnerRow | undefined;
      if (!row) return fail('unavailable', 'Saved partner could not be read.');
      return parseRow(row);
    } catch (cause) {
      return fail('unavailable', 'Partner storage is unavailable.', cause);
    }
  }
  return {
    async findByCode(code) {
      const parsed = parseReferralCode(code);
      if (!parsed.ok) return parsed;
      try {
        const row = await db.prepare(`${selectPartners} WHERE p.code = ?`).bind(parsed.value).first<PartnerRow>();
        return row ? parseRow(row) : { ok: true, value: null };
      } catch (cause) {
        return fail('unavailable', 'Partner storage is unavailable.', cause);
      }
    },
    async list() {
      try {
        const result = await db.prepare(`${selectPartners} ORDER BY p.created_at, p.id`).all<PartnerRow>();
        const records: PartnerRecord[] = [];
        for (const row of result.results) {
          const parsed = parseRow(row);
          if (!parsed.ok) return parsed;
          records.push(parsed.value);
        }
        return { ok: true, value: records };
      } catch (cause) {
        return fail('unavailable', 'Partner storage is unavailable.', cause);
      }
    },
    async bookingCounts(now) {
      try {
        const result = await db.prepare(`SELECT partner_id AS partnerId,
            SUM(CASE WHEN starts_at >= ? THEN 1 ELSE 0 END) AS upcoming,
            SUM(CASE WHEN starts_at < ? THEN 1 ELSE 0 END) AS past
            FROM bookings WHERE partner_id IS NOT NULL AND status IN ('hold', 'confirmed', 'no_show') GROUP BY partner_id`)
          .bind(now, now).all<PartnerBookingCount>();
        return { ok: true, value: result.results };
      } catch (cause) {
        return fail('unavailable', 'Partner booking counts are unavailable.', cause);
      }
    },
    create: (input, audit) => persist(input, audit),
    save: (id, expectedRevision, changes, audit) => persist({ id, expectedRevision, changes }, audit),
  };
}
