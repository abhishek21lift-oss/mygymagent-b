import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type {
  CreatePayrollPeriodDto,
  GenerateCommissionsDto,
  UpsertCommissionRuleDto,
} from './dto/payroll.dto';

@Injectable()
export class PayrollService {
  constructor(private readonly prisma: PrismaService) {}

  rules(org: string) {
    return this.prisma.$queryRawUnsafe(
      `SELECT * FROM trainer_commission_rules WHERE "organizationId"=$1 ORDER BY "createdAt" DESC`,
      org,
    );
  }

  async upsertRule(org: string, dto: UpsertCommissionRuleDto) {
    const existing = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM trainer_commission_rules WHERE "organizationId"=$1 AND "trainerId"=$2 AND COALESCE("sessionType",'')=COALESCE($3,'') LIMIT 1`,
      org,
      dto.trainerId,
      dto.sessionType ?? null,
    );
    if (existing[0]) {
      return this.updateRule(org, existing[0].id, dto);
    }

    return this.prisma.$queryRawUnsafe(
      `INSERT INTO trainer_commission_rules (id,"organizationId","trainerId","percentage","fixedAmount","sessionType","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,now(),now()) RETURNING *`,
      org,
      dto.trainerId,
      dto.percentage,
      dto.fixedAmount ?? 0,
      dto.sessionType ?? null,
    );
  }

  async updateRule(
    org: string,
    id: string,
    dto: Partial<UpsertCommissionRuleDto>,
  ) {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `UPDATE trainer_commission_rules SET "percentage"=COALESCE($3,"percentage"),"fixedAmount"=COALESCE($4,"fixedAmount"),"sessionType"=COALESCE($5,"sessionType"),"updatedAt"=now() WHERE id=$1 AND "organizationId"=$2 RETURNING *`,
      id,
      org,
      dto.percentage ?? null,
      dto.fixedAmount ?? null,
      dto.sessionType ?? null,
    );
    if (!rows[0]) {
      throw new NotFoundException('Commission rule not found');
    }
    return rows[0];
  }

  commissions(
    org: string,
    from?: string,
    to?: string,
    trainerId?: string,
  ) {
    return this.prisma.$queryRawUnsafe(
      `SELECT c.*, concat(u."firstName",' ',u."lastName") AS "trainerName" FROM trainer_commissions c LEFT JOIN staff_profiles sp ON sp.id=c."trainerId" LEFT JOIN users u ON u.id=sp."userId" WHERE c."organizationId"=$1 AND ($2::timestamptz IS NULL OR c."sessionAt">=$2) AND ($3::timestamptz IS NULL OR c."sessionAt"<$3) AND ($4::text IS NULL OR c."trainerId"=$4) ORDER BY c."sessionAt" DESC`,
      org,
      from ?? null,
      to ?? null,
      trainerId ?? null,
    );
  }

  async generateCommissions(org: string, dto: GenerateCommissionsDto) {
    const sessions = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT s.id,s."trainerId",s."startTime",COALESCE(s.price,0) AS price,s.type FROM pt_sessions s WHERE s."organizationId"=$1 AND s.status='COMPLETED' AND s."startTime">=$2 AND s."startTime"<$3 AND s."trainerId" IS NOT NULL`,
      org,
      dto.from,
      dto.to,
    );
    let created = 0;

    for (const s of sessions) {
      const existing = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT id FROM trainer_commissions WHERE "organizationId"=$1 AND "ptSessionId"=$2 LIMIT 1`,
        org,
        s.id,
      );
      if (existing[0]) {
        continue;
      }

      const rules = await this.prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM trainer_commission_rules WHERE "organizationId"=$1 AND "trainerId"=$2 AND (COALESCE("sessionType",'')='' OR "sessionType"=$3) ORDER BY CASE WHEN "sessionType"=$3 THEN 0 ELSE 1 END LIMIT 1`,
        org,
        s.trainerId,
        s.type,
      );
      const rule = rules[0];
      if (!rule) {
        continue;
      }

      const amount =
        (Number(s.price) * Number(rule.percentage)) / 100 +
        Number(rule.fixedAmount || 0);
      await this.prisma.$queryRawUnsafe(
        `INSERT INTO trainer_commissions (id,"organizationId","trainerId","ptSessionId","sessionAt","baseAmount","rate","commissionAmount","status","createdAt","updatedAt")
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'PENDING',now(),now())`,
        org,
        s.trainerId,
        s.id,
        s.startTime,
        s.price,
        rule.percentage,
        amount,
      );
      created++;
    }

    return { scanned: sessions.length, created };
  }

  periods(org: string) {
    return this.prisma.$queryRawUnsafe(
      `SELECT * FROM payroll_periods WHERE "organizationId"=$1 ORDER BY "startDate" DESC`,
      org,
    );
  }

  createPeriod(org: string, dto: CreatePayrollPeriodDto) {
    if (new Date(dto.endDate) <= new Date(dto.startDate)) {
      throw new BadRequestException('End date must be after start date');
    }

    return this.prisma.$queryRawUnsafe(
      `INSERT INTO payroll_periods (id,"organizationId","startDate","endDate","status","notes","createdAt","updatedAt")
       VALUES (gen_random_uuid(),$1,$2,$3,'OPEN',$4,now(),now()) RETURNING *`,
      org,
      dto.startDate,
      dto.endDate,
      dto.notes ?? null,
    );
  }

  async finalize(org: string, id: string) {
    const period = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM payroll_periods WHERE id=$1 AND "organizationId"=$2`,
      id,
      org,
    );
    if (!period[0]) {
      throw new NotFoundException('Payroll period not found');
    }
    if (period[0].status !== 'OPEN') {
      throw new BadRequestException('Payroll period is not open');
    }

    await this.prisma.$executeRawUnsafe(
      `UPDATE trainer_commissions SET status='APPROVED', "updatedAt"=now() WHERE "organizationId"=$1 AND "sessionAt">=$2 AND "sessionAt"<$3 AND status='PENDING'`,
      org,
      period[0].startDate,
      period[0].endDate,
    );

    return this.prisma.$queryRawUnsafe(
      `UPDATE payroll_periods SET status='FINALIZED',"updatedAt"=now() WHERE id=$1 AND "organizationId"=$2 RETURNING *`,
      id,
      org,
    );
  }

  summary(org: string, from?: string, to?: string) {
    return this.prisma.$queryRawUnsafe(
      `SELECT "trainerId",SUM("baseAmount") AS "baseAmount",SUM("commissionAmount") AS "commissionAmount",COUNT(*)::int AS "sessions" FROM trainer_commissions WHERE "organizationId"=$1 AND ($2::timestamptz IS NULL OR "sessionAt">=$2) AND ($3::timestamptz IS NULL OR "sessionAt"<$3) GROUP BY "trainerId" ORDER BY "commissionAmount" DESC`,
      org,
      from ?? null,
      to ?? null,
    );
  }
}
