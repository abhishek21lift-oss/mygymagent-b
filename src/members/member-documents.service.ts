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
      include: { file: true },
    });
    return Promise.all(
      documents.map(async (doc) => ({
        id: doc.id,
        category: doc.category,
        description: doc.description,
        createdAt: doc.createdAt,
        originalName: doc.file.originalName,
        mimeType: doc.file.mimeType,
        sizeBytes: doc.file.sizeBytes,
        url: await this.storage.getSignedUrl(doc.file.key),
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
      return tx.memberDocument.create({
        data: {
          organizationId,
          memberId,
          fileId: fileRow.id,
          category: dto.category,
          description: dto.description,
        },
        include: { file: true },
      });
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
      include: { file: true },
    });
    if (!document) throw new NotFoundException('Document not found');

    // Delete the DB rows first: if the S3 delete below fails, we're left
    // with an orphaned object in storage (harmless, cleanable later) --
    // the alternative order risks a row that still claims to reference a
    // file that's already gone, which is a worse failure mode for readers.
    await this.prisma.memberDocument.delete({ where: { id: documentId } });
    await this.prisma.file.delete({ where: { id: document.fileId } });
    await this.storage.delete(document.file.key);
  }
}
