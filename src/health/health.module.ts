import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

// No imports needed for the Redis check -- QueueConnection is exported
// globally by QueueModule (see src/queue/queue.module.ts). Deliberately
// NOT registering a second BullMQ queue here just to get a health-check
// handle: two `registerQueue({ name: 'notifications' })` calls in the same
// app (this module and NotificationsModule) create two separate Queue
// wrappers around the same Redis queue, and something in their shutdown
// bookkeeping didn't fully clean up across the e2e suite's 16 sequential
// test apps -- Jest warned "did not exit one second after the test run
// completed" until this was reduced back to one Queue registration.
@Module({ controllers: [HealthController] })
export class HealthModule {}
