import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceService } from '../attendance/attendance.service';
import { CommunicationsService } from '../communications/communications.service';
import { AuditService } from '../audit/audit.service';

const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const s=(v:unknown, fallback='')=>typeof v==='string'&&v.trim()?v.trim():fallback;
const n=(v:unknown, fallback=0)=>Number.isFinite(Number(v))?Number(v):fallback;

@Injectable()
export class BusinessOsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
  ) {}

  async loyaltyAccount(org:string, memberId:string){
    const member=await this.prisma.member.findFirst({where:{id:memberId,organizationId:org,deletedAt:null},select:{id:true,firstName:true,lastName:true}});
    if(!member) throw new NotFoundException('Member not found');
    const rows=await this.prisma.$queryRawUnsafe<any[]>('SELECT * FROM loyalty_accounts WHERE organization_id=$1 AND member_id=$2',org,memberId);
    if(rows[0]) return rows[0];
    await this.prisma.$executeRawUnsafe('INSERT INTO loyalty_accounts(organization_id,member_id) VALUES($1,$2)',org,memberId);
    return (await this.prisma.$queryRawUnsafe<any[]>('SELECT * FROM loyalty_accounts WHERE organization_id=$1 AND member_id=$2',org,memberId))[0];
  }
  async loyaltyAdjust(org:string,userId:string,memberId:string,points:number,reason:string){
    if(!Number.isInteger(points)||points===0) throw new BadRequestException('points must be a non-zero integer');
    await this.loyaltyAccount(org,memberId);
    const updated=await this.prisma.$queryRawUnsafe<any[]>('UPDATE loyalty_accounts SET points=GREATEST(points+$1,0), tier=CASE WHEN points+$1>=5000 THEN \'PLATINUM\' WHEN points+$1>=2000 THEN \'GOLD\' WHEN points+$1>=500 THEN \'SILVER\' ELSE \'STANDARD\' END, updated_at=now() WHERE organization_id=$2 AND member_id=$3 RETURNING *',points,org,memberId);
    await this.prisma.$executeRawUnsafe('INSERT INTO loyalty_ledger(organization_id,member_id,points,reason) VALUES($1,$2,$3,$4)',org,memberId,points,reason);
    await this.audit.record({organizationId:org,actorUserId:userId,action:'LOYALTY_ADJUST',resource:'loyalty_account',resourceId:memberId,afterState:{points,reason}});
    return updated[0];
  }
  async createReferral(org:string,referrerId:string){
    const code='REF-'+randomBytes(5).toString('hex').toUpperCase();
    await this.prisma.$executeRawUnsafe('INSERT INTO referrals(organization_id,referrer_member_id,code) VALUES($1,$2,$3)',org,referrerId,code);
    return {code};
  }
  async convertReferral(org:string,id:string,referredMemberId:string){
    const rows=await this.prisma.$queryRawUnsafe<any[]>('UPDATE referrals SET referred_member_id=$1,status=\'CONVERTED\',converted_at=now() WHERE id=$2 AND organization_id=$3 AND status=\'PENDING\' RETURNING *',referredMemberId,id,org);
    if(!rows[0]) throw new NotFoundException('Referral not found or already converted');
    const reward=Number(rows[0].reward_points??0);
    if(reward>0) await this.loyaltyAdjust(org,'system',rows[0].referrer_member_id,reward,'Referral conversion');
    return rows[0];
  }
  referrals(org:string){return this.prisma.$queryRawUnsafe('SELECT r.*, m.first_name AS referrer_first_name, m.last_name AS referrer_last_name FROM referrals r JOIN members m ON m.id=r.referrer_member_id WHERE r.organization_id=$1 ORDER BY r.created_at DESC LIMIT 200',org);}

  tickets(org:string,status?:string){return this.prisma.$queryRawUnsafe('SELECT * FROM support_tickets WHERE organization_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT 200',org,status??null);}
  async createTicket(org:string,userId:string,b:any){
    const subject=s(b.subject); const description=s(b.description);
    if(!subject||!description) throw new BadRequestException('subject and description are required');
    const rows=await this.prisma.$queryRawUnsafe<any[]>('INSERT INTO support_tickets(organization_id,branch_id,member_id,created_by_user_id,subject,description,category,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',org,b.branchId??null,b.memberId??null,userId,subject,description,s(b.category,'GENERAL'),s(b.priority,'NORMAL'));
    return rows[0];
  }
  async addTicketMessage(org:string,userId:string,id:string,body:string){
    const ticket=await this.prisma.$queryRawUnsafe<any[]>('SELECT id FROM support_tickets WHERE id=$1 AND organization_id=$2',id,org);
    if(!ticket[0]) throw new NotFoundException('Ticket not found');
    if(!s(body)) throw new BadRequestException('body is required');
    const rows=await this.prisma.$queryRawUnsafe<any[]>('INSERT INTO support_ticket_messages(organization_id,ticket_id,author_user_id,body) VALUES($1,$2,$3,$4) RETURNING *',org,id,userId,body);
    return rows[0];
  }
  async updateTicket(org:string,id:string,status:string){
    if(!['OPEN','IN_PROGRESS','PENDING','RESOLVED','CLOSED'].includes(status)) throw new BadRequestException('Invalid ticket status');
    const rows=await this.prisma.$queryRawUnsafe<any[]>('UPDATE support_tickets SET status=$1,resolved_at=CASE WHEN $1 IN (\'RESOLVED\',\'CLOSED\') THEN COALESCE(resolved_at,now()) ELSE NULL END,updated_at=now() WHERE id=$2 AND organization_id=$3 RETURNING *',status,id,org);
    if(!rows[0]) throw new NotFoundException('Ticket not found'); return rows[0];
  }

  surveys(org:string){return this.prisma.$queryRawUnsafe('SELECT * FROM feedback_surveys WHERE organization_id=$1 ORDER BY created_at DESC',org);}
  createSurvey(org:string,b:any){const name=s(b.name); if(!name) throw new BadRequestException('name is required'); return this.prisma.$queryRawUnsafe('INSERT INTO feedback_surveys(organization_id,name,kind) VALUES($1,$2,$3) RETURNING *',org,name,s(b.kind,'CSAT'));}
  async respondFeedback(org:string,b:any){
    if(!b.surveyId||!b.memberId) throw new BadRequestException('surveyId and memberId are required');
    const score=n(b.score,-1); if(score<0||score>10) throw new BadRequestException('score must be 0-10');
    const survey=await this.prisma.$queryRawUnsafe<any[]>('SELECT id FROM feedback_surveys WHERE id=$1 AND organization_id=$2 AND active=true',b.surveyId,org);
    if(!survey[0]) throw new NotFoundException('Survey not found');
    return this.prisma.$queryRawUnsafe('INSERT INTO feedback_responses(organization_id,survey_id,member_id,score,comment) VALUES($1,$2,$3,$4,$5) RETURNING *',org,b.surveyId,b.memberId,score,s(b.comment)||null);
  }
  feedbackSummary(org:string){return this.prisma.$queryRawUnsafe('SELECT survey_id,COUNT(*)::int responses,ROUND(AVG(score),2) avg_score,COUNT(*) FILTER(WHERE score>=9)::int promoters,COUNT(*) FILTER(WHERE score<=6)::int detractors,ROUND((100.0*COUNT(*) FILTER(WHERE score>=9)/NULLIF(COUNT(*),0))-(100.0*COUNT(*) FILTER(WHERE score<=6)/NULLIF(COUNT(*),0)),2) nps FROM feedback_responses WHERE organization_id=$1 GROUP BY survey_id ORDER BY survey_id',org);}
  async ptIntelligence(org:string,memberId:string){
    const member=await this.prisma.member.findFirst({where:{id:memberId,organizationId:org,deletedAt:null},select:{id:true,firstName:true,lastName:true,assignedTrainerId:true}});
    if(!member) throw new NotFoundException('Member not found');
    const [attendance,workouts,ptSessions]=await Promise.all([
      this.prisma.attendance.count({where:{organizationId:org,memberId,deniedReason:null}}),
      this.prisma.workoutSession.count({where:{organizationId:org,memberId}}),
      this.prisma.ptSession.count({where:{organizationId:org,memberId,status:'COMPLETED'}}),
    ]);
    const last=await this.prisma.attendance.findFirst({where:{organizationId:org,memberId},orderBy:{checkInAt:'desc'},select:{checkInAt:true}});
    const daysSince=last?Math.max(0,Math.floor((Date.now()-last.checkInAt.getTime())/86400000)):null;
    return {member,attendanceCount:attendance,workoutSessionCount:workouts,completedPtSessions:ptSessions,lastCheckInAt:last?.checkInAt??null,daysSinceLastCheckIn:daysSince,engagementBand:daysSince===null?'NO_DATA':daysSince<=3?'HIGH':daysSince<=10?'MEDIUM':'LOW'};
  }
  async accountingJournal(org:string,userId:string,b:any){
    const lines: Array<{accountId:string;debit?:unknown;credit?:unknown;branchId?:string;}> = Array.isArray(b.lines)?b.lines:[]; if(lines.length<2) throw new BadRequestException('at least two journal lines are required');
    const debit=lines.reduce((a,l)=>a+n(l.debit),0), credit=lines.reduce((a,l)=>a+n(l.credit),0);
    if(Math.abs(debit-credit)>0.005) throw new BadRequestException('journal is not balanced');
    return this.prisma.$transaction(async tx=>{
      const created:any[]=[];
      for(const l of lines){
        if((n(l.debit)>0)===(n(l.credit)>0)) throw new BadRequestException('each journal line must have exactly one side');
        const rows=await tx.$queryRawUnsafe<any[]>('INSERT INTO accounting_entries(organization_id,account_id,branch_id,reference_type,reference_id,debit,credit,description,entry_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',org,l.accountId,l.branchId??null,b.referenceType??null,b.referenceId??null,n(l.debit),n(l.credit),s(l.description,'Journal entry'),b.entryDate?new Date(b.entryDate):new Date());
        created.push(rows[0]);
      }
      await this.audit.record({organizationId:org,actorUserId:userId,action:'ACCOUNTING_JOURNAL_CREATE',resource:'accounting_journal',afterState:{lines:created}});
      return created;
    });
  }
  taxSummary(org:string,from?:string,to?:string){return this.prisma.$queryRawUnsafe('SELECT COALESCE(SUM(debit),0)::numeric total_debit,COALESCE(SUM(credit),0)::numeric total_credit,COALESCE(SUM(debit-credit),0)::numeric net FROM accounting_entries WHERE organization_id=$1 AND ($2::date IS NULL OR entry_date>=$2) AND ($3::date IS NULL OR entry_date<=$3)',org,from??null,to??null);}


  campaigns(org:string){return this.prisma.$queryRawUnsafe('SELECT * FROM marketing_campaigns WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200',org);}
  createCampaign(org:string,b:any){const name=s(b.name); if(!name) throw new BadRequestException('name is required'); return this.prisma.$queryRawUnsafe('INSERT INTO marketing_campaigns(organization_id,branch_id,name,channel,template_key,audience_filter,status,scheduled_at) VALUES($1,$2,$3,$4,$5,$6,\'DRAFT\',$7) RETURNING *',org,b.branchId??null,name,s(b.channel,'EMAIL'),s(b.templateKey)||null,JSON.stringify(b.audienceFilter??{}),b.scheduledAt?new Date(b.scheduledAt):null);}
  async enrollCampaign(org:string,id:string){
    const camp=await this.prisma.$queryRawUnsafe<any[]>('SELECT * FROM marketing_campaigns WHERE id=$1 AND organization_id=$2',id,org); if(!camp[0]) throw new NotFoundException('Campaign not found');
    const members=await this.prisma.member.findMany({where:{organizationId:org,deletedAt:null},select:{id:true},take:5000});
    for(const m of members) await this.prisma.$executeRawUnsafe('INSERT INTO marketing_campaign_members(organization_id,campaign_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',org,id,m.id);
    return {enrolled:members.length};
  }
  async runCampaign(org:string,id:string){
    const camp=await this.prisma.$queryRawUnsafe<any[]>('SELECT * FROM marketing_campaigns WHERE id=$1 AND organization_id=$2',id,org); if(!camp[0]) throw new NotFoundException('Campaign not found');
    const rows=await this.prisma.$queryRawUnsafe<any[]>('SELECT c.member_id,m.phone,m.email FROM marketing_campaign_members c JOIN members m ON m.id=c.member_id WHERE c.campaign_id=$1 AND c.organization_id=$2 AND c.status=\'QUEUED\' LIMIT 500',id,org);
    let sent=0,failed=0;
    for(const r of rows){
      const recipient=camp[0].channel==='WHATSAPP'?r.phone:r.email;
      if(!recipient){failed++;continue}
      try{
        if(camp[0].channel==='WHATSAPP'||camp[0].channel==='SMS') await this.communications.sendAdHoc({organizationId:org,channel:camp[0].channel,category:'MARKETING',recipient,body:camp[0].template_key??camp[0].name});
        else await this.communications.sendAdHoc({organizationId:org,channel:'EMAIL',category:'MARKETING',recipient,body:camp[0].template_key??camp[0].name});
        await this.prisma.$executeRawUnsafe('UPDATE marketing_campaign_members SET status=\'SENT\',sent_at=now() WHERE campaign_id=$1 AND member_id=$2',id,r.member_id); sent++;
      }catch(e){failed++;await this.prisma.$executeRawUnsafe('UPDATE marketing_campaign_members SET status=\'FAILED\',error=$3 WHERE campaign_id=$1 AND member_id=$2',id,r.member_id,e instanceof Error?e.message:String(e));}
    }
    await this.prisma.$executeRawUnsafe('UPDATE marketing_campaigns SET status=CASE WHEN $2=0 THEN \'COMPLETED\' ELSE \'RUNNING\' END,updated_at=now() WHERE id=$1',id,rows.length);
    return {processed:rows.length,sent,failed};
  }

  accounts(org:string){return this.prisma.$queryRawUnsafe('SELECT * FROM accounting_accounts WHERE organization_id=$1 ORDER BY code',org);}
  createAccount(org:string,b:any){const code=s(b.code),name=s(b.name),type=s(b.type,'EXPENSE'); if(!code||!name) throw new BadRequestException('code and name are required'); return this.prisma.$queryRawUnsafe('INSERT INTO accounting_accounts(organization_id,code,name,type) VALUES($1,$2,$3,$4) RETURNING *',org,code,name,type);}
  async entry(org:string,userId:string,b:any){
    const debit=n(b.debit),credit=n(b.credit); if((debit<=0&&credit<=0)||(debit>0&&credit>0)) throw new BadRequestException('exactly one of debit or credit must be positive');
    const rows=await this.prisma.$queryRawUnsafe<any[]>('INSERT INTO accounting_entries(organization_id,account_id,branch_id,reference_type,reference_id,debit,credit,description,entry_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',org,b.accountId,b.branchId??null,b.referenceType??null,b.referenceId??null,debit,credit,s(b.description,'Journal entry'),b.entryDate?new Date(b.entryDate):new Date());
    await this.audit.record({organizationId:org,actorUserId:userId,action:'ACCOUNTING_ENTRY_CREATE',resource:'accounting_entry',resourceId:rows[0].id,afterState:rows[0]});
    return rows[0];
  }
  trialBalance(org:string,from?:string,to?:string){return this.prisma.$queryRawUnsafe('SELECT a.code,a.name,a.type,COALESCE(SUM(e.debit),0)::numeric debit,COALESCE(SUM(e.credit),0)::numeric credit,(COALESCE(SUM(e.debit),0)-COALESCE(SUM(e.credit),0))::numeric balance FROM accounting_accounts a LEFT JOIN accounting_entries e ON e.account_id=a.id AND ($2::date IS NULL OR e.entry_date>=$2) AND ($3::date IS NULL OR e.entry_date<=$3) WHERE a.organization_id=$1 GROUP BY a.id ORDER BY a.code',org,from??null,to??null);}

  async createPortalInvite(org:string,userId:string,memberId:string){
    const member=await this.prisma.member.findFirst({where:{id:memberId,organizationId:org,deletedAt:null},select:{id:true,firstName:true,lastName:true}});
    if(!member) throw new NotFoundException('Member not found');
    const token=randomBytes(32).toString('hex'); await this.prisma.$executeRawUnsafe('INSERT INTO portal_invites(organization_id,member_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval \'7 days\')',org,memberId,hash(token));
    await this.audit.record({organizationId:org,actorUserId:userId,action:'PORTAL_INVITE_CREATE',resource:'portal_invite',resourceId:memberId});
    return {token,expiresInDays:7,member};
  }
  async portalBootstrap(token:string){
    const rows=await this.prisma.$queryRawUnsafe<any[]>('SELECT p.*,m.first_name,m.last_name,m.email,m.phone,m.primary_branch_id FROM portal_invites p JOIN members m ON m.id=p.member_id WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at>now() AND m.deleted_at IS NULL',hash(token));
    if(!rows[0]) throw new NotFoundException('Invalid or expired portal token');
    const r=rows[0];
    const memberships=await this.prisma.membership.findMany({where:{organizationId:r.organization_id,memberId:r.member_id},orderBy:{endDate:'desc'},take:10});
    const attendance=await this.prisma.attendance.findMany({where:{organizationId:r.organization_id,memberId:r.member_id},orderBy:{checkInAt:'desc'},take:20});
    return {member:{id:r.member_id,firstName:r.first_name,lastName:r.last_name,email:r.email,phone:r.phone},memberships,attendance};
  }

  async registerKiosk(org:string,userId:string,b:any){
    if(!b.branchId||!s(b.name)) throw new BadRequestException('branchId and name are required');
    const key=randomBytes(32).toString('hex');
    await this.prisma.$executeRawUnsafe('INSERT INTO kiosk_devices(organization_id,branch_id,name,key_hash) VALUES($1,$2,$3,$4)',org,b.branchId,s(b.name),hash(key));
    await this.audit.record({organizationId:org,actorUserId:userId,action:'KIOSK_DEVICE_CREATE',resource:'kiosk_device',afterState:{branchId:b.branchId,name:b.name}});
    return {key,warning:'Store this key securely; it is shown once.'};
  }
  async kioskCheckin(deviceKey:string,memberId:string){
    const rows=await this.prisma.$queryRawUnsafe<any[]>('SELECT * FROM kiosk_devices WHERE key_hash=$1 AND active=true',hash(deviceKey));
    const d=rows[0]; if(!d) throw new BadRequestException('Invalid kiosk key');
    const decision=await this.attendance.evaluateGate(d.organization_id,memberId);
    let result=decision.allowed?'ALLOWED':'DENIED';
    await this.prisma.$executeRawUnsafe('INSERT INTO kiosk_events(organization_id,branch_id,device_id,member_id,event_type,result) VALUES($1,$2,$3,$4,\'CHECK_IN\',$5)',d.organization_id,d.branch_id,d.id,memberId,result);
    if(!decision.allowed) return {allowed:false,reason:decision.reason};
    const member=await this.prisma.member.findFirst({where:{id:memberId,organizationId:d.organization_id,deletedAt:null},select:{id:true,firstName:true,lastName:true}});
    if(!member) return {allowed:false,reason:'member not found'};
    return {allowed:true,member};
  }
}
