import { BadRequestException, Injectable } from '@nestjs/common';
import { MemberDocumentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';
import { MemberDocumentsService } from './member-documents.service';
import { FileStorageService } from '../files/file-storage.service';
import type { ReviewDocumentDto } from './dto/document-versioning.dto';

@Injectable()
export class MemberDocumentsIntegrityService extends MemberDocumentsService {
  constructor(
    private readonly integrityPrisma: PrismaService,
    members: MembersService,
    storage: FileStorageService,
  ) {
    super(integrityPrisma, members, storage);
  }

  override async review(
    organizationId: string,
    memberId: string,
    documentId: string,
    dto: ReviewDocumentDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    if (dto.reviewedByUserId) {
      const reviewer = await this.integrityPrisma.user.findFirst({
        where: {
          id: dto.reviewedByUserId,
          organizationId,
          deletedAt: null,
          ...(branchScope ? { primaryBranchId: branchScope } : {}),
        },
        select: { id: true },
      });
      if (!reviewer) {
        throw new BadRequestException(
          'Reviewer does not belong to the permitted organization or branch',
        );
      }
    }
    return super.review(
      organizationId,
      memberId,
      documentId,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  override async uploadVersion(
    organizationId: string,
    memberId: string,
    documentId: string,
    uploadedByUserId: string,
    dto: { changeNotes?: string },
    file: Parameters<MemberDocumentsService['uploadVersion']>[6],
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    const document = await this.integrityPrisma.memberDocument.findFirst({
      where: { id: documentId, organizationId, memberId },
      select: { status: true },
    });
    if (!document) {
      return super.uploadVersion(
        organizationId,
        memberId,
        documentId,
        uploadedByUserId,
        dto,
        file,
        branchScope,
        assignmentScope,
      );
    }
    if (document.status === MemberDocumentStatus.SUBMITTED) {
      throw new BadRequestException(
        'A submitted document must be reviewed before a new version can be uploaded',
      );
    }
    return super.uploadVersion(
      organizationId,
      memberId,
      documentId,
      uploadedByUserId,
      dto,
      file,
      branchScope,
      assignmentScope,
    );
  }
}
