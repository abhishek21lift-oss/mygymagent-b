import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MemberTagsService } from './member-tags.service';
import { MembersService } from './members.service';

describe('MemberTagsService', () => {
  const mockPrisma = {
    memberTag: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    memberTagAssignment: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
  };
  const mockMembers = { getOne: jest.fn() };
  const service = new MemberTagsService(
    mockPrisma as any,
    mockMembers as unknown as MembersService,
  );

  beforeEach(() => jest.clearAllMocks());

  const orgId = 'org-a';

  describe('listTags', () => {
    it('returns all tags for the org', async () => {
      const tags = [{ id: 'tag-1', name: 'VIP', color: '#ff0000' }];
      mockPrisma.memberTag.findMany.mockResolvedValueOnce(tags);

      const result = await service.listTags(orgId);
      expect(result).toEqual(tags);
      expect(mockPrisma.memberTag.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: orgId },
        }),
      );
    });
  });

  describe('createTag', () => {
    it('throws BadRequestException when tag name already exists', async () => {
      mockPrisma.memberTag.findFirst.mockResolvedValueOnce({
        id: 'tag-existing',
      });

      await expect(
        service.createTag(orgId, { name: 'VIP' }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a new tag with default color', async () => {
      mockPrisma.memberTag.findFirst.mockResolvedValueOnce(null);
      mockPrisma.memberTag.create.mockResolvedValueOnce({
        id: 'tag-new',
        name: 'VIP',
        color: '#6366f1',
      });

      const result = await service.createTag(orgId, { name: 'VIP' }, null);
      expect(result.color).toBe('#6366f1');
    });
  });

  describe('assignTags', () => {
    it('throws NotFoundException when member not visible', async () => {
      mockMembers.getOne.mockRejectedValueOnce(new NotFoundException());

      await expect(
        service.assignTags(
          orgId,
          'member-bad',
          { tagIds: ['tag-1'] },
          null,
          null,
          null,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deletes existing and creates new assignments', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: 'member-a' });
      mockPrisma.memberTag.findMany.mockResolvedValueOnce([
        { id: 'tag-1' },
        { id: 'tag-2' },
      ]);
      mockPrisma.memberTagAssignment.deleteMany.mockResolvedValueOnce({
        count: 2,
      });
      mockPrisma.memberTagAssignment.createMany.mockResolvedValueOnce({
        count: 2,
      });

      await service.assignTags(
        orgId,
        'member-a',
        { tagIds: ['tag-1', 'tag-2'] },
        null,
        null,
        null,
      );
      expect(mockPrisma.memberTagAssignment.deleteMany).toHaveBeenCalledWith({
        where: { organizationId: orgId, memberId: 'member-a' },
      });
      expect(mockPrisma.memberTagAssignment.createMany).toHaveBeenCalled();
    });

    it('throws BadRequestException when any tag not found', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: 'member-a' });
      mockPrisma.memberTag.findMany.mockResolvedValueOnce([{ id: 'tag-1' }]);

      await expect(
        service.assignTags(
          orgId,
          'member-a',
          { tagIds: ['tag-1', 'tag-bad'] },
          null,
          null,
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('deleteTag', () => {
    it('throws NotFoundException when tag not found', async () => {
      mockPrisma.memberTag.findFirst.mockResolvedValueOnce(null);

      await expect(service.deleteTag(orgId, 'tag-bad')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('deletes the tag when found', async () => {
      mockPrisma.memberTag.findFirst.mockResolvedValueOnce({ id: 'tag-1' });
      mockPrisma.memberTag.delete.mockResolvedValueOnce({ id: 'tag-1' });

      await service.deleteTag(orgId, 'tag-1');
      expect(mockPrisma.memberTag.delete).toHaveBeenCalledWith({
        where: { id: 'tag-1' },
      });
    });
  });
});
