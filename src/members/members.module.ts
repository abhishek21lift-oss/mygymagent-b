import { Module } from '@nestjs/common';
import { MemberAssessmentsController } from './member-assessments.controller';
import { MemberAssessmentsService } from './member-assessments.service';
import { MemberDetailsController } from './member-details.controller';
import { MemberDetailsService } from './member-details.service';
import { MemberGoalsController } from './member-goals.controller';
import { MemberGoalsService } from './member-goals.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  controllers: [
    MembersController,
    MemberDetailsController,
    MemberAssessmentsController,
    MemberGoalsController,
  ],
  providers: [
    MembersService,
    MemberDetailsService,
    MemberAssessmentsService,
    MemberGoalsService,
  ],
  exports: [MembersService],
})
export class MembersModule {}
