import { Module } from '@nestjs/common';
import { MemberAssessmentsController } from './member-assessments.controller';
import { MemberAssessmentsService } from './member-assessments.service';
import { MemberCommunicationsController } from './member-communications.controller';
import { MemberCommunicationsService } from './member-communications.service';
import { MemberDetailsController } from './member-details.controller';
import { MemberDetailsService } from './member-details.service';
import { MemberDocumentsController } from './member-documents.controller';
import { MemberDocumentsService } from './member-documents.service';
import { MemberDuplicateService } from './member-duplicate.service';
import { MemberFollowUpsController } from './member-follow-ups.controller';
import { MemberFollowUpsService } from './member-follow-ups.service';
import { MemberGoalsController } from './member-goals.controller';
import { MemberGoalsService } from './member-goals.service';
import { Member360Service } from './member-360.service';
import { MemberTagsController } from './member-tags.controller';
import { MemberTagsService } from './member-tags.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { CommunicationsModule } from '../communications/communications.module';

@Module({
  imports: [CommunicationsModule],
  controllers: [
    MembersController,
    MemberDetailsController,
    MemberAssessmentsController,
    MemberGoalsController,
    MemberDocumentsController,
    MemberFollowUpsController,
    MemberTagsController,
    MemberCommunicationsController,
  ],
  providers: [
    MembersService,
    MemberDetailsService,
    MemberAssessmentsService,
    MemberGoalsService,
    MemberDocumentsService,
    Member360Service,
    MemberDuplicateService,
    MemberFollowUpsService,
    MemberTagsService,
    MemberCommunicationsService,
  ],
  exports: [
    MembersService,
    MemberDetailsService,
    Member360Service,
    MemberDuplicateService,
    MemberFollowUpsService,
    MemberTagsService,
  ],
})
export class MembersModule {}
