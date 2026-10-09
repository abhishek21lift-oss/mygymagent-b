/* eslint-disable prettier/prettier */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { BusinessOsService } from './business-os.service';
import {
  AddTicketMessageDto,
  AdjustLoyaltyDto,
  ConvertReferralDto,
  CreateAccountingAccountDto,
  CreateCampaignDto,
  CreateSupportTicketDto,
  CreateSurveyDto,
  PostJournalDto,
  RespondFeedbackDto,
  UpdateTicketStatusDto,
} from './dto/business-os.dto';

@Controller()
export class BusinessOsController {
  constructor(private readonly s: BusinessOsService) {}
  @Get('loyalty/:memberId') @RequirePermissions('loyalty.read') loyalty(
    @CurrentUser() u: AuthenticatedUser,
    @Param('memberId') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.loyaltyAccount(u.organizationId!, id, branchScope);
  }
  @Post('loyalty/:memberId/adjust')
  @RequirePermissions('loyalty.manage')
  adjust(
    @CurrentUser() u: AuthenticatedUser,
    @Param('memberId') id: string,
    @Body() b: AdjustLoyaltyDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.loyaltyAdjust(
      u.organizationId!,
      u.id,
      id,
      b.points,
      b.reason ?? 'manual',
      branchScope,
    );
  }
  @Get('referrals') @RequirePermissions('referrals.read') referrals(
    @CurrentUser() u: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.referrals(u.organizationId!, branchScope);
  }
  @Post('referrals/:memberId') @RequirePermissions('referrals.manage') referral(
    @CurrentUser() u: AuthenticatedUser,
    @Param('memberId') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.createReferral(u.organizationId!, id, branchScope);
  }
  @Post('referrals/:id/convert')
  @RequirePermissions('referrals.manage')
  convertReferral(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() b: ConvertReferralDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.convertReferral(
      u.organizationId!,
      id,
      b.memberId,
      branchScope,
    );
  }
  @Get('support/tickets') @RequirePermissions('support.read') tickets(
    @CurrentUser() u: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query('status') status?: string,
  ) {
    return this.s.tickets(u.organizationId!, status, branchScope);
  }
  @Post('support/tickets') @RequirePermissions('support.manage') ticket(
    @CurrentUser() u: AuthenticatedUser,
    @Body() b: CreateSupportTicketDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.createTicket(u.organizationId!, u.id, b, branchScope);
  }
  @Get('support/tickets/:id/messages')
  @RequirePermissions('support.read')
  ticketMessages(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.ticketMessages(u.organizationId!, id, branchScope);
  }
  @Post('support/tickets/:id/messages')
  @RequirePermissions('support.manage')
  message(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() b: AddTicketMessageDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.addTicketMessage(
      u.organizationId!,
      u.id,
      id,
      b.body,
      branchScope,
    );
  }
  @Patch('support/tickets/:id')
  @RequirePermissions('support.manage')
  updateTicket(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @Body() b: UpdateTicketStatusDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.updateTicket(u.organizationId!, id, b.status, branchScope);
  }
  @Get('feedback/surveys') @RequirePermissions('feedback.read') surveys(
    @CurrentUser() u: AuthenticatedUser,
  ) {
    return this.s.surveys(u.organizationId!);
  }
  @Post('feedback/surveys') @RequirePermissions('feedback.manage') survey(
    @CurrentUser() u: AuthenticatedUser,
    @Body() b: CreateSurveyDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.createSurvey(u.organizationId!, b, branchScope);
  }
  @Post('feedback/respond') @RequirePermissions('feedback.respond') respond(
    @CurrentUser() u: AuthenticatedUser,
    @Body() b: RespondFeedbackDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.respondFeedback(u.organizationId!, b, branchScope);
  }
  @Get('feedback/summary') @RequirePermissions('feedback.read') summary(
    @CurrentUser() u: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.feedbackSummary(u.organizationId!, branchScope);
  }
  @Get('marketing/campaigns') @RequirePermissions('marketing.read') campaigns(
    @CurrentUser() u: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.campaigns(u.organizationId!, branchScope);
  }
  @Post('marketing/campaigns') @RequirePermissions('marketing.manage') campaign(
    @CurrentUser() u: AuthenticatedUser,
    @Body() b: CreateCampaignDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.createCampaign(u.organizationId!, b, branchScope);
  }
  @Get('marketing/campaigns/:id/preview')
  @RequirePermissions('marketing.read')
  previewCampaign(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.previewCampaign(u.organizationId!, id, branchScope);
  }
  @Post('marketing/campaigns/:id/enroll')
  @RequirePermissions('marketing.manage')
  enroll(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.enrollCampaign(u.organizationId!, id, branchScope);
  }
  @Post('marketing/campaigns/:id/run')
  @RequirePermissions('marketing.manage')
  run(
    @CurrentUser() u: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.runCampaign(u.organizationId!, id, branchScope);
  }
  @Get('accounting/accounts') @RequirePermissions('accounting.read') accounts(
    @CurrentUser() u: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.accounts(u.organizationId!, branchScope);
  }
  @Post('accounting/accounts') @RequirePermissions('accounting.manage') account(
    @CurrentUser() u: AuthenticatedUser,
    @Body() b: CreateAccountingAccountDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.createAccount(u.organizationId!, b, branchScope);
  }
  @Post('accounting/journal') @RequirePermissions('accounting.manage') journal(
    @CurrentUser() u: AuthenticatedUser,
    @Body() b: PostJournalDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.accountingJournal(u.organizationId!, u.id, b, branchScope);
  }
  @Get('accounting/entries')
  @RequirePermissions('accounting.read')
  entries(
    @CurrentUser() u: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query('accountId') accountId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.s.entries(
      u.organizationId!,
      {
        accountId: accountId || undefined,
        from: from || undefined,
        to: to || undefined,
      },
      branchScope,
    );
  }
  @Get('accounting/tax-summary') @RequirePermissions('accounting.read') tax(
    @CurrentUser() u: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.s.taxSummary(u.organizationId!, from, to, branchScope);
  }
  @Get('accounting/trial-balance') @RequirePermissions('accounting.read') trial(
    @CurrentUser() u: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.s.trialBalance(u.organizationId!, from, to, branchScope);
  }
  @Get('pt-intelligence/:memberId')
  @RequirePermissions('reports.view')
  ptIntelligence(
    @CurrentUser() u: AuthenticatedUser,
    @Param('memberId') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.s.ptIntelligence(u.organizationId!, id, branchScope);
  }
}
