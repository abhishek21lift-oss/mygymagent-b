import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MemberDocumentStatus } from '@prisma/client';
import { MemberDocumentsService } from './member-documents.service';
import { MembersService } from './members.service';

describe('MemberDocumentsService versioning', () => {
  const mockPrisma = {
    memberDocument: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    memberDocumentVersion: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    file: { create: jest.fn() },
  } as any;
  const mockStorage = {
    upload: jest.fn().mockResolvedValue({ key: 'key-a', sizeBytes: 1024 }),
  } as any;
  const mockMembers = { getOne: jest.fn() };
  const service = new MemberDocumentsService(
    mockPrisma,
    mockMembers as unknown as MembersService,
    mockStorage,
  );

  beforeEach(() => jest.clearAllMocks());

  const orgId = 'org-a';
  const memberId = 'member-a';

  describe('submit', () => {
    it('throws NotFoundException when member not visible', async () => {
      mockMembers.getOne.mockRejectedValueOnce(new NotFoundException());
      await expect(
        service.submit(orgId, memberId, 'doc-1', {}, null, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when document not found', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberDocument.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.submit(orgId, memberId, 'doc-bad', {}, null, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequestException when document is not DRAFT or REJECTED', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberDocument.findFirst.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.SUBMITTED,
      });
      await expect(
        service.submit(orgId, memberId, 'doc-1', {}, null, null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('updates status to SUBMITTED for DRAFT document', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberDocument.findFirst.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.DRAFT,
      });
      mockPrisma.memberDocument.update.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.SUBMITTED,
      });

      await service.submit(orgId, memberId, 'doc-1', {}, null, null);
      expect(mockPrisma.memberDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MemberDocumentStatus.SUBMITTED,
          }),
        }),
      );
    });

    it('updates status to SUBMITTED for REJECTED document', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberDocument.findFirst.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.REJECTED,
      });
      mockPrisma.memberDocument.update.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.SUBMITTED,
      });

      await service.submit(orgId, memberId, 'doc-1', {}, null, null);
      expect(mockPrisma.memberDocument.update).toHaveBeenCalled();
    });
  });

  describe('review', () => {
    it('throws BadRequestException when document is not SUBMITTED', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberDocument.findFirst.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.DRAFT,
      });

      await expect(
        service.review(
          orgId,
          memberId,
          'doc-1',
          { action: 'approve' },
          null,
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('approves a submitted document', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberDocument.findFirst.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.SUBMITTED,
      });
      mockPrisma.memberDocument.update.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.APPROVED,
      });

      await service.review(
        orgId,
        memberId,
        'doc-1',
        { action: 'approve', reviewedByUserId: 'user-1' },
        null,
        null,
      );
      expect(mockPrisma.memberDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MemberDocumentStatus.APPROVED,
            reviewedByUserId: 'user-1',
          }),
        }),
      );
    });

    it('rejects a submitted document with reason', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberDocument.findFirst.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.SUBMITTED,
      });
      mockPrisma.memberDocument.update.mockResolvedValueOnce({
        id: 'doc-1',
        status: MemberDocumentStatus.REJECTED,
      });

      await service.review(
        orgId,
        memberId,
        'doc-1',
        {
          action: 'reject',
          reviewedByUserId: 'user-1',
          rejectionReason: 'Illegible',
        },
        null,
        null,
      );
      expect(mockPrisma.memberDocument.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: MemberDocumentStatus.REJECTED,
            rejectionReason: 'Illegible',
          }),
        }),
      );
    });
  });

  describe('getVersionHistory', () => {
    it('throws NotFoundException when member not visible', async () => {
      mockMembers.getOne.mockRejectedValueOnce(new NotFoundException());
      await expect(
        service.getVersionHistory(orgId, memberId, 'doc-1', null, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns versions ordered by version desc', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberDocument.findFirst.mockResolvedValueOnce({
        id: 'doc-1',
      });
      const versions = [
        { id: 'v-2', version: 2, changeNotes: 'Final' },
        { id: 'v-1', version: 1, changeNotes: 'Initial' },
      ];
      mockPrisma.memberDocumentVersion.findMany.mockResolvedValueOnce(versions);

      const result = await service.getVersionHistory(
        orgId,
        memberId,
        'doc-1',
        null,
        null,
      );
      expect(result).toEqual(versions);
    });
  });
});
