const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days booked for a freeze, as `freeze()` computed its end. */
export function bookedFreezeDays(start: Date, end: Date): number {
  return Math.max(
    0,
    Math.round((end.getTime() - start.getTime()) / MS_PER_DAY),
  );
}
