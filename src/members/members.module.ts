import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { MemberBulkController } from './member-bulk.controller';
import { MemberBulkService } from './member-bulk.service';
import { MemberDuplicatesController } from './member-duplicates.controller';
import { MemberDuplicatesService } from './member-duplicates.service';
import { MemberFollowUpsController } from './member-follow-ups.controller';
import { MemberFollowUpsService } from './member-follow-ups.service';
import {
  MemberTagsController,
  MemberTagAssignmentsController,
} from './member-tags.controller';
import { MemberTagsService } from './member-tags.service';
import { MemberCommunicationsController } from './member-communications.controller';
import { MemberCommunicationsService } from './member-communications.service';
import { Member360Controller } from './member-360.controller';
import { Member360Service } from './member-360.service';
import { MemberAssessmentsController } from './member-assessments.controller';
import { MemberAssessmentsService } from './member-assessments.service';
import { MemberDetailsController } from './member-details.controller';
import { MemberDetailsService } from './member-details.service';
import { MemberDocumentsController } from './member-documents.controller';
import { MemberDocumentsService } from './member-documents.service';
import { MemberGoalsController } from './member-goals.controller';
import { MemberGoalsService } from './member-goals.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';

@Module({
  imports: [CommunicationsModule],
  controllers: [
    // Static/nested member routes first: Express matches in registration
    // order, so Member360Controller ('overview'/'timeline') and
    // MemberTagsController ('tags') must precede MembersController's
    // GET /members/:id, which would otherwise swallow them as ids.
    Member360Controller,
    MemberTagsController,
    MemberBulkController,
    MemberDuplicatesController,
    MembersController,
    MemberTagAssignmentsController,
    MemberDetailsController,
    MemberAssessmentsController,
    MemberGoalsController,
    MemberDocumentsController,
    MemberFollowUpsController,
    MemberCommunicationsController,
  ],
  providers: [
    MembersService,
    MemberDetailsService,
    MemberAssessmentsService,
    MemberGoalsService,
    MemberDocumentsService,
    MemberTagsService,
    MemberBulkService,
    MemberDuplicatesService,
    MemberFollowUpsService,
    MemberCommunicationsService,
    Member360Service,
  ],
  exports: [
    MembersService,
    MemberDetailsService,
    MemberFollowUpsService,
  ],
})
export class MembersModule {}
