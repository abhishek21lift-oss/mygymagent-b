import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CreateMemberAddressDto,
  UpdateMemberAddressDto,
} from './dto/member-address.dto';
import { CreateMemberConsentDto } from './dto/member-consent.dto';
import {
  CreateMemberEmergencyContactDto,
  UpdateMemberEmergencyContactDto,
} from './dto/member-emergency-contact.dto';
import {
  CreateMemberNoteDto,
  UpdateMemberNoteDto,
} from './dto/member-note.dto';
import { MemberDetailsService } from './member-details.service';

/**
 * Member 360 sub-resources: addresses, emergency contacts, notes, consents.
 * Nested under /members/:memberId/... and gated by the same
 * members.read[_assigned]/members.update permissions as the parent Member
 * -- see MemberDetailsService for how every method re-checks member
 * visibility (tenant/branch/assignment scoping) before touching a
 * sub-resource.
 */
@Controller('members/:memberId')
export class MemberDetailsController {
  constructor(private readonly details: MemberDetailsService) {}

  // -- Addresses --------------------------------------------------------------

  @Get('addresses')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  listAddresses(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.listAddresses(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('addresses')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_address', action: 'create' })
  createAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberAddressDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.createAddress(
      user.organizationId!,
      memberId,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Patch('addresses/:addressId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_address', action: 'update' })
  updateAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('addressId') addressId: string,
    @Body() dto: UpdateMemberAddressDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.updateAddress(
      user.organizationId!,
      memberId,
      addressId,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Delete('addresses/:addressId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_address', action: 'delete' })
  removeAddress(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('addressId') addressId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.removeAddress(
      user.organizationId!,
      memberId,
      addressId,
      branchScope,
      assignmentScope,
    );
  }

  // -- Emergency contacts -------------------------------------------------------

  @Get('emergency-contacts')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  listEmergencyContacts(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.listEmergencyContacts(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('emergency-contacts')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_emergency_contact', action: 'create' })
  createEmergencyContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberEmergencyContactDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.createEmergencyContact(
      user.organizationId!,
      memberId,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Patch('emergency-contacts/:contactId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_emergency_contact', action: 'update' })
  updateEmergencyContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('contactId') contactId: string,
    @Body() dto: UpdateMemberEmergencyContactDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.updateEmergencyContact(
      user.organizationId!,
      memberId,
      contactId,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Delete('emergency-contacts/:contactId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_emergency_contact', action: 'delete' })
  removeEmergencyContact(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('contactId') contactId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.removeEmergencyContact(
      user.organizationId!,
      memberId,
      contactId,
      branchScope,
      assignmentScope,
    );
  }

  // -- Notes --------------------------------------------------------------------

  @Get('notes')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  listNotes(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.listNotes(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('notes')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_note', action: 'create' })
  createNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberNoteDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.createNote(
      user.organizationId!,
      memberId,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Patch('notes/:noteId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_note', action: 'update' })
  updateNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('noteId') noteId: string,
    @Body() dto: UpdateMemberNoteDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.updateNote(
      user.organizationId!,
      memberId,
      noteId,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
  }

  @Delete('notes/:noteId')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_note', action: 'delete' })
  removeNote(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Param('noteId') noteId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.removeNote(
      user.organizationId!,
      memberId,
      noteId,
      user.id,
      branchScope,
      assignmentScope,
    );
  }

  // -- Consents (append-only) ----------------------------------------------------

  @Get('consents')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  listConsents(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.listConsents(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('consents')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_consent', action: 'record' })
  recordConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: CreateMemberConsentDto,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.details.recordConsent(
      user.organizationId!,
      memberId,
      user.id,
      dto,
      branchScope,
      assignmentScope,
    );
  }
}
