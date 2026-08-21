import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreateMemberAddressDto,
  UpdateMemberAddressDto,
} from './dto/member-address.dto';
import type { CreateMemberConsentDto } from './dto/member-consent.dto';
import type {
  CreateMemberEmergencyContactDto,
  UpdateMemberEmergencyContactDto,
} from './dto/member-emergency-contact.dto';
import type {
  CreateMemberNoteDto,
  UpdateMemberNoteDto,
} from './dto/member-note.dto';
import { MembersService } from './members.service';

/**
 * CRUD for the Member 360 collection sub-resources (addresses, emergency
 * contacts, notes, consents) -- the parts of docs/architecture/discovery-
 * report.md §6's gap list that are plain collections, not history derived
 * from MembersService's own mutations (see MembersService for
 * status/branch/trainer history, written automatically on update()).
 *
 * Every method re-uses MembersService.getOne() as the single source of
 * truth for "can this caller see this member" (tenant/branch/assignment
 * scoping) before touching a sub-resource -- these tables are never
 * queried by id alone.
 */
@Injectable()
export class MemberDetailsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
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

  // -- Addresses ------------------------------------------------------------

  async listAddresses(
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
    return this.prisma.memberAddress.findMany({
      where: { organizationId, memberId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createAddress(
    organizationId: string,
    memberId: string,
    dto: CreateMemberAddressDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.memberAddress.updateMany({
          where: { organizationId, memberId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      return tx.memberAddress.create({
        data: { ...dto, organizationId, memberId },
      });
    });
  }

  async updateAddress(
    organizationId: string,
    memberId: string,
    addressId: string,
    dto: UpdateMemberAddressDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    await this.findAddressOrThrow(organizationId, memberId, addressId);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.memberAddress.updateMany({
          where: {
            organizationId,
            memberId,
            isPrimary: true,
            id: { not: addressId },
          },
          data: { isPrimary: false },
        });
      }
      return tx.memberAddress.update({ where: { id: addressId }, data: dto });
    });
  }

  async removeAddress(
    organizationId: string,
    memberId: string,
    addressId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    await this.findAddressOrThrow(organizationId, memberId, addressId);
    await this.prisma.memberAddress.delete({ where: { id: addressId } });
  }

  private async findAddressOrThrow(
    organizationId: string,
    memberId: string,
    addressId: string,
  ) {
    const address = await this.prisma.memberAddress.findFirst({
      where: { id: addressId, organizationId, memberId },
    });
    if (!address) throw new NotFoundException('Address not found');
    return address;
  }

  // -- Emergency contacts -----------------------------------------------------

  async listEmergencyContacts(
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
    return this.prisma.memberEmergencyContact.findMany({
      where: { organizationId, memberId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async createEmergencyContact(
    organizationId: string,
    memberId: string,
    dto: CreateMemberEmergencyContactDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.memberEmergencyContact.updateMany({
          where: { organizationId, memberId, isPrimary: true },
          data: { isPrimary: false },
        });
      }
      return tx.memberEmergencyContact.create({
        data: { ...dto, organizationId, memberId },
      });
    });
  }

  async updateEmergencyContact(
    organizationId: string,
    memberId: string,
    contactId: string,
    dto: UpdateMemberEmergencyContactDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    await this.findEmergencyContactOrThrow(organizationId, memberId, contactId);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isPrimary) {
        await tx.memberEmergencyContact.updateMany({
          where: {
            organizationId,
            memberId,
            isPrimary: true,
            id: { not: contactId },
          },
          data: { isPrimary: false },
        });
      }
      return tx.memberEmergencyContact.update({
        where: { id: contactId },
        data: dto,
      });
    });
  }

  async removeEmergencyContact(
    organizationId: string,
    memberId: string,
    contactId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    await this.findEmergencyContactOrThrow(organizationId, memberId, contactId);
    await this.prisma.memberEmergencyContact.delete({
      where: { id: contactId },
    });
  }

  private async findEmergencyContactOrThrow(
    organizationId: string,
    memberId: string,
    contactId: string,
  ) {
    const contact = await this.prisma.memberEmergencyContact.findFirst({
      where: { id: contactId, organizationId, memberId },
    });
    if (!contact) throw new NotFoundException('Emergency contact not found');
    return contact;
  }

  // -- Notes ------------------------------------------------------------------

  async listNotes(
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
    return this.prisma.memberNote.findMany({
      where: { organizationId, memberId },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
      include: {
        authorUser: { select: { id: true, firstName: true, lastName: true } },
      },
    });
  }

  async createNote(
    organizationId: string,
    memberId: string,
    authorUserId: string,
    dto: CreateMemberNoteDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.prisma.memberNote.create({
      data: { ...dto, organizationId, memberId, authorUserId },
    });
  }

  async updateNote(
    organizationId: string,
    memberId: string,
    noteId: string,
    callerUserId: string,
    dto: UpdateMemberNoteDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const note = await this.prisma.memberNote.findFirst({
      where: { id: noteId, organizationId, memberId },
    });
    if (!note) throw new NotFoundException('Note not found');
    if (note.authorUserId && note.authorUserId !== callerUserId) {
      throw new ForbiddenException('Only the author can edit this note');
    }
    return this.prisma.memberNote.update({ where: { id: noteId }, data: dto });
  }

  async removeNote(
    organizationId: string,
    memberId: string,
    noteId: string,
    callerUserId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    const note = await this.prisma.memberNote.findFirst({
      where: { id: noteId, organizationId, memberId },
    });
    if (!note) throw new NotFoundException('Note not found');
    if (note.authorUserId && note.authorUserId !== callerUserId) {
      throw new ForbiddenException('Only the author can delete this note');
    }
    await this.prisma.memberNote.delete({ where: { id: noteId } });
  }

  // -- Consents (append-only -- no update/delete) ------------------------------

  async listConsents(
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
    return this.prisma.memberConsent.findMany({
      where: { organizationId, memberId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async recordConsent(
    organizationId: string,
    memberId: string,
    recordedByUserId: string,
    dto: CreateMemberConsentDto,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    await this.assertMemberVisible(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );
    return this.prisma.memberConsent.create({
      data: { ...dto, organizationId, memberId, recordedByUserId },
    });
  }
}
