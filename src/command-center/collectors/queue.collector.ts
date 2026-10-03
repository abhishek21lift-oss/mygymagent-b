import { Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QUEUE_NAMES } from '../../queue/queue.constants';
import type { Collector, CollectorResult } from '../collectors.types';

export interface QueueDepth {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

export interface QueueCard {
  queues: {
    name: string;
    status: 'ok' | 'unavailable';
    /** Null when this one queue could not be read -- never 0. */
    depth: QueueDepth | null;
    unavailableReason?: string;
  }[];
  totals: QueueDepth;
}

const BACKLOG_THRESHOLD = 100;

/**
 * Injection token for the map of every queue this collector reports on.
 * The module provides it from the same QUEUE_NAMES list the collector
 * iterates, so the two cannot drift.
 */
export const QUEUE_DEPTH_QUEUES = 'COMMAND_CENTER_QUEUE_DEPTH_QUEUES';

/** The queues this collector reports on, from the app's own constants. */
export const MONITORED_QUEUES: readonly string[] = Object.values(QUEUE_NAMES);

/**
 * BullMQ depth per queue — the first queue introspection this codebase has.
 *
 * Uses the queues already registered by the modules that produce work, over
 * the single shared QueueConnection. No second Redis client, no second queue
 * registry: a monitoring surface that opened its own connection would report
 * a different view of the same queues than the workers do.
 *
 * Per-queue isolation is the point. One unreadable queue degrades its own row
 * and is excluded from the totals, rather than failing the card -- a console
 * that reported "no backlog" because one queue timed out would be wrong
 * during exactly the incident it exists for.
 */
@Injectable()
export class QueueDepthCollector implements Collector<QueueCard> {
  readonly name = 'queues';
  readonly timeoutMs = 5_000;

  private readonly queues: Record<string, Queue>;

  /**
   * One `Record` of every queue, assembled in the module rather than as one
   * constructor parameter per queue. Four `@InjectQueue` params would work,
   * but then the list of queues exists twice -- once here, once in the
   * module's `imports` -- and adding a fifth queue to one and not the other
   * binds `undefined`. Per-queue degradation would then swallow it: the
   * card would report that queue as "unavailable" forever and look like a
   * transient Redis problem instead of a wiring mistake.
   */
  constructor(@Inject(QUEUE_DEPTH_QUEUES) queues: Record<string, Queue>) {
    this.queues = queues;
  }

  async collect(): Promise<CollectorResult<QueueCard>> {
    const rows = await Promise.all(
      Object.entries(this.queues).map(async ([name, queue]) => {
        try {
          // 'paused' is not a BullMQ JobType -- a paused queue's waiting
          // jobs are reported as 'waiting' with isPaused set on the queue
          // itself, so it is read from the queue rather than counted here.
          const counts = await queue.getJobCounts(
            'waiting',
            'active',
            'completed',
            'failed',
            'delayed',
          );
          return {
            name,
            status: 'ok' as const,
            depth: {
              waiting: counts.waiting ?? 0,
              active: counts.active ?? 0,
              completed: counts.completed ?? 0,
              failed: counts.failed ?? 0,
              delayed: counts.delayed ?? 0,
              paused: (await queue.isPaused()) ? (counts.waiting ?? 0) : 0,
            },
          };
        } catch (error) {
          return {
            name,
            status: 'unavailable' as const,
            depth: null,
            unavailableReason:
              error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const totals: QueueDepth = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    };
    let degraded = false;
    for (const row of rows) {
      if (row.depth) {
        for (const key of Object.keys(totals) as (keyof QueueDepth)[]) {
          totals[key] += row.depth[key];
        }
      } else {
        degraded = true;
      }
    }

    // A failure count is backlog too: an idle queue that keeps failing is not
    // healthy, and a card that only looked at `waiting` would call it fine.
    // A paused queue is the same: its jobs are not being worked, so an
    // operator seeing depth 0 and no failures would otherwise conclude the
    // queue had nothing to do.
    const status =
      degraded ||
      totals.failed > 0 ||
      totals.paused > 0 ||
      totals.waiting >= BACKLOG_THRESHOLD
        ? 'degraded'
        : 'ok';

    return {
      status,
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
      value: { queues: rows, totals },
    };
  }
}
