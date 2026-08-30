import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateMemberDocumentDto } from './dto/member-document.dto';
import {
  MAX_DOCUMENT_SIZE_BYTES,
  MemberDocumentsService,
  type UploadedFileInput,
} from './member-documents.service';

/**
 * Member 360's Documents/Progress Photos sub-resource -- see the schema
 * comment above `File`/`MemberDocument` for why "progress photo" is just
 * category=PROGRESS_PHOTO on the same table, not a separate one. Gated
 * the same way as the rest of Member 360 (members.read[_assigned]/
 * members.update), not new files.* permissions -- see
 * src/files/README.md.
 */
@Controller('members/:memberId/documents')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MemberDocumentsController {
  constructor(private readonly documents: MemberDocumentsService) {}

  @Get()
  @RequireAnyPermission('members.read', 'members.read_assigned')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.documents.list(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post()
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_document', action: 'upload' })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_DOCUMENT_SIZE_BYTES } }),
  )
  upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberDocumentDto,
    @UploadedFile() file: UploadedFileInput,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.documents.upload(
      user.organizationId!,
      memberId,
      user.id,
      dto,
      file,
      branchScope,
      assignmentScope,
    );
  }

  @Delete(':documentId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_document', action: 'delete' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('documentId') documentId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.documents.remove(
      user.organizationId!,
      memberId,
      documentId,
      branchScope,
      assignmentScope,
    );
  }
}
