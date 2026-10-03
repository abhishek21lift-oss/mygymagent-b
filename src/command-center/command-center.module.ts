import { Module, type Provider } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { NotificationsModule } from '../notifications/notifications.module';
import { AutomationModule } from '../automation/automation.module';
import { WhatsappWebModule } from '../whatsapp-web/whatsapp-web.module';
import { AiUsageCollector } from './collectors/ai-usage.collector';
import {
  QueueDepthCollector,
  QUEUE_DEPTH_QUEUES,
} from './collectors/queue.collector';
import { ReadinessCollector } from './collectors/readiness.collector';
import {
  COMMAND_CENTER_CACHE,
  COMMAND_CENTER_COLLECTORS,
  SnapshotService,
} from './snapshot.service';
import { CommandCenterController } from './command-center.controller';
import type { Collector } from './collectors.types';
import type { Queue } from 'bullmq';
import type { SnapshotCache } from './snapshot.service';

/**
 * In-process TTL cache for snapshots.
 *
 * Deliberately a `Map` in memory rather than Redis. The snapshot is derived
 * data with a 10-second life, and putting it in Redis would mean a second
 * consumer of the one connection whose health this console reports on -- so
 * a Redis outage could blank the very card meant to explain it. The cost is
 * that the cache is per-instance, which for a cache this short-lived is not
 * a meaningful difference.
 */
class InMemorySnapshotCache implements SnapshotCache {
  private readonly store = new Map<
    string,
    { value: unknown; expiresAt: number }
  >();

  get(key: string) {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value as never;
  }

  set(key: string, value: never, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

/**
 * Every queue, as one injected map. See QUEUE_DEPTH_QUEUES on the collector
 * for why this is a map rather than one `@InjectQueue` parameter per queue.
 */
const queueMapProvider: Provider = {
  provide: QUEUE_DEPTH_QUEUES,
  useFactory: (...queues: Queue[]): Record<string, Queue> =>
    Object.fromEntries(
      Object.values(QUEUE_NAMES).map((name, i) => [name, queues[i]]),
    ),
  inject: Object.values(QUEUE_NAMES).map((name) => getQueueToken(name)),
};

const collectorListProvider: Provider = {
  provide: COMMAND_CENTER_COLLECTORS,
  useFactory: (...collectors: Collector[]): Collector[] => collectors,
  inject: [ReadinessCollector, QueueDepthCollector, AiUsageCollector],
};

/**
 * Read-only Command Center telemetry. Platform-staff-only (enforced by the
 * controller's `@RequirePlatformRole()`), and read-only by construction: no
 * collector in this module writes, and none of them is handed a service that
 * could.
 *
 * Host-level metrics (CPU, memory, Docker, disk) are deliberately absent.
 * Collecting them needs either the Docker socket or host `/proc` mounted into
 * this container, and production's compose file is not in this repository --
 * so whether that is possible is unknown, and a card that guessed would be
 * worse than a card that does not exist. Add them when the compose file is
 * version-controlled and the answer is known.
 */
@Module({
  imports: [
    // The modules that own each queue, re-exported BullModule and all. This
    // module deliberately does NOT call BullModule.registerQueue itself:
    // registering a queue name a second module already registered yields a
    // second Queue object over the same Redis keys, so the collector would
    // be reading through a handle no worker holds. That duplication is not
    // merely wasteful — it silently broke
    // automation-overview.e2e-spec.ts, whose `app.get(getQueueToken(...))`
    // spy stopped patching the instance the service under test actually used.
    NotificationsModule,
    AutomationModule,
    WhatsappWebModule,
  ],
  controllers: [CommandCenterController],
  providers: [
    ReadinessCollector,
    QueueDepthCollector,
    AiUsageCollector,
    queueMapProvider,
    collectorListProvider,
    { provide: COMMAND_CENTER_CACHE, useClass: InMemorySnapshotCache },
    SnapshotService,
  ],
  exports: [SnapshotService],
})
export class CommandCenterModule {}
