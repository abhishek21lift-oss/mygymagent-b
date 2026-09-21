import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { BusinessOsService } from './business-os.service';

@Controller()
export class BusinessOsController {
  constructor(private readonly s:BusinessOsService){}
  @Get('loyalty/:memberId') @RequirePermissions('loyalty.read') loyalty(@CurrentUser()u:AuthenticatedUser,@Param('memberId')id:string){return this.s.loyaltyAccount(u.organizationId!,id);}
  @Post('loyalty/:memberId/adjust') @RequirePermissions('loyalty.manage') adjust(@CurrentUser()u:AuthenticatedUser,@Param('memberId')id:string,@Body()b:any){return this.s.loyaltyAdjust(u.organizationId!,u.id,id,Number(b.points),String(b.reason??'manual'));}
  @Get('referrals') @RequirePermissions('referrals.read') referrals(@CurrentUser()u:AuthenticatedUser){return this.s.referrals(u.organizationId!);}
  @Post('referrals/:memberId') @RequirePermissions('referrals.manage') referral(@CurrentUser()u:AuthenticatedUser,@Param('memberId')id:string){return this.s.createReferral(u.organizationId!,id);}
  @Get('support/tickets') @RequirePermissions('support.read') tickets(@CurrentUser()u:AuthenticatedUser,@Query('status')status?:string){return this.s.tickets(u.organizationId!,status);}
  @Post('support/tickets') @RequirePermissions('support.manage') ticket(@CurrentUser()u:AuthenticatedUser,@Body()b:any){return this.s.createTicket(u.organizationId!,u.id,b);}
  @Post('support/tickets/:id/messages') @RequirePermissions('support.manage') message(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Body('body')body:string){return this.s.addTicketMessage(u.organizationId!,u.id,id,body);}
  @Patch('support/tickets/:id') @RequirePermissions('support.manage') updateTicket(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string,@Body('status')status:string){return this.s.updateTicket(u.organizationId!,id,status);}
  @Get('feedback/surveys') @RequirePermissions('feedback.read') surveys(@CurrentUser()u:AuthenticatedUser){return this.s.surveys(u.organizationId!);}
  @Post('feedback/surveys') @RequirePermissions('feedback.manage') survey(@CurrentUser()u:AuthenticatedUser,@Body()b:any){return this.s.createSurvey(u.organizationId!,b);}
  @Post('feedback/respond') @RequirePermissions('feedback.respond') respond(@CurrentUser()u:AuthenticatedUser,@Body()b:any){return this.s.respondFeedback(u.organizationId!,b);}
  @Get('feedback/summary') @RequirePermissions('feedback.read') summary(@CurrentUser()u:AuthenticatedUser){return this.s.feedbackSummary(u.organizationId!);}
  @Get('marketing/campaigns') @RequirePermissions('marketing.read') campaigns(@CurrentUser()u:AuthenticatedUser){return this.s.campaigns(u.organizationId!);}
  @Post('marketing/campaigns') @RequirePermissions('marketing.manage') campaign(@CurrentUser()u:AuthenticatedUser,@Body()b:any){return this.s.createCampaign(u.organizationId!,b);}
  @Post('marketing/campaigns/:id/enroll') @RequirePermissions('marketing.manage') enroll(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.s.enrollCampaign(u.organizationId!,id);}
  @Post('marketing/campaigns/:id/run') @RequirePermissions('marketing.manage') run(@CurrentUser()u:AuthenticatedUser,@Param('id')id:string){return this.s.runCampaign(u.organizationId!,id);}
  @Get('accounting/accounts') @RequirePermissions('accounting.read') accounts(@CurrentUser()u:AuthenticatedUser){return this.s.accounts(u.organizationId!);}
  @Post('accounting/accounts') @RequirePermissions('accounting.manage') account(@CurrentUser()u:AuthenticatedUser,@Body()b:any){return this.s.createAccount(u.organizationId!,b);}
  @Post('accounting/entries') @RequirePermissions('accounting.manage') entry(@CurrentUser()u:AuthenticatedUser,@Body()b:any){return this.s.entry(u.organizationId!,u.id,b);}
  @Get('accounting/trial-balance') @RequirePermissions('accounting.read') trial(@CurrentUser()u:AuthenticatedUser,@Query('from')from?:string,@Query('to')to?:string){return this.s.trialBalance(u.organizationId!,from,to);}
  @Post('portal/invites/:memberId') @RequirePermissions('portal.manage') invite(@CurrentUser()u:AuthenticatedUser,@Param('memberId')id:string){return this.s.createPortalInvite(u.organizationId!,u.id,id);}
  @Public() @Get('portal/bootstrap/:token') portal(@Param('token')token:string){return this.s.portalBootstrap(token);}
  @Post('kiosk/devices') @RequirePermissions('kiosk.manage') kiosk(@CurrentUser()u:AuthenticatedUser,@Body()b:any){return this.s.registerKiosk(u.organizationId!,u.id,b);}
  @Public() @Post('kiosk/check-in') kioskCheckin(@Body()b:any){return this.s.kioskCheckin(String(b.deviceKey??''),String(b.memberId??''));}
}