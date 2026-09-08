import { NotFoundException } from '@nestjs/common';
import { MemberFollowUpsService } from './member-follow-ups.service';
import { MembersService } from './members.service';

describe('MemberFollowUpsService', () => {
  const mockPrisma = {
    memberFollowUp: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
  };
  const mockMembers = {
    getOne: jest.fn(),
  };
  const service = new MemberFollowUpsService(
    mockPrisma as any,
    mockMembers as unknown as MembersService,
  );

  beforeEach(() => jest.clearAllMocks());

  const orgId = 'org-a';
  const memberId = 'member-a';

  describe('list', () => {
    it('throws NotFoundException when member is not visible', async () => {
      mockMembers.getOne.mockRejectedValueOnce(new NotFoundException());
      await expect(
        service.list(orgId, memberId, null, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns follow-ups with isOverdue flag', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      const items = [
        {
          id: 'fu-1',
          memberId,
          organizationId: orgId,
          title: 'Check-in',
          dueAt: new Date('2020-01-01'),
          completedAt: null,
          createdAt: new Date(),
        },
      ];
      mockPrisma.memberFollowUp.findMany.mockResolvedValueOnce(items);

      const result = await service.list(orgId, memberId, null, null);
      expect(result[0].isOverdue).toBe(true);
    });
  });

  describe('create', () => {
    it('creates a follow-up for a visible member', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      const dto = { title: 'New follow-up', dueAt: new Date().toISOString() };
      mockPrisma.memberFollowUp.create.mockResolvedValueOnce({
        id: 'fu-new',
        ...dto,
        organizationId: orgId,
        memberId,
      });

      await service.create(orgId, memberId, dto, 'user-1', null, null);
      expect(mockPrisma.memberFollowUp.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: orgId,
            memberId,
            createdByUserId: 'user-1',
          }),
        }),
      );
    });
  });

  describe('complete', () => {
    it('throws NotFoundException when follow-up not found', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberFollowUp.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.complete(orgId, memberId, 'fu-bad', null, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('sets completedAt timestamp on complete', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberFollowUp.findFirst.mockResolvedValueOnce({
        id: 'fu-1',
        completedAt: null,
      });
      mockPrisma.memberFollowUp.update.mockResolvedValueOnce({
        id: 'fu-1',
        completedAt: new Date(),
      });

      await service.complete(orgId, memberId, 'fu-1', null, null);
      expect(mockPrisma.memberFollowUp.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'fu-1' },
          data: expect.objectContaining({ completedAt: expect.any(Date) }),
        }),
      );
    });
  });

  describe('delete', () => {
    it('throws NotFoundException when follow-up not found', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberFollowUp.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.delete(orgId, memberId, 'fu-bad', null, null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deletes the follow-up when found', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      mockPrisma.memberFollowUp.findFirst.mockResolvedValueOnce({ id: 'fu-1' });
      mockPrisma.memberFollowUp.delete.mockResolvedValueOnce({ id: 'fu-1' });

      await service.delete(orgId, memberId, 'fu-1', null, null);
      expect(mockPrisma.memberFollowUp.delete).toHaveBeenCalledWith({
        where: { id: 'fu-1' },
      });
    });
  });
});
