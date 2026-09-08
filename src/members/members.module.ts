import { Module } from '@nestjs/common';
import { MemberAssessmentsController } from './member-assessments.controller';
import { MemberAssessmentsService } from './member-assessments.service';
import { MemberCommunicationsController } from './member-communications.controller';
import { MemberCommunicationsService } from './member-communications.service';
import { MemberCommunicationsIntegrityService } from './member-communications-integrity.service';
import { MemberDetailsController } from './member-details.controller';
import { MemberDetailsService } from './member-details.service';
import { MemberDocumentsController } from './member-documents.controller';
import { MemberDocumentsService } from './member-documents.service';
import { MemberDocumentsIntegrityService } from './member-documents-integrity.service';
import { MemberDuplicateService } from './member-duplicate.service';
import { MemberFollowUpsController } from './member-follow-ups.controller';
import { MemberFollowUpsService } from './member-follow-ups.service';
import { MemberFollowUpsIntegrityService } from './member-follow-ups-integrity.service';
import { MemberGoalsController } from './member-goals.controller';
import { MemberGoalsService } from './member-goals.service';
import { Member360Service } from './member-360.service';
import { Member360IntegrityService } from './member-360-integrity.service';
import { MemberBulkTagsController } from './member-bulk-tags.controller';
import { MemberTagsController } from './member-tags.controller';
import { MemberTagsService } from './member-tags.service';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MemberIntegrityService } from './member-integrity.service';
import { CommunicationsModule } from '../communications/communications.module';

@Module({
  imports: [CommunicationsModule],
  controllers: [
    // ROUTE ORDER MATTERS (Express matches first-registered first).
    // MemberBulkTagsController must stay FIRST and is the ONLY owner of
    // POST /members/bulk/tags: without it, MemberTagsController's earlier
    // @Post(':memberId/tags') swallows the request with memberId='bulk'
    // and its AssignMemberTagsDto (forbidNonWhitelisted) rejects the
    // memberIds field with a 400. MembersController deliberately does NOT
    // declare this route (it would be shadowed dead code).
    MemberBulkTagsController,
    // Register static /members/tags routes before the dynamic /members/:id routes.
    MemberTagsController,
    MembersController,
    MemberDetailsController,
    MemberAssessmentsController,
    MemberGoalsController,
    MemberDocumentsController,
    MemberFollowUpsController,
    MemberCommunicationsController,
  ],
  providers: [
    { provide: MembersService, useClass: MemberIntegrityService },
    MemberDetailsService,
    MemberAssessmentsService,
    MemberGoalsService,
    {
      provide: MemberDocumentsService,
      useClass: MemberDocumentsIntegrityService,
    },
    { provide: Member360Service, useClass: Member360IntegrityService },
    MemberDuplicateService,
    {
      provide: MemberFollowUpsService,
      useClass: MemberFollowUpsIntegrityService,
    },
    MemberTagsService,
    {
      provide: MemberCommunicationsService,
      useClass: MemberCommunicationsIntegrityService,
    },
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
