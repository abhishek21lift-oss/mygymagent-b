import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FileStorageService } from '../files/file-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMemberDocumentDto } from './dto/member-document.dto';
import { MembersService } from './members.service';

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface UploadedFileInput {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

@Injectable()
export class MemberDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
    private readonly storage: FileStorageService,
  ) {}

  private async assertMemberVisible(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<void> {
    await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  async list(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const documents = await this.prisma.memberDocument.findMany({
      where: { organizationId, memberId },
      orderBy: { createdAt: 'desc' },
      include: {
        file: true,
        reviewedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
        versions: {
          orderBy: { version: 'asc' },
          include: { file: true },
        },
      },
    });
    return Promise.all(
      documents.map(async (doc) => ({
        id: doc.id,
        category: doc.category,
        description: doc.description,
        status: doc.status,
        submittedAt: doc.submittedAt,
        reviewedAt: doc.reviewedAt,
        rejectionReason: doc.rejectionReason,
        createdAt: doc.createdAt,
        currentVersion: doc.currentVersion,
        reviewedBy: doc.reviewedByUser,
        originalName: doc.file.originalName,
        mimeType: doc.file.mimeType,
        sizeBytes: doc.file.sizeBytes,
        url: await this.storage.getSignedUrl(doc.file.key),
        versions: doc.versions.map((v) => ({
          id: v.id,
          version: v.version,
          changeNotes: v.changeNotes,
          originalName: v.file.originalName,
          mimeType: v.file.mimeType,
          sizeBytes: v.file.sizeBytes,
          createdAt: v.createdAt,
        })),
      })),
    );
  }

  async upload(
    organizationId: string,
    memberId: string,
    uploadedByUserId: string,
    dto: CreateMemberDocumentDto,
    file: UploadedFileInput,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    if (!file) {
      throw new BadRequestException('No file was uploaded.');
    }
    if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(file.mimetype as never)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed: ${ALLOWED_DOCUMENT_MIME_TYPES.join(', ')}`,
      );
    }
    if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
      throw new BadRequestException(
        `File is too large (max ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB).`,
      );
    }

    const uploaded = await this.storage.upload({
      organizationId,
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      pathPrefix: 'member-documents',
    });

    return this.prisma.$transaction(async (tx) => {
      const fileRow = await tx.file.create({
        data: {
          organizationId,
          key: uploaded.key,
          originalName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: uploaded.sizeBytes,
          purpose: 'MEMBER_DOCUMENT',
          uploadedByUserId,
        },
      });
      const document = await tx.memberDocument.create({
        data: {
          organizationId,
          memberId,
          fileId: fileRow.id,
          category: dto.category,
          description: dto.description,
        },
        include: { file: true },
      });
      await tx.memberDocumentVersion.create({
        data: {
          organizationId,
          documentId: document.id,
          version: 1,
          fileId: fileRow.id,
          createdByUserId: uploadedByUserId,
        },
      });
      return document;
    });
  }

  async remove(
    organizationId: string,
    memberId: string,
    documentId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ): Promise<void> {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const document = await this.prisma.memberDocument.findFirst({
      where: { id: documentId, organizationId, memberId },
      include: { file: true, versions: { include: { file: true } } },
    });
    if (!document) throw new NotFoundException('Document not found');

    // Delete the DB rows first: if the S3 delete below fails, we're left
    // with an orphaned object in storage (harmless, cleanable later) --
    // the alternative order risks a row that still claims to reference a
    // file that's already gone, which is a worse failure mode for readers.
    const fileIds = [
      document.fileId,
      ...document.versions.map((v) => v.fileId),
    ];
    const keys = [
      document.file.key,
      ...document.versions.map((v) => v.file.key),
    ];
    await this.prisma.memberDocument.delete({ where: { id: documentId } });
    await this.prisma.file.deleteMany({ where: { id: { in: fileIds } } });
    for (const key of [...new Set(keys)]) {
      await this.storage.delete(key);
    }
  }

  /**
   * DRAFT/REJECTED -> SUBMITTED. Re-submission after a rejection is the
   * normal correction path (a rejected document is never edited in
   * place -- the member uploads a new version, which resets to DRAFT,
   * then submits again).
   */
  async submit(
    organizationId: string,
    memberId: string,
    documentId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const document = await this.prisma.memberDocument.findFirst({
      where: { id: documentId, organizationId, memberId },
    });
    if (!document) throw new NotFoundException('Document not found');
    if (document.status !== 'DRAFT' && document.status !== 'REJECTED')
      throw new BadRequestException(
        'Only draft or rejected documents can be submitted for review',
      );
    return this.prisma.memberDocument.update({
      where: { id: documentId },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });
  }

  /**
   * SUBMITTED -> APPROVED (or back to REJECTED with a required reason).
   * Review is staff-only at the route layer (members.update).
   */
  async review(
    organizationId: string,
    memberId: string,
    documentId: string,
    dto: { action: 'approve' | 'reject'; rejectionReason?: string },
    reviewedByUserId: string,
    branchScope: string | null,
  ) {
    await this.assertMemberVisible(organizationId, memberId, branchScope, null);
    const document = await this.prisma.memberDocument.findFirst({
      where: { id: documentId, organizationId, memberId },
    });
    if (!document) throw new NotFoundException('Document not found');
    if (document.status !== 'SUBMITTED')
      throw new BadRequestException('Only submitted documents can be reviewed');
    if (dto.action === 'reject' && !dto.rejectionReason?.trim())
      throw new BadRequestException(
        'A rejection reason is required to reject a document',
      );
    return this.prisma.memberDocument.update({
      where: { id: documentId },
      data:
        dto.action === 'approve'
          ? {
              status: 'APPROVED',
              reviewedAt: new Date(),
              reviewedByUserId,
              rejectionReason: null,
            }
          : {
              status: 'REJECTED',
              reviewedAt: new Date(),
              reviewedByUserId,
              rejectionReason: dto.rejectionReason!.trim(),
            },
    });
  }

  /**
   * Upload a new file version. The document's current file pointer moves
   * to the new file and the row resets to DRAFT (unreviewed files never
   * read as approved), preserving the full version history.
   */
  async uploadVersion(
    organizationId: string,
    memberId: string,
    documentId: string,
    uploadedByUserId: string,
    file: UploadedFileInput,
    changeNotes: string | undefined,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const document = await this.prisma.memberDocument.findFirst({
      where: { id: documentId, organizationId, memberId },
    });
    if (!document) throw new NotFoundException('Document not found');

    if (!file) {
      throw new BadRequestException('No file was uploaded.');
    }
    if (!ALLOWED_DOCUMENT_MIME_TYPES.includes(file.mimetype as never)) {
      throw new BadRequestException(
        `Unsupported file type "${file.mimetype}". Allowed: ${ALLOWED_DOCUMENT_MIME_TYPES.join(', ')}`,
      );
    }
    if (file.size > MAX_DOCUMENT_SIZE_BYTES) {
      throw new BadRequestException(
        `File is too large (max ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB).`,
      );
    }

    const uploaded = await this.storage.upload({
      organizationId,
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      pathPrefix: 'member-documents',
    });

    return this.prisma.$transaction(async (tx) => {
      const fileRow = await tx.file.create({
        data: {
          organizationId,
          key: uploaded.key,
          originalName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes: uploaded.sizeBytes,
          purpose: 'MEMBER_DOCUMENT',
          uploadedByUserId,
        },
      });
      const nextVersion = document.currentVersion + 1;
      await tx.memberDocumentVersion.create({
        data: {
          organizationId,
          documentId,
          version: nextVersion,
          fileId: fileRow.id,
          changeNotes,
          createdByUserId: uploadedByUserId,
        },
      });
      return tx.memberDocument.update({
        where: { id: documentId },
        data: {
          fileId: fileRow.id,
          currentVersion: nextVersion,
          status: 'DRAFT',
          submittedAt: null,
          reviewedAt: null,
          reviewedByUserId: null,
          rejectionReason: null,
        },
        include: { file: true },
      });
    });
  }
}
