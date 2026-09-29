import type { Booking } from '../../src/core/booking';
import type { BookingInsert, BookingRepository, CapacityGuardInput } from '../../src/repo';

// Seeds a hold through the production checkout write, for suites whose subject is something
// downstream of the hold. Capacity is ample so the guard never refuses; a suite that sets a day
// override or capacity default below its seeded load gets a loud failure instead of a silent skip.
export async function seedHold(
  repo: BookingRepository,
  input: BookingInsert & Partial<CapacityGuardInput>,
): Promise<Booking> {
  const created = await repo.insertHoldWithCapacity({
    occupancyUnits: 1,
    occupancyEndsAt: input.endsAt,
    localDate: input.startsAt.slice(0, 10),
    defaultCapacity: 1000,
    ...input,
  });
  if (!created) throw new Error(`seedHold: the capacity guard refused ${input.id}`);
  return created;
}
