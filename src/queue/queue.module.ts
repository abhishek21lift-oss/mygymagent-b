import { Injectable, Module, OnModuleDestroy, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';

/**
 * Owns the single IORedis connection every BullMQ queue/worker in the app
 * shares. BullMQ deliberately never closes a connection it didn't create
 * itself (the assumption being the caller might share it elsewhere,
 * exactly as we do here) -- so without a provider whose onModuleDestroy
 * explicitly quits it, `app.close()` leaves the Redis connection open
 * forever. That's exactly what caused the e2e suite to hang after a
 * fully green run before this existed (Jest: "did not exit one second
 * after the test run has completed").
 */
@Injectable()
export class QueueConnection implements OnModuleDestroy {
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

  async onModuleDestroy(): Promise<void> {
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
