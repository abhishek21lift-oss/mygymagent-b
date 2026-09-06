import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FileStorageService } from '../files/file-storage.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateMemberDocumentDto } from './dto/member-document.dto';
import type {
  ReviewDocumentDto,
  SubmitDocumentDto,
} from './dto/document-versioning.dto';
import { MembersService } from './members.service';
import { MemberDocumentStatus } from '@prisma/client';

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
        versions: {
          include: { file: true },
          orderBy: { version: 'desc' },
        },
        reviewedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
    return Promise.all(
      documents.map(async (doc) => {
        const latestVersion = doc.versions[0];
        return {
          id: doc.id,
          category: doc.category,
          description: doc.description,
          status: doc.status,
          submittedAt: doc.submittedAt,
          reviewedAt: doc.reviewedAt,
          rejectionReason: doc.rejectionReason,
          createdAt: doc.createdAt,
          currentVersion: latestVersion?.version ?? 1,
          reviewedBy: doc.reviewedByUser,
          originalName: latestVersion?.file.originalName,
          mimeType: latestVersion?.file.mimeType,
          sizeBytes: latestVersion?.file.sizeBytes,
          url: latestVersion
            ? await this.storage.getSignedUrl(latestVersion.file.key)
            : null,
          versions: doc.versions.map((v) => ({
            id: v.id,
            version: v.version,
            changeNotes: v.changeNotes,
            originalName: v.file.originalName,
            mimeType: v.file.mimeType,
            sizeBytes: v.file.sizeBytes,
            createdAt: v.createdAt,
          })),
        };
      }),
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
      const doc = await tx.memberDocument.create({
        data: {
          organizationId,
          memberId,
          category: dto.category,
          description: dto.description,
          status: MemberDocumentStatus.DRAFT,
        },
      });
      await tx.memberDocumentVersion.create({
        data: {
          organizationId,
          documentId: doc.id,
          fileId: fileRow.id,
          version: 1,
        },
      });
      return tx.memberDocument.findUnique({
        where: { id: doc.id },
        include: {
          versions: { include: { file: true }, orderBy: { version: 'desc' } },
          reviewedByUser: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      });
    });
  }

  async submit(
    organizationId: string,
    memberId: string,
    documentId: string,
    dto: SubmitDocumentDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const doc = await this.prisma.memberDocument.findFirst({
      where: { id: documentId, organizationId, memberId },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (
      doc.status !== MemberDocumentStatus.DRAFT &&
      doc.status !== MemberDocumentStatus.REJECTED
    ) {
      throw new BadRequestException(
        'Only draft or rejected documents can be submitted',
      );
    }
    return this.prisma.memberDocument.update({
      where: { id: documentId },
      data: { status: MemberDocumentStatus.SUBMITTED, submittedAt: new Date() },
      include: {
        versions: { include: { file: true }, orderBy: { version: 'desc' } },
        reviewedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async review(
    organizationId: string,
    memberId: string,
    documentId: string,
    dto: ReviewDocumentDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const doc = await this.prisma.memberDocument.findFirst({
      where: { id: documentId, organizationId, memberId },
    });
    if (!doc) throw new NotFoundException('Document not found');
    if (doc.status !== MemberDocumentStatus.SUBMITTED) {
      throw new BadRequestException('Only submitted documents can be reviewed');
    }
    const status =
      dto.action === 'approve'
        ? MemberDocumentStatus.APPROVED
        : MemberDocumentStatus.REJECTED;
    return this.prisma.memberDocument.update({
      where: { id: documentId },
      data: {
        status,
        reviewedAt: new Date(),
        reviewedByUserId: dto.reviewedByUserId,
        ...(dto.action === 'reject' && dto.rejectionReason
          ? { rejectionReason: dto.rejectionReason }
          : {}),
      },
      include: {
        versions: { include: { file: true }, orderBy: { version: 'desc' } },
        reviewedByUser: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });
  }

  async uploadVersion(
    organizationId: string,
    memberId: string,
    documentId: string,
    uploadedByUserId: string,
    dto: { changeNotes?: string },
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
    const doc = await this.prisma.memberDocument.findFirst({
      where: { id: documentId, organizationId, memberId },
    });
    if (!doc) throw new NotFoundException('Document not found');

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

    return this.prisma.$transaction(async (tx) => {
      const lastVersion = await tx.memberDocumentVersion.findFirst({
        where: { documentId },
        orderBy: { version: 'desc' },
      });
      const nextVersion = (lastVersion?.version ?? 0) + 1;

      const uploaded = await this.storage.upload({
        organizationId,
        buffer: file.buffer,
        originalName: file.originalname,
        mimeType: file.mimetype,
        pathPrefix: 'member-documents',
      });

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

      await tx.memberDocumentVersion.create({
        data: {
          organizationId,
          documentId,
          fileId: fileRow.id,
          version: nextVersion,
          changeNotes: dto.changeNotes,
        },
      });

      return tx.memberDocument.update({
        where: { id: documentId },
        data: { status: MemberDocumentStatus.DRAFT },
        include: {
          versions: { include: { file: true }, orderBy: { version: 'desc' } },
          reviewedByUser: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      });
    });
  }

  async getVersionHistory(
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
    const doc = await this.prisma.memberDocument.findFirst({
      where: { id: documentId, organizationId, memberId },
    });
    if (!doc) throw new NotFoundException('Document not found');
    return this.prisma.memberDocumentVersion.findMany({
      where: { documentId },
      include: { file: true },
      orderBy: { version: 'desc' },
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
      include: { versions: { include: { file: true } } },
    });
    if (!document) throw new NotFoundException('Document not found');

    // Delete all version files from storage
    await Promise.all(
      document.versions.map((v) => this.storage.delete(v.file.key)),
    );
    // Cascade will handle DB rows
    await this.prisma.memberDocument.delete({ where: { id: documentId } });
  }
}
