import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import { DomainEvent, type MemberCreatedEvent } from '../events/domain-events';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';

/**
 * First real consumer of the domain event bus (src/events/domain-events.ts
 * has fired member.created since the deep-foundation phase; nothing
 * listened until now). Enqueues a job rather than sending the email
 * inline -- the point of the queue is that a slow/failing mail provider
 * never blocks or fails the HTTP request that created the member.
 *
 * `@nestjs/event-emitter`'s default `.emit()` (used by MembersService) is
 * fire-and-forget -- nothing awaits this handler or its returned promise,
 * so it can never fail the request that created the member no matter what
 * happens inside it. The try/catch below only ever fires for an error
 * `queue.add()` actually rejects with (e.g. a malformed payload); it does
 * NOT fire during a Redis *outage*, because the shared connection is
 * configured with unlimited command retries (required by BullMQ's own
 * blocking operations -- see queue.module.ts) and ioredis's offline queue,
 * so `queue.add()` simply stays pending until Redis is reachable again
 * rather than rejecting. Net effect: during an outage, a welcome-email
 * enqueue is delayed until Redis recovers (not dropped, not erroring) --
 * unless the process restarts first, in which case the pending add is
 * lost with it. Acceptable for a best-effort welcome email; revisit if a
 * future job type on this queue needs a stronger delivery guarantee.
 */
@Injectable()
export class MemberCreatedListener {
  private readonly logger = new Logger(MemberCreatedListener.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.NOTIFICATIONS) private readonly queue: Queue,
  ) {}

  @OnEvent(DomainEvent.MemberCreated)
  async handleMemberCreated(event: MemberCreatedEvent): Promise<void> {
    if (!event.email) return;
    try {
      await this.queue.add(JOB_NAMES.SEND_WELCOME_EMAIL, {
        memberId: event.memberId,
        email: event.email,
        firstName: event.firstName,
      });
    } catch (error) {
      this.logger.error(
        `Failed to enqueue welcome email for member ${event.memberId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}
