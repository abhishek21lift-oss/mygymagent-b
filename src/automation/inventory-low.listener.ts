import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { OnEvent } from '@nestjs/event-emitter';
import type { Queue } from 'bullmq';
import { DomainEvent, type InventoryLowEvent } from '../events/domain-events';
import { JOB_NAMES, QUEUE_NAMES } from '../queue/queue.constants';

/**
 * First consumer of `inventory.low`, which has fired (see
 * StockMovementsService.record()) since the P0 overselling fix with no
 * listener until now. Real-time, not a scan -- the event only fires on
 * the crossing edge (stock going from above to at-or-below reorderLevel),
 * so this can enqueue on every occurrence without needing its own
 * dedup/cooldown check the way the scanners do. Enqueues rather than
 * sending inline for the same reason MemberCreatedListener does -- see
 * that class's comment.
 */
@Injectable()
export class InventoryLowListener {
  private readonly logger = new Logger(InventoryLowListener.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.AUTOMATION) private readonly queue: Queue,
  ) {}

  @OnEvent(DomainEvent.InventoryLow)
  async handleInventoryLow(event: InventoryLowEvent): Promise<void> {
    try {
      await this.queue.add(JOB_NAMES.SEND_LOW_STOCK_ALERT, event);
    } catch (error) {
      this.logger.error(
        `Failed to enqueue low-stock alert for product ${event.productId}: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
}
