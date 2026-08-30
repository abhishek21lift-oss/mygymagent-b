import { Injectable } from '@nestjs/common';
import { MemberDetailsService } from '../members/member-details.service';
import { MembersService } from '../members/members.service';

@Injectable()
export class Client360Service {
  constructor(
    private readonly members: MembersService,
    private readonly details: MemberDetailsService,
  ) {}

  async getClient360(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    const member = await this.members.getOne(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const [addresses, emergencyContacts, notes, consents] = await Promise.all([
      this.details.listAddresses(organizationId, memberId, branchScope, assignmentScope),
      this.details.listEmergencyContacts(organizationId, memberId, branchScope, assignmentScope),
      this.details.listNotes(organizationId, memberId, branchScope, assignmentScope),
      this.details.listConsents(organizationId, memberId, branchScope, assignmentScope),
    ]);

    return {
      profile: member,
      membership: member.memberships[0] ?? null,
      memberships: member.memberships,
      details: { addresses, emergencyContacts, notes, consents },
      summary: {
        activeMembership: member.memberships[0]?.status ?? null,
        assignedTrainer: member.assignedTrainer,
        branch: member.primaryBranch,
        notesCount: notes.length,
        consentCount: consents.length,
      },
    };
  }
}
