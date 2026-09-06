import { Module } from '@nestjs/common';
import { MemberAssessmentsController } from './member-assessments.controller';
import { MemberAssessmentsService } from './member-assessments.service';
import { MemberDetailsController } from './member-details.controller';
import { MemberDetailsService } from './member-details.service';
import { MemberDocumentsController } from './member-documents.controller';
import { MemberDocumentsService } from './member-documents.service';
import { MemberDuplicateService } from './member-duplicate.service';
import { MemberGoalsController } from './member-goals.controller';
import { MemberGoalsService } from './member-goals.service';
import { Member360Service } from './member-360.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  controllers: [
    MembersController,
    MemberDetailsController,
    MemberAssessmentsController,
    MemberGoalsController,
    MemberDocumentsController,
  ],
  providers: [
    MembersService,
    MemberDetailsService,
    MemberAssessmentsService,
    MemberGoalsService,
    MemberDocumentsService,
    Member360Service,
    MemberDuplicateService,
  ],
  exports: [
    MembersService,
    MemberDetailsService,
    Member360Service,
    MemberDuplicateService,
  ],
})
export class MembersModule {}
