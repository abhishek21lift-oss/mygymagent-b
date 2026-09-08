import { BadRequestException } from '@nestjs/common';
import { MemberCommunicationsService } from './member-communications.service';
import { CommunicationsService } from '../communications/communications.service';
import { MembersService } from './members.service';

describe('MemberCommunicationsService', () => {
  const mockPrisma = {
    messageLog: {
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  } as any;
  const mockCommunications = { send: jest.fn() };
  const mockMembers = { getOne: jest.fn() };
  const service = new MemberCommunicationsService(
    mockMembers as unknown as MembersService,
    mockCommunications as unknown as CommunicationsService,
    mockPrisma,
  );

  beforeEach(() => jest.clearAllMocks());

  const orgId = 'org-a';
  const memberId = 'member-a';

  describe('list', () => {
    it('throws NotFoundException when member not visible', async () => {
      mockMembers.getOne.mockRejectedValueOnce(new Error('not found'));
      await expect(service.list(orgId, memberId, null, null)).rejects.toThrow(
        'not found',
      );
    });

    it('returns message logs for visible member', async () => {
      mockMembers.getOne.mockResolvedValueOnce({ id: memberId });
      const logs = [{ id: 'log-1', channel: 'EMAIL', status: 'SENT' }];
      mockPrisma.messageLog.findMany.mockResolvedValueOnce(logs);

      const result = await service.list(orgId, memberId, null, null);
      expect(result).toEqual(logs);
      expect(mockPrisma.messageLog.findMany).toHaveBeenCalledWith({
        where: { memberId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
    });
  });

  describe('send', () => {
    it('throws BadRequestException when member has no email for EMAIL channel', async () => {
      mockMembers.getOne.mockResolvedValueOnce({
        id: memberId,
        email: null,
        phone: '123',
      });

      await expect(
        service.send(
          orgId,
          memberId,
          { channel: 'EMAIL', customBody: 'Hello' },
          null,
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequestException when member has no phone for WHATSAPP channel', async () => {
      mockMembers.getOne.mockResolvedValueOnce({
        id: memberId,
        email: 'a@b.com',
        phone: null,
      });

      await expect(
        service.send(
          orgId,
          memberId,
          { channel: 'WHATSAPP', customBody: 'Hello' },
          null,
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('calls communications.send with template when templateKey is provided', async () => {
      mockMembers.getOne.mockResolvedValueOnce({
        id: memberId,
        email: 'a@b.com',
      });
      mockCommunications.send.mockResolvedValueOnce({ id: 'log-1' });

      await service.send(
        orgId,
        memberId,
        { channel: 'EMAIL', templateKey: 'welcome' },
        null,
        null,
      );

      expect(mockCommunications.send).toHaveBeenCalledWith({
        organizationId: orgId,
        channel: 'EMAIL',
        category: 'TRANSACTIONAL',
        templateKey: 'welcome',
        recipient: 'a@b.com',
        memberId,
        variables: undefined,
      });
    });

    it('calls communications.send with customBody when customBody is provided', async () => {
      mockMembers.getOne.mockResolvedValueOnce({
        id: memberId,
        email: 'a@b.com',
      });
      mockCommunications.send.mockResolvedValueOnce({ id: 'log-1' });

      await service.send(
        orgId,
        memberId,
        {
          channel: 'EMAIL',
          customBody: 'Hello World',
          customSubject: 'Subject',
        },
        null,
        null,
      );

      expect(mockCommunications.send).toHaveBeenCalledWith({
        organizationId: orgId,
        channel: 'EMAIL',
        category: 'TRANSACTIONAL',
        templateKey: 'custom',
        recipient: 'a@b.com',
        memberId,
        customBody: 'Hello World',
        customSubject: 'Subject',
      });
    });

    it('throws BadRequestException when neither templateKey nor customBody is provided', async () => {
      mockMembers.getOne.mockResolvedValueOnce({
        id: memberId,
        email: 'a@b.com',
      });

      await expect(
        service.send(orgId, memberId, { channel: 'EMAIL' } as any, null, null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
