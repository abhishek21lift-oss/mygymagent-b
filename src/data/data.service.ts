import { BadRequestException, Injectable } from '@nestjs/common';
import { Gender, MemberStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';
import { TenantReferenceValidator } from '../common/validators/tenant-reference.validator';
import type { ImportMemberRowDto } from './dto/import-members.dto';

const ALLOWED_MEMBER_STATUSES = new Set(['ACTIVE', 'INACTIVE']);

const ALLOWED_GENDERS = new Set(['MALE', 'FEMALE', 'OTHER']);

/**
 * Rows are created in parallel chunks of this size. A 2,000-row import
 * used to issue its creates one at a time (~3 sequential queries per
 * row once the reference validation is counted); chunking keeps the
 * database busy without turning one failing row into a burst that
 * swamps the connection pool.
 */
const IMPORT_CHUNK = 20;

/** Rows per export page. See `exportMemberChunks` for why it pages. */
const EXPORT_CHUNK = 500;

interface ImportCandidate {
  rowNumber: number;
  memberCode: string;
  primaryBranchId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: Date | null;
  gender: Gender | null;
  status: MemberStatus;
  assignedTrainerId: string | null;
}

@Injectable()
export class DataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: PlatformBillingService,
    private readonly references: TenantReferenceValidator,
  ) {}

  /**
   * Streams the org's members as CSV, one page of rows at a time.
   *
   * The export used to load the entire member table into memory and
   * build one string, so a 100k-member org allocated the whole CSV
   * before the first byte left the server. Now it pages with a cursor
   * (`id` is the tiebreaker: name ordering alone is not stable, and an
   * unstable cursor skips or repeats rows across pages) and the
   * controller writes each chunk as it arrives.
   */
  async *exportMemberChunks(org: string): AsyncGenerator<string> {
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
    yield headers.join(',') + '\n';

    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.member.findMany({
        where: { organizationId: org, deletedAt: null },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }, { id: 'asc' }],
        take: EXPORT_CHUNK,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          dateOfBirth: true,
          gender: true,
          status: true,
          primaryBranchId: true,
          assignedTrainerId: true,
          createdAt: true,
        },
      });
      if (rows.length === 0) return;
      cursor = rows[rows.length - 1].id;

      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      yield rows
        .map((m) => headers.map((h) => esc((m as any)[h])).join(','))
        .join('\n') + '\n';
      if (rows.length < EXPORT_CHUNK) return;
    }
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

  /**
   * Imports CSV member rows with the established per-row contract: a bad
   * row is rejected into `errors` and the rest of the file still
   * imports.
   *
   * Three phases, because the per-row loop used to run the tenant
   * reference check for EVERY row (two queries) and the create for every
   * row, all sequentially -- a full 2,000-row import issued ~6,000
   * sequential queries inside one HTTP request.
   *
   * Phase 1 validates synchronously and dedupes in-batch, so the rows
   * that reach phase 3 are exactly the rows that will be created.
   * Phase 2 validates the DISTINCT (branch, trainer) pairs once each --
   * almost always a handful -- instead of once per row.
   * Phase 3 creates in parallel chunks.
   *
   * One documented divergence from the sequential version: an in-file
   * duplicate of a row that later fails at the database stays counted
   * as `skipped` instead of being attempted (and failing) a second
   * time. The sequential version only learned about a create failure
   * after it had already passed the duplicate check.
   */
  async importMembers(org: string, rows: ImportMemberRowDto[]) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('No member rows supplied');
    }
    if (rows.length > 2000) {
      throw new BadRequestException(
        'Import is limited to 2,000 rows per request',
      );
    }

    const errors: Array<{ row: number; message: string }> = [];
    let skipped = 0;
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

    // Phase 1 -- every check that needs no database, in row order.
    const candidates: ImportCandidate[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const rowNumber = i + 1;
      if (!r.firstName || !r.lastName) {
        errors.push({
          row: rowNumber,
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
            row: rowNumber,
            message: `Invalid status "${r.status}" (expected ACTIVE or INACTIVE)`,
          });
          continue;
        }
        const genderRaw = r.gender?.trim().toUpperCase() || null;
        if (genderRaw && !ALLOWED_GENDERS.has(genderRaw)) {
          errors.push({
            row: rowNumber,
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
        // Claimed before the create: two rows in one file with the same
        // email are one member, whichever row number comes first.
        if (emailKey) existingEmails.add(emailKey);
        if (phone) existingPhones.add(phone);

        const fallbackBranchId = r.primaryBranchId?.trim() || defaultBranchId;
        candidates.push({
          rowNumber,
          memberCode: r.memberCode?.trim() || `IMP-${Date.now()}-${rowNumber}`,
          primaryBranchId: fallbackBranchId,
          firstName: r.firstName.trim(),
          lastName: r.lastName.trim(),
          email,
          phone,
          dateOfBirth: r.dateOfBirth ? new Date(r.dateOfBirth) : null,
          gender: genderRaw as Gender | null,
          status,
          assignedTrainerId: r.assignedTrainerId?.trim() || null,
        });
      } catch (e) {
        errors.push({
          row: rowNumber,
          message: e instanceof Error ? e.message : 'Import failed',
        });
      }
    }

    // Phase 2 -- tenant ownership of the supplied branch/trainer ids,
    // once per DISTINCT pair, in first-appearance order.
    //
    // The uploaded file names its own branch and trainer by id, and
    // neither column carries a same-organization constraint, so without
    // this a row could point at another gym's branch or staff member.
    // The member profile then renders that branch's name and that
    // trainer's full name back to the importing org.
    const pairProblems = new Map<string, string[]>();
    for (const c of candidates) {
      const pairKey = `${c.primaryBranchId}|${c.assignedTrainerId ?? ''}`;
      if (pairProblems.has(pairKey)) continue;
      pairProblems.set(
        pairKey,
        await this.references.checkMemberReferences(org, {
          primaryBranchId: c.primaryBranchId,
          assignedTrainerId: c.assignedTrainerId,
        }),
      );
    }

    const creatable = candidates.filter((c) => {
      const problems =
        pairProblems.get(`${c.primaryBranchId}|${c.assignedTrainerId ?? ''}`) ??
        [];
      if (problems.length > 0) {
        errors.push({ row: c.rowNumber, message: problems.join('; ') });
        return false;
      }
      return true;
    });

    // Phase 3 -- parallel creates in chunks.
    const createErrors: Array<{ row: number; message: string }> = [];
    let created = 0;
    for (let i = 0; i < creatable.length; i += IMPORT_CHUNK) {
      const chunk = creatable.slice(i, i + IMPORT_CHUNK);
      const results = await Promise.all(
        chunk.map(async (c) => {
          try {
            await this.prisma.member.create({
              data: {
                organizationId: org,
                memberCode: c.memberCode,
                primaryBranchId: c.primaryBranchId,
                firstName: c.firstName,
                lastName: c.lastName,
                email: c.email,
                phone: c.phone,
                dateOfBirth: c.dateOfBirth,
                gender: c.gender,
                status: c.status,
                assignedTrainerId: c.assignedTrainerId,
              },
            });
            return null;
          } catch (e) {
            return {
              row: c.rowNumber,
              message: e instanceof Error ? e.message : 'Import failed',
            };
          }
        }),
      );
      for (const error of results) {
        if (error) createErrors.push(error);
        else created++;
      }
    }

    return {
      total: rows.length,
      created,
      skipped,
      errors: [...errors, ...createErrors].sort((a, b) => a.row - b.row),
    };
  }
}
