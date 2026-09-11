import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';

/**
 * Gym calendar: generic bookings (trial, consultation, assessment,
 * follow-up) plus trainer availability windows and time off. PT
 * sessions stay in src/pt-sessions/ -- the calendar FEED merges them
 * read-only so the calendar page shows one timeline without a second
 * writable PT copy. See AppointmentsService for the overlap and scoping
 * rules.
 */
@Module({
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
