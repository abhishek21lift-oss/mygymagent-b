import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../prisma/prisma.service';
import { QueueConnection } from '../queue/queue.module';

@Controller()
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueConnection: QueueConnection,
  ) {}

  /**
   * Liveness: is the process itself up? No dependency checks. An
   * orchestrator uses this to decide whether to restart the container.
   */
  @Public()
  @Get('health')
  @HttpCode(HttpStatus.OK)
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness: can this instance actually serve traffic? Checks the
   * database connection and the job queue's Redis connection. An
   * orchestrator/load balancer uses this to decide whether to route
   * requests here; a 503 pulls the instance out of rotation without
   * restarting it.
   *
   * Redis being down does NOT mean the API can't serve most traffic --
   * only job enqueueing degrades (see the class comment on
   * MemberCreatedListener for exactly what happens to a pending enqueue
   * during an outage) -- but a *sustained* Redis outage is still worth
   * surfacing here so it gets noticed, not silently ignored forever.
   */
  @Public()
  @Get('ready')
  async readiness() {
    const startedAt = Date.now();
    let database: 'up' | 'down' = 'up';
    let queue: 'up' | 'down' = 'up';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'down';
    }

    try {
      // The shared connection is configured with maxRetriesPerRequest:
      // null (required by BullMQ's own blocking commands -- see
      // queue.module.ts), which also means a plain await here would hang
      // indefinitely while Redis is down instead of failing fast, since
      // ioredis just queues the command and keeps retrying the
      // connection forever. A readiness probe needs to fail fast, so
      // race it against an explicit timeout instead. `.unref()` keeps
      // this timer from holding the process open on its own (relevant in
      // tests, where an app can be created and closed many times).
      await Promise.race([
        this.queueConnection.client.ping(),
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new Error('queue health check timed out')),
            2_000,
          ).unref();
        }),
      ]);
    } catch {
      queue = 'down';
    }

    if (database === 'down' || queue === 'down') {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        database,
        queue,
      });
    }

    return {
      status: 'ready',
      database,
      queue,
      latencyMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    };
  }
}
