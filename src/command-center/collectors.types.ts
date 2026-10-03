/**
 * Shared collector types.
 *
 * ── The rule every collector obeys ──────────────────────────────────────────
 *
 * A collector is read-only, is individually timeout-guarded, and NEVER
 * throws. One dead dependency degrades one card; it must never fail the
 * snapshot, and it must never take the page down with it.
 *
 * `unavailableReason` is therefore not an error message — it is a first-class
 * answer. "Redis is healthy" and "we could not see Redis" are different
 * states, and a console that renders both as a green tick will eventually
 * have somebody restart the wrong thing.
 */

export type CardStatus = 'ok' | 'degraded' | 'unavailable';

/**
 * `value` is `null` — never a zero, never an empty object — when the card
 * could not be measured. A zero would be indistinguishable from a real
 * measurement of zero, which is exactly the fabrication Phase 3 forbids.
 */
export interface CollectorResult<T = unknown> {
  status: CardStatus;
  value: T | null;
  /** How long the collector took, measured regardless of outcome. */
  latencyMs: number;
  checkedAt: string;
  /** Present when status is 'unavailable' — says what could not be measured. */
  unavailableReason?: string;
}

export interface Collector<T = unknown> {
  name: string;
  /** Hard ceiling on this collector alone, so a hung dependency cannot
   *  stall the whole snapshot. */
  timeoutMs: number;
  collect(): Promise<CollectorResult<T>>;
}

/** A snapshot is a map of card name -> result, plus when it was taken. */
export type Snapshot = Record<string, CollectorResult> & {
  collectedAt: string;
  /** Wall time for the whole parallel collection. */
  durationMs: number;
};

/** Wraps a collector so it can never throw and never exceed its timeout. */
export async function runCollector<T>(
  collector: Collector<T>,
): Promise<CollectorResult<T>> {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();

  try {
    const result = await withTimeout(
      collector.collect(),
      collector.timeoutMs,
      `${collector.name} exceeded its ${collector.timeoutMs}ms budget`,
    );
    return { ...result, latencyMs: Date.now() - startedAt, checkedAt };
  } catch (error) {
    return {
      status: 'unavailable',
      value: null,
      latencyMs: Date.now() - startedAt,
      checkedAt,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    // `.unref()` so a pending collector timer can never hold the process
    // open on its own — the same reason the readiness probe unrefs its
    // 2s race (see health.controller.ts).
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
