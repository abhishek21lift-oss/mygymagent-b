import { BadRequestException, Injectable } from '@nestjs/common';
import { Gender, MemberStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';

const ALLOWED_MEMBER_STATUSES = new Set(['ACTIVE', 'INACTIVE']);

const ALLOWED_GENDERS = new Set(['MALE', 'FEMALE', 'OTHER']);

@Injectable()
export class DataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: PlatformBillingService,
  ) {}

  async exportMembers(org: string) {
    const rows = await this.prisma.member.findMany({
      where: { organizationId: org, deletedAt: null },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
    const headers = [
      'id',
      'firstName',
      'lastName',
      'email',
      'phone',
      'dateOfBirth',
      'gender',
      'status',
      'primaryBranchId',
      'assignedTrainerId',
      'createdAt',
    ];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csvRows = rows.map((m) =>
      headers.map((h) => esc((m as any)[h])).join(','),
    );
    return [headers.join(','), ...csvRows].join(String.fromCharCode(10));
  }

  private async defaultBranch(org: string) {
    const branch = await this.prisma.branch.findFirst({
      where: { organizationId: org },
      orderBy: { createdAt: 'asc' },
    });
    if (!branch) {
      throw new BadRequestException(
        'Organization has no branch for imported members',
      );
    }
    return branch.id;
  }

  async importMembers(org: string, rows: Record<string, string>[]) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('No member rows supplied');
    }
    if (rows.length > 2000) {
      throw new BadRequestException(
        'Import is limited to 2,000 rows per request',
      );
    }

    let created = 0;
    let skipped = 0;
    const errors: Array<{ row: number; message: string }> = [];
    const defaultBranchId = await this.defaultBranch(org);
    const existingEmails = new Set(
      (
        await this.prisma.member.findMany({
          where: { organizationId: org, deletedAt: null, email: { not: null } },
          select: { email: true },
        })
      )
        .map((m) => m.email?.toLowerCase())
        .filter(Boolean),
    );
    const existingPhones = new Set(
      (
        await this.prisma.member.findMany({
          where: { organizationId: org, deletedAt: null, phone: { not: null } },
          select: { phone: true },
        })
      )
        .map((m) => m.phone)
        .filter(Boolean),
    );

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.firstName || !r.lastName) {
        errors.push({
          row: i + 1,
          message: 'firstName and lastName are required',
        });
        continue;
      }

      try {
        const email = r.email?.trim() || null;
        const phone = r.phone?.trim() || null;
        const status = (
          r.status?.trim() || 'ACTIVE'
        ).toUpperCase() as MemberStatus;
        if (!ALLOWED_MEMBER_STATUSES.has(status)) {
          errors.push({
            row: i + 1,
            message: `Invalid status "${r.status}" (expected ACTIVE or INACTIVE)`,
          });
          continue;
        }
        const genderRaw = r.gender?.trim().toUpperCase() || null;
        if (genderRaw && !ALLOWED_GENDERS.has(genderRaw)) {
          errors.push({
            row: i + 1,
            message: `Invalid gender "${r.gender}" (expected MALE, FEMALE, or OTHER)`,
          });
          continue;
        }

        const emailKey = email?.toLowerCase() ?? null;
        const duplicate =
          (emailKey && existingEmails.has(emailKey)) ||
          (phone && existingPhones.has(phone));
        if (duplicate) {
          skipped++;
          continue;
        }

        const fallbackBranchId = r.primaryBranchId?.trim() || defaultBranchId;

        await this.prisma.member.create({
          data: {
            organizationId: org,
            memberCode: r.memberCode?.trim() || `IMP-${Date.now()}-${i + 1}`,
            primaryBranchId: fallbackBranchId,
            firstName: r.firstName.trim(),
            lastName: r.lastName.trim(),
            email,
            phone,
            dateOfBirth: r.dateOfBirth ? new Date(r.dateOfBirth) : null,
            gender: genderRaw as Gender | null,
            status,
            assignedTrainerId: r.assignedTrainerId?.trim() || null,
          },
        });
        if (emailKey) existingEmails.add(emailKey);
        if (phone) existingPhones.add(phone);
        created++;
      } catch (e) {
        errors.push({
          row: i + 1,
          message: e instanceof Error ? e.message : 'Import failed',
        });
      }
    }

    return { total: rows.length, created, skipped, errors };
  }
}
