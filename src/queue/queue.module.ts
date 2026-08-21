import {
  Injectable,
  Module,
  OnApplicationShutdown,
  Global,
} from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

/**
 * Owns the single IORedis connection every BullMQ queue/worker in the app
 * shares. BullMQ deliberately never closes a connection it didn't create
 * itself (the assumption being the caller might share it elsewhere,
 * exactly as we do here) -- so without a provider that explicitly quits
 * it, `app.close()` leaves the Redis connection open forever.
 *
 * Deliberately `OnApplicationShutdown`, not `OnModuleDestroy`: NestJS
 * runs every provider's `onModuleDestroy` hook to completion (across the
 * whole app) *before* starting the `onApplicationShutdown` phase, and
 * `@nestjs/bullmq`'s worker-closing hook (which waits for any
 * currently-active job to finish) is itself an `onApplicationShutdown`
 * hook, not `onModuleDestroy`. Quitting this connection from
 * `onModuleDestroy` would race ahead of that -- killing the shared Redis
 * connection while a worker still has an active job in flight, which
 * then can never report completion back to Redis, so the worker's
 * (and therefore `app.close()`'s) close-and-wait hangs forever. Staying
 * in the same `onApplicationShutdown` phase, and relying on
 * `BullModule.forRootAsync`'s `inject: [QueueConnection]` below (NestJS
 * destroys a dependency after its dependents, in both phases), is what
 * actually guarantees workers finish first.
 */
@Injectable()
export class QueueConnection implements OnApplicationShutdown {
  readonly client: IORedis;

  constructor(config: ConfigService) {
    this.client = new IORedis(
      config.get<string>('REDIS_URL', 'redis://localhost:6379'),
      {
        // Required by BullMQ -- it manages its own retry/backoff for
        // blocking commands; letting ioredis also retry them breaks that.
        maxRetriesPerRequest: null,
      },
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.quit();
  }
}

/// Split out so BullModule.forRootAsync (below) can `inject: [QueueConnection]`
/// -- an async-registered dynamic module resolves its `inject` array against
/// providers visible via its own `imports`, not just "whatever's in the
/// enclosing module" -- same reason ConfigModule is imported wherever
/// ConfigService is injected this way.
@Global()
@Module({
  providers: [QueueConnection],
  exports: [QueueConnection],
})
class QueueConnectionModule {}

/**
 * Shared BullMQ setup, registered once, globally, so every module that
 * needs a queue (`BullModule.registerQueue({ name: ... })`) doesn't
 * reconnect to Redis on its own. This is genuinely new infrastructure --
 * see docs/architecture/discovery-report.md's Phase D and
 * docs/import-export.md's "this is a real infrastructure gap" note --
 * not a wrapper around something that already existed.
 *
 * Deliberate choice: the worker(s) run in the same process as the API
 * (no separate worker deployment/dyno). Reasonable at current scale (one
 * backend instance); revisit -- split into a dedicated worker process --
 * once job volume or processing time makes that a real cost, not before.
 */
@Global()
@Module({
  imports: [
    QueueConnectionModule,
    BullModule.forRootAsync({
      imports: [QueueConnectionModule],
      inject: [QueueConnection],
      useFactory: (queueConnection: QueueConnection) => ({
        connection: queueConnection.client,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          // Keep Redis from growing unbounded -- completed/failed jobs
          // are debugging aids, not permanent records (that's
          // AuditLog's job for anything that needs to survive).
          removeOnComplete: { age: 24 * 60 * 60, count: 1_000 },
          removeOnFail: { age: 7 * 24 * 60 * 60 },
        },
      }),
    }),
  ],
  exports: [BullModule, QueueConnectionModule],
})
export class QueueModule {}
