/* eslint-disable prettier/prettier */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  TooManyRequestsException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceService } from '../attendance/attendance.service';
import { CommunicationsService } from '../communications/communications.service';
import { AuditService } from '../audit/audit.service';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const s = (v: unknown, fallback = '') =>
  typeof v === 'string' && v.trim() ? v.trim() : fallback;
const n = (v: unknown, fallback = 0) =>
  Number.isFinite(Number(v)) ? Number(v) : fallback;

@Injectable()
export class BusinessOsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
    private readonly communications: CommunicationsService,
    private readonly audit: AuditService,
  ) {}

  async loyaltyAccount(org: string, memberId: string) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId: org, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT * FROM loyalty_accounts WHERE organization_id=$1 AND member_id=$2',
      org,
      memberId,
    );
    if (rows[0]) return rows[0];
    await this.prisma.$executeRawUnsafe(
      'INSERT INTO loyalty_accounts(organization_id,member_id) VALUES($1,$2)',
      org,
      memberId,
    );
    return (
      await this.prisma.$queryRawUnsafe<any[]>(
        'SELECT * FROM loyalty_accounts WHERE organization_id=$1 AND member_id=$2',
        org,
        memberId,
      )
    )[0];
  }
  private async ensureMember(org: string, memberId: string) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId: org, deletedAt: null },
      select: { id: true, primaryBranchId: true },
    });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }

  private async ensureBranch(org: string, branchId: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { id: branchId, organizationId: org, deletedAt: null },
      select: { id: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return branch;
  }

  private async rateLimit(scope: string, key: string, limit: number, windowSeconds: number) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>("INSERT INTO public_endpoint_rate_limits(scope,key,hits,window_started_at) VALUES($1,$2,1,now()) ON CONFLICT(scope,key) DO UPDATE SET hits=CASE WHEN public_endpoint_rate_limits.window_started_at <= now() - make_interval(secs => $3) THEN 1 ELSE public_endpoint_rate_limits.hits + 1 END, window_started_at=CASE WHEN public_endpoint_rate_limits.window_started_at <= now() - make_interval(secs => $3) THEN now() ELSE public_endpoint_rate_limits.window_started_at END RETURNING hits", scope, hash(key), windowSeconds);
    if (Number(rows[0]?.hits ?? 0) > limit) throw new TooManyRequestsException('Too many requests. Please try again later.');
  }

  async loyaltyAdjust(
    org: string, userId: string, memberId: string, points: number, reason: string,
  ) {
    if (!Number.isInteger(points) || points === 0) throw new BadRequestException('points must be a non-zero integer');
    await this.ensureMember(org, memberId);
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('INSERT INTO loyalty_accounts(organization_id,member_id) VALUES($1,$2) ON CONFLICT (organization_id,member_id) DO NOTHING', org, memberId);
      const rows = await tx.$queryRawUnsafe<any[]>("UPDATE loyalty_accounts SET points=GREATEST(points+$1,0), tier=CASE WHEN GREATEST(points+$1,0)>=5000 THEN 'PLATINUM' WHEN GREATEST(points+$1,0)>=2000 THEN 'GOLD' WHEN GREATEST(points+$1,0)>=500 THEN 'SILVER' ELSE 'STANDARD' END, updated_at=now() WHERE organization_id=$2 AND member_id=$3 RETURNING *", points, org, memberId);
      if (!rows[0]) throw new NotFoundException('Loyalty account not found');
      await tx.$executeRawUnsafe('INSERT INTO loyalty_ledger(organization_id,member_id,points,reason) VALUES($1,$2,$3,$4)', org, memberId, points, s(reason, 'Manual adjustment'));
      return rows[0];
    });
    await this.audit.record({ organizationId: org, actorUserId: userId, action: 'LOYALTY_ADJUST', resource: 'loyalty_account', resourceId: memberId, afterState: { points, reason } });
    return updated;
  }
  async createReferral(org: string, referrerId: string) {
    await this.ensureMember(org, referrerId);
    const code = 'REF-' + randomBytes(5).toString('hex').toUpperCase();
    await this.prisma.$executeRawUnsafe('INSERT INTO referrals(organization_id,referrer_member_id,code) VALUES($1,$2,$3)', org, referrerId, code);
    return { code };
  }

  async convertReferral(org: string, id: string, referredMemberId: string) {
    await this.ensureMember(org, referredMemberId);
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<any[]>("UPDATE referrals SET referred_member_id=$1,status='CONVERTED',converted_at=now() WHERE id=$2 AND organization_id=$3 AND status='PENDING' RETURNING *", referredMemberId, id, org);
      if (!rows[0]) throw new NotFoundException('Referral not found or already converted');
      const referral = rows[0];
      const reward = Number(referral.reward_points ?? 0);
      if (reward > 0) {
        await tx.$queryRawUnsafe('INSERT INTO loyalty_accounts(organization_id,member_id) VALUES($1,$2) ON CONFLICT (organization_id,member_id) DO NOTHING', org, referral.referrer_member_id);
        await tx.$queryRawUnsafe("UPDATE loyalty_accounts SET points=GREATEST(points+$1,0), tier=CASE WHEN GREATEST(points+$1,0)>=5000 THEN 'PLATINUM' WHEN GREATEST(points+$1,0)>=2000 THEN 'GOLD' WHEN GREATEST(points+$1,0)>=500 THEN 'SILVER' ELSE 'STANDARD' END, updated_at=now() WHERE organization_id=$2 AND member_id=$3", reward, org, referral.referrer_member_id);
        await tx.$executeRawUnsafe('INSERT INTO loyalty_ledger(organization_id,member_id,points,reason,reference_type,reference_id) VALUES($1,$2,$3,$4,$5,$6)', org, referral.referrer_member_id, reward, 'Referral conversion', 'REFERRAL', id);
      }
      return referral;
    });
  }
  referrals(org: string) {
    return this.prisma.$queryRawUnsafe(
      'SELECT r.*, m.first_name AS referrer_first_name, m.last_name AS referrer_last_name FROM referrals r JOIN members m ON m.id=r.referrer_member_id WHERE r.organization_id=$1 ORDER BY r.created_at DESC LIMIT 200',
      org,
    );
  }

  tickets(org: string, status?: string) {
    return this.prisma.$queryRawUnsafe(
      'SELECT * FROM support_tickets WHERE organization_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY created_at DESC LIMIT 200',
      org,
      status ?? null,
    );
  }
  async createTicket(org: string, userId: string, b: any) {
    const subject = s(b.subject);
    const description = s(b.description);
    if (!subject || !description)
      throw new BadRequestException('subject and description are required');
    const branchId = b.branchId ? String(b.branchId) : null;
    const memberId = b.memberId ? String(b.memberId) : null;
    if (branchId) await this.ensureBranch(org, branchId);
    if (memberId) {
      const member = await this.ensureMember(org, memberId);
      if (branchId && member.primaryBranchId !== branchId) throw new BadRequestException('Member does not belong to the selected branch');
    }
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      'INSERT INTO support_tickets(organization_id,branch_id,member_id,created_by_user_id,subject,description,category,priority) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      org, branchId, memberId, userId, subject, description, s(b.category, 'GENERAL'), s(b.priority, 'NORMAL'),
    );
    return rows[0];
  }
  async addTicketMessage(
    org: string,
    userId: string,
    id: string,
    body: string,
  ) {
    const ticket = await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM support_tickets WHERE id=$1 AND organization_id=$2',
      id,
      org,
    );
    if (!ticket[0]) throw new NotFoundException('Ticket not found');
    if (!s(body)) throw new BadRequestException('body is required');
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      'INSERT INTO support_ticket_messages(organization_id,ticket_id,author_user_id,body) VALUES($1,$2,$3,$4) RETURNING *',
      org,
      id,
      userId,
      body,
    );
    return rows[0];
  }
  async updateTicket(org: string, id: string, status: string) {
    if (
      !['OPEN', 'IN_PROGRESS', 'PENDING', 'RESOLVED', 'CLOSED'].includes(status)
    )
      throw new BadRequestException('Invalid ticket status');
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      "UPDATE support_tickets SET status=$1,resolved_at=CASE WHEN $1 IN ('RESOLVED','CLOSED') THEN COALESCE(resolved_at,now()) ELSE NULL END,updated_at=now() WHERE id=$2 AND organization_id=$3 RETURNING *",
      status,
      id,
      org,
    );
    if (!rows[0]) throw new NotFoundException('Ticket not found');
    return rows[0];
  }

  surveys(org: string) {
    return this.prisma.$queryRawUnsafe(
      'SELECT * FROM feedback_surveys WHERE organization_id=$1 ORDER BY created_at DESC',
      org,
    );
  }
  createSurvey(org: string, b: any) {
    const name = s(b.name);
    if (!name) throw new BadRequestException('name is required');
    return this.prisma.$queryRawUnsafe(
      'INSERT INTO feedback_surveys(organization_id,name,kind) VALUES($1,$2,$3) RETURNING *',
      org,
      name,
      s(b.kind, 'CSAT'),
    );
  }
  async respondFeedback(org: string, b: any) {
    if (!b.surveyId || !b.memberId)
      throw new BadRequestException('surveyId and memberId are required');
    const score = n(b.score, -1);
    if (score < 0 || score > 10)
      throw new BadRequestException('score must be 0-10');
    const survey = await this.prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM feedback_surveys WHERE id=$1 AND organization_id=$2 AND active=true',
      b.surveyId,
      org,
    );
    if (!survey[0]) throw new NotFoundException('Survey not found');
    await this.ensureMember(org, String(b.memberId));
    return this.prisma.$queryRawUnsafe(
      'INSERT INTO feedback_responses(organization_id,survey_id,member_id,score,comment) VALUES($1,$2,$3,$4,$5) RETURNING *',
      org,
      b.surveyId,
      b.memberId,
      score,
      s(b.comment) || null,
    );
  }
  feedbackSummary(org: string) {
    return this.prisma.$queryRawUnsafe(
      'SELECT survey_id,COUNT(*)::int responses,ROUND(AVG(score),2) avg_score,COUNT(*) FILTER(WHERE score>=9)::int promoters,COUNT(*) FILTER(WHERE score<=6)::int detractors,ROUND((100.0*COUNT(*) FILTER(WHERE score>=9)/NULLIF(COUNT(*),0))-(100.0*COUNT(*) FILTER(WHERE score<=6)/NULLIF(COUNT(*),0)),2) nps FROM feedback_responses WHERE organization_id=$1 GROUP BY survey_id ORDER BY survey_id',
      org,
    );
  }
  async ptIntelligence(org: string, memberId: string) {
    const member = await this.prisma.member.findFirst({
      where: { id: memberId, organizationId: org, deletedAt: null },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        assignedTrainerId: true,
      },
    });
    if (!member) throw new NotFoundException('Member not found');
    const [attendance, workouts, ptSessions] = await Promise.all([
      this.prisma.attendance.count({
        where: { organizationId: org, memberId, deniedReason: null },
      }),
      this.prisma.workoutSession.count({
        where: { organizationId: org, memberId },
      }),
      this.prisma.ptSession.count({
        where: { organizationId: org, memberId, status: 'COMPLETED' },
      }),
    ]);
    const last = await this.prisma.attendance.findFirst({
      where: { organizationId: org, memberId },
      orderBy: { checkInAt: 'desc' },
      select: { checkInAt: true },
    });
    const daysSince = last
      ? Math.max(
          0,
          Math.floor((Date.now() - last.checkInAt.getTime()) / 86400000),
        )
      : null;
    return {
      member,
      attendanceCount: attendance,
      workoutSessionCount: workouts,
      completedPtSessions: ptSessions,
      lastCheckInAt: last?.checkInAt ?? null,
      daysSinceLastCheckIn: daysSince,
      engagementBand:
        daysSince === null
          ? 'NO_DATA'
          : daysSince <= 3
            ? 'HIGH'
            : daysSince <= 10
              ? 'MEDIUM'
              : 'LOW',
    };
  }
  async accountingJournal(org: string, userId: string, b: any) {
    const lines: Array<{ accountId: string; debit?: unknown; credit?: unknown; branchId?: string; description?: string }> = Array.isArray(b.lines) ? b.lines : [];
    if (lines.length < 2) throw new BadRequestException('at least two journal lines are required');
    const debit = lines.reduce((a, l) => a + n(l.debit), 0);
    const credit = lines.reduce((a, l) => a + n(l.credit), 0);
    if (Math.abs(debit - credit) > 0.005) throw new BadRequestException('journal is not balanced');
    return this.prisma.$transaction(async (tx) => {
      const created: any[] = [];
      for (const l of lines) {
        const d = n(l.debit), cr = n(l.credit);
        if ((d <= 0 && cr <= 0) || (d > 0 && cr > 0)) throw new BadRequestException('each journal line must have exactly one positive side');
        const account = await tx.$queryRawUnsafe<any[]>('SELECT id FROM accounting_accounts WHERE id=$1 AND organization_id=$2 AND active=true', l.accountId, org);
        if (!account[0]) throw new NotFoundException('Accounting account not found');
        if (l.branchId) {
          const branch = await tx.$queryRawUnsafe<any[]>('SELECT id FROM branches WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL', l.branchId, org);
          if (!branch[0]) throw new NotFoundException('Branch not found');
        }
        const rows = await tx.$queryRawUnsafe<any[]>('INSERT INTO accounting_entries(organization_id,account_id,branch_id,reference_type,reference_id,debit,credit,description,entry_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', org, l.accountId, l.branchId ?? null, b.referenceType ?? null, b.referenceId ?? null, d, cr, s(l.description, 'Journal entry'), b.entryDate ? new Date(b.entryDate) : new Date());
        created.push(rows[0]);
      }
      await this.audit.record({ organizationId: org, actorUserId: userId, action: 'ACCOUNTING_JOURNAL_CREATE', resource: 'accounting_journal', afterState: { lines: created } });
      return created;
    });
  }
  taxSummary(org: string, from?: string, to?: string) {
    return this.prisma.$queryRawUnsafe(
      'SELECT COALESCE(SUM(debit),0)::numeric total_debit,COALESCE(SUM(credit),0)::numeric total_credit,COALESCE(SUM(debit-credit),0)::numeric net FROM accounting_entries WHERE organization_id=$1 AND ($2::date IS NULL OR entry_date>=$2) AND ($3::date IS NULL OR entry_date<=$3)',
      org,
      from ?? null,
      to ?? null,
    );
  }

  campaigns(org: string) {
    return this.prisma.$queryRawUnsafe(
      'SELECT * FROM marketing_campaigns WHERE organization_id=$1 ORDER BY created_at DESC LIMIT 200',
      org,
    );
  }
  async createCampaign(org: string, b: any) {
    const name = s(b.name);
    if (!name) throw new BadRequestException('name is required');
    const channel = s(b.channel, 'EMAIL');
    if (!['EMAIL', 'WHATSAPP', 'SMS'].includes(channel)) throw new BadRequestException('channel must be EMAIL, WHATSAPP or SMS');
    if (b.branchId) await this.ensureBranch(org, String(b.branchId));
    const audienceFilter = b.audienceFilter && typeof b.audienceFilter === 'object' ? b.audienceFilter : {};
    return this.prisma.$queryRawUnsafe(
      "INSERT INTO marketing_campaigns(organization_id,branch_id,name,channel,template_key,audience_filter,status,scheduled_at) VALUES($1,$2,$3,$4,$5,$6,'DRAFT',$7) RETURNING *",
      org,
      b.branchId ?? null,
      name,
      channel,
      s(b.templateKey) || null,
      JSON.stringify(audienceFilter),
      b.scheduledAt ? new Date(b.scheduledAt) : null,
    );
  }
  async enrollCampaign(org: string, id: string) {
    const camp = await this.prisma.$queryRawUnsafe<any[]>('SELECT * FROM marketing_campaigns WHERE id=$1 AND organization_id=$2', id, org);
    if (!camp[0]) throw new NotFoundException('Campaign not found');
    let filter: Record<string, unknown> = {};
    try { filter = camp[0].audience_filter ? (typeof camp[0].audience_filter === 'string' ? JSON.parse(camp[0].audience_filter) : camp[0].audience_filter) : {}; }
    catch { throw new BadRequestException('Invalid campaign audience filter'); }
    const allowed = new Set(['branchId','status','memberType','leadSource','assignedTrainerId','hasActiveMembership','minDaysSinceCheckIn','maxDaysSinceCheckIn','hasEmail','hasPhone']);
    for (const key of Object.keys(filter)) if (!allowed.has(key)) throw new BadRequestException('Unsupported audience filter: '+key);
    const where: string[] = ['m.organization_id=$1','m.deleted_at IS NULL'];
    const params: unknown[] = [org];
    const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace('$X', '$'+params.length)); };
    if (filter.branchId) { await this.ensureBranch(org, String(filter.branchId)); add('m.primary_branch_id=$X', String(filter.branchId)); }
    if (filter.status) add('m.status=$X', String(filter.status));
    if (filter.memberType) add('m.member_type=$X', String(filter.memberType));
    if (filter.leadSource) add('m.lead_source=$X', String(filter.leadSource));
    if (filter.assignedTrainerId) {
      const trainer = await this.prisma.user.findFirst({ where: { id: String(filter.assignedTrainerId), organizationId: org, deletedAt: null }, select: { id: true } });
      if (!trainer) throw new NotFoundException('Trainer not found');
      add('m.assigned_trainer_id=$X', String(filter.assignedTrainerId));
    }
    if (filter.hasEmail === true) where.push("m.email IS NOT NULL AND btrim(m.email) <> ''");
    if (filter.hasPhone === true) where.push("m.phone IS NOT NULL AND btrim(m.phone) <> ''");
    if (filter.hasActiveMembership === true) where.push("EXISTS (SELECT 1 FROM memberships ms WHERE ms.organization_id=m.organization_id AND ms.member_id=m.id AND ms.status='ACTIVE' AND ms.end_date >= CURRENT_DATE)");
    if (filter.hasActiveMembership === false) where.push("NOT EXISTS (SELECT 1 FROM memberships ms WHERE ms.organization_id=m.organization_id AND ms.member_id=m.id AND ms.status='ACTIVE' AND ms.end_date >= CURRENT_DATE)");
    if (filter.minDaysSinceCheckIn !== undefined) {
      const min = Number(filter.minDaysSinceCheckIn); if (!Number.isInteger(min) || min < 0) throw new BadRequestException('minDaysSinceCheckIn must be a non-negative integer');
      params.push(min); const ph='$'+params.length; where.push("(NOT EXISTS (SELECT 1 FROM attendances ax WHERE ax.organization_id=m.organization_id AND ax.member_id=m.id) OR EXISTS (SELECT 1 FROM attendances a WHERE a.organization_id=m.organization_id AND a.member_id=m.id GROUP BY a.member_id HAVING MAX(a.check_in_at) <= CURRENT_TIMESTAMP - INTERVAL '1 day' * "+ph+"))");
    }
    if (filter.maxDaysSinceCheckIn !== undefined) {
      const max = Number(filter.maxDaysSinceCheckIn); if (!Number.isInteger(max) || max < 0) throw new BadRequestException('maxDaysSinceCheckIn must be a non-negative integer');
      params.push(max); const ph='$'+params.length; where.push("(NOT EXISTS (SELECT 1 FROM attendances ax WHERE ax.organization_id=m.organization_id AND ax.member_id=m.id) OR EXISTS (SELECT 1 FROM attendances a WHERE a.organization_id=m.organization_id AND a.member_id=m.id GROUP BY a.member_id HAVING MAX(a.check_in_at) >= CURRENT_TIMESTAMP - INTERVAL '1 day' * "+ph+"))");
    }
    const members = await this.prisma.$queryRawUnsafe<any[]>('SELECT m.id FROM members m WHERE '+where.join(' AND ')+' ORDER BY m.created_at ASC LIMIT 5000', ...params);
    for (const m of members) await this.prisma.$executeRawUnsafe('INSERT INTO marketing_campaign_members(organization_id,campaign_id,member_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', org, id, m.id);
    await this.prisma.$executeRawUnsafe("UPDATE marketing_campaigns SET status='QUEUED',updated_at=now() WHERE id=$1 AND organization_id=$2 AND status IN ('DRAFT','QUEUED','RUNNING')", id, org);
    return { enrolled: members.length, audienceFilter: filter };
  }
  async runCampaign(org: string, id: string) {
    const camp = await this.prisma.$queryRawUnsafe<any[]>('SELECT * FROM marketing_campaigns WHERE id=$1 AND organization_id=$2', id, org);
    if (!camp[0]) throw new NotFoundException('Campaign not found');
    const rows = await this.prisma.$queryRawUnsafe<any[]>("SELECT c.member_id,m.phone,m.email FROM marketing_campaign_members c JOIN members m ON m.id=c.member_id WHERE c.campaign_id=$1 AND c.organization_id=$2 AND c.status='QUEUED' LIMIT 500", id, org);
    let sent=0, failed=0;
    for (const r of rows) {
      const channel = ['WHATSAPP','SMS','EMAIL'].includes(camp[0].channel) ? camp[0].channel : 'EMAIL';
      const recipient = channel === 'WHATSAPP' || channel === 'SMS' ? r.phone : r.email;
      if (!recipient) { failed++; await this.prisma.$executeRawUnsafe("UPDATE marketing_campaign_members SET status='FAILED',error=$3 WHERE campaign_id=$1 AND member_id=$2 AND status='QUEUED'", id, r.member_id, 'Missing recipient address'); continue; }
      try {
        await this.communications.sendAdHoc({ organizationId: org, channel, category: 'MARKETING', recipient, body: camp[0].template_key ?? camp[0].name });
        await this.prisma.$executeRawUnsafe("UPDATE marketing_campaign_members SET status='SENT',sent_at=now(),error=NULL WHERE campaign_id=$1 AND member_id=$2 AND status='QUEUED'", id, r.member_id); sent++;
      } catch (e) {
        failed++; await this.prisma.$executeRawUnsafe("UPDATE marketing_campaign_members SET status='FAILED',error=$3 WHERE campaign_id=$1 AND member_id=$2 AND status='QUEUED'", id, r.member_id, e instanceof Error ? e.message : String(e));
      }
    }
    await this.prisma.$executeRawUnsafe("UPDATE marketing_campaigns SET status=CASE WHEN EXISTS (SELECT 1 FROM marketing_campaign_members WHERE campaign_id=$1 AND organization_id=$2 AND status='QUEUED') THEN 'RUNNING' ELSE 'COMPLETED' END,updated_at=now() WHERE id=$1 AND organization_id=$2", id, org);
    return { processed: rows.length, sent, failed };
  }
  accounts(org: string) {
    return this.prisma.$queryRawUnsafe(
      'SELECT * FROM accounting_accounts WHERE organization_id=$1 ORDER BY code',
      org,
    );
  }
  createAccount(org: string, b: any) {
    const code = s(b.code),
      name = s(b.name),
      type = s(b.type, 'EXPENSE');
    const allowedTypes = new Set(['ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE']);
    if (!code || !name) throw new BadRequestException('code and name are required');
    if (!allowedTypes.has(type)) throw new BadRequestException('Invalid accounting account type');
    return this.prisma.$queryRawUnsafe(
      'INSERT INTO accounting_accounts(organization_id,code,name,type) VALUES($1,$2,$3,$4) RETURNING *',
      org,
      code,
      name,
      type,
    );
  }
  async entry(org: string, userId: string, b: any) {
    const debit=n(b.debit), credit=n(b.credit);
    if ((debit<=0 && credit<=0) || (debit>0 && credit>0)) throw new BadRequestException('exactly one of debit or credit must be positive');
    throw new BadRequestException('Use /accounting/journal for posting balanced accounting transactions');
  }
  trialBalance(org: string, from?: string, to?: string) {
    return this.prisma.$queryRawUnsafe(
      'SELECT a.code,a.name,a.type,COALESCE(SUM(e.debit),0)::numeric debit,COALESCE(SUM(e.credit),0)::numeric credit,(COALESCE(SUM(e.debit),0)-COALESCE(SUM(e.credit),0))::numeric balance FROM accounting_accounts a LEFT JOIN accounting_entries e ON e.account_id=a.id AND ($2::date IS NULL OR e.entry_date>=$2) AND ($3::date IS NULL OR e.entry_date<=$3) WHERE a.organization_id=$1 GROUP BY a.id ORDER BY a.code',
      org,
      from ?? null,
      to ?? null,
    );
  }

  async createPortalInvite(org: string, userId: string, memberId: string) {
    const member = await this.ensureMember(org, memberId);
    const token = randomBytes(32).toString('hex');
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('UPDATE portal_invites SET used_at=COALESCE(used_at,now()) WHERE organization_id=$1 AND member_id=$2 AND used_at IS NULL', org, memberId);
      await tx.$executeRawUnsafe("INSERT INTO portal_invites(organization_id,member_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '7 days')", org, memberId, hash(token));
    });
    await this.audit.record({ organizationId: org, actorUserId: userId, action: 'PORTAL_INVITE_CREATE', resource: 'portal_invite', resourceId: memberId });
    return { token, expiresInDays: 7, member };
  }

  async revokePortalInvites(org: string, userId: string, memberId: string) {
    await this.ensureMember(org, memberId);
    const result = await this.prisma.$executeRawUnsafe('UPDATE portal_invites SET used_at=COALESCE(used_at,now()) WHERE organization_id=$1 AND member_id=$2 AND used_at IS NULL', org, memberId);
    await this.audit.record({ organizationId: org, actorUserId: userId, action: 'PORTAL_INVITE_REVOKE', resource: 'portal_invite', resourceId: memberId });
    return { revoked: Number(result) };
  }

  async portalBootstrap(token: string, clientKey: string) {
    if (!token || token.length < 32) throw new BadRequestException('Invalid portal token');
    await this.rateLimit('portal-bootstrap', clientKey || 'unknown', 20, 60);
    const rows = await this.prisma.$queryRawUnsafe<any[]>("SELECT p.*,m.first_name,m.last_name,m.email,m.phone,m.primary_branch_id FROM portal_invites p JOIN members m ON m.id=p.member_id WHERE p.token_hash=$1 AND p.used_at IS NULL AND p.expires_at>now() AND m.deleted_at IS NULL", hash(token));
    if (!rows[0]) throw new NotFoundException('Invalid or expired portal token');
    const r=rows[0];
    const consumed=await this.prisma.$executeRawUnsafe('UPDATE portal_invites SET used_at=now() WHERE id=$1 AND used_at IS NULL AND expires_at>now()', r.id);
    if (Number(consumed)!==1) throw new NotFoundException('Invalid or expired portal token');
    const memberships=await this.prisma.membership.findMany({where:{organizationId:r.organization_id,memberId:r.member_id},orderBy:{endDate:'desc'},take:10});
    const attendance=await this.prisma.attendance.findMany({where:{organizationId:r.organization_id,memberId:r.member_id},orderBy:{checkInAt:'desc'},take:20});
    return {member:{id:r.member_id,firstName:r.first_name,lastName:r.last_name,email:r.email,phone:r.phone},memberships,attendance};
  }
  async registerKiosk(org: string, userId: string, b: any) {
    if (!b.branchId || !s(b.name)) throw new BadRequestException('branchId and name are required');
    await this.ensureBranch(org, String(b.branchId));
    const key=randomBytes(32).toString('hex');
    await this.prisma.$executeRawUnsafe('INSERT INTO kiosk_devices(organization_id,branch_id,name,key_hash) VALUES($1,$2,$3,$4)', org,b.branchId,s(b.name),hash(key));
    await this.audit.record({organizationId:org,actorUserId:userId,action:'KIOSK_DEVICE_CREATE',resource:'kiosk_device',afterState:{branchId:b.branchId,name:s(b.name)}});
    return {key,warning:'Store this key securely; it is shown once.'};
  }

  async kioskCheckin(deviceKey: string, memberId: string, clientKey: string) {
    if (!deviceKey || !memberId) throw new BadRequestException('deviceKey and memberId are required');
    await this.rateLimit('kiosk-checkin', clientKey || 'unknown', 60, 60);
    const rows=await this.prisma.$queryRawUnsafe<any[]>('SELECT * FROM kiosk_devices WHERE key_hash=$1 AND active=true',hash(deviceKey));
    const d=rows[0]; if(!d) throw new BadRequestException('Invalid kiosk key');
    const member=await this.prisma.member.findFirst({where:{id:memberId,organizationId:d.organization_id,deletedAt:null},select:{id:true,firstName:true,lastName:true,primaryBranchId:true}});
    if(!member){ await this.prisma.$executeRawUnsafe("INSERT INTO kiosk_events(organization_id,branch_id,device_id,member_id,event_type,result) VALUES($1,$2,$3,$4,'CHECK_IN','DENIED')",d.organization_id,d.branch_id,d.id,memberId); return {allowed:false,reason:'member not found'}; }
    if(member.primaryBranchId!==d.branch_id){ await this.prisma.$executeRawUnsafe("INSERT INTO kiosk_events(organization_id,branch_id,device_id,member_id,event_type,result) VALUES($1,$2,$3,$4,'CHECK_IN','DENIED')",d.organization_id,d.branch_id,d.id,memberId); return {allowed:false,reason:'member is assigned to a different branch'}; }
    const decision=await this.attendance.evaluateGate(d.organization_id,memberId);
    const result=decision.allowed?'ALLOWED':'DENIED';
    await this.prisma.$executeRawUnsafe("INSERT INTO kiosk_events(organization_id,branch_id,device_id,member_id,event_type,result) VALUES($1,$2,$3,$4,'CHECK_IN',$5)",d.organization_id,d.branch_id,d.id,memberId,result);
    if(!decision.allowed) return {allowed:false,reason:decision.reason};
    return {allowed:true,member:{id:member.id,firstName:member.firstName,lastName:member.lastName}};
  }

}
