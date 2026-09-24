import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  classifyRow,
  clean,
  meaningful,
  mapGender,
  normalizeName,
  parseDayFirstDate,
  phoneKey,
  sourceNotes,
  splitName,
  toE164,
  validEmail,
  type EnquiryRow,
} from './customer-enquiry-mapping';

const MAX_ROWS = 5000;

export interface CustomerEnquiryImportOptions {
  /** Nothing is written. The report is identical either way, so the run
   * that decides is the same code as the run that commits. */
  dryRun?: boolean;
  /** Defaults to the organization's only branch. */
  branchId?: string;
}

export interface CustomerEnquiryImportReport {
  dryRun: boolean;
  branchId: string;
  sourceRows: number;
  classified: { members: number; leads: number; ambiguous: number };
  members: { toCreate: number; alreadyPresent: number; created: number };
  leads: { toCreate: number; alreadyPresent: number; created: number };
  trainers: { matched: number; backfilled: number; unmatched: string[] };
  warnings: {
    /** Rows whose join date could not be read and which therefore have
     * no `joinedAt` from the source. Previously these silently became
     * the moment of import. */
    unparseableJoinDate: string[];
    unparseableDateOfBirth: string[];
    missingPhone: string[];
    phoneDisagreement: string[];
    singleWordName: string[];
    /** Members the gym calls ACTIVE. The export carries no plan, price
     * or end date, so no Membership row can honestly be created for
     * them -- see the note in the service. */
    activeWithoutMembership: number;
  };
}

/**
 * Imports a "Customer Enquiry" export into members and leads.
 *
 * This used to run from `onModuleInit` against a gzipped base64 blob in
 * an environment variable, with the row counts of one particular file
 * (1342/952/390) hard-coded as assertions. It had been throwing
 * `incorrect header check` on every boot for at least a week, so
 * nothing had ever been imported -- and because it was a fire-and-forget
 * promise, the only sign was one error line per restart.
 *
 * It is a route now, with a dry run, and it reports what it did rather
 * than logging it. The counts are not asserted: a different export is a
 * different number of rows, not a failure.
 *
 * What it will not do is invent data. The export says whether a member
 * is active but not what they bought, for how much, or until when, so
 * no `Membership` row is created. Fabricating an end date would put
 * renewal reminders in front of real people on a date nobody chose.
 * The report says how many members this affects.
 */
@Injectable()
export class CustomerEnquiryImportService {
  private readonly logger = new Logger(CustomerEnquiryImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  async import(
    organizationId: string,
    rows: EnquiryRow[],
    options: CustomerEnquiryImportOptions = {},
  ): Promise<CustomerEnquiryImportReport> {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('No rows supplied');
    }
    if (rows.length > MAX_ROWS) {
      throw new BadRequestException(
        `Import is limited to ${MAX_ROWS} rows per request`,
      );
    }

    const dryRun = options.dryRun ?? false;
    const branchId = await this.resolveBranch(organizationId, options.branchId);
    const trainerMap = await this.trainerMap(organizationId);

    const report: CustomerEnquiryImportReport = {
      dryRun,
      branchId,
      sourceRows: rows.length,
      classified: { members: 0, leads: 0, ambiguous: 0 },
      members: { toCreate: 0, alreadyPresent: 0, created: 0 },
      leads: { toCreate: 0, alreadyPresent: 0, created: 0 },
      trainers: { matched: 0, backfilled: 0, unmatched: [] },
      warnings: {
        unparseableJoinDate: [],
        unparseableDateOfBirth: [],
        missingPhone: [],
        phoneDisagreement: [],
        singleWordName: [],
        activeWithoutMembership: 0,
      },
    };

    const existingMembers = await this.prisma.member.findMany({
      where: { organizationId, deletedAt: null },
      select: {
        id: true,
        memberCode: true,
        phone: true,
        email: true,
        assignedTrainerId: true,
      },
    });
    const memberByCode = new Map(
      existingMembers.filter((m) => m.memberCode).map((m) => [m.memberCode, m]),
    );
    const memberPhones = new Set(
      existingMembers.map((m) => phoneKey(m.phone)).filter(Boolean) as string[],
    );
    const memberEmails = new Set(
      existingMembers
        .map((m) => m.email?.toLowerCase())
        .filter(Boolean) as string[],
    );

    const existingLeads = await this.prisma.lead.findMany({
      where: { organizationId },
      select: { phone: true, email: true, notes: true },
    });
    const leadKeys = new Set<string>();
    for (const lead of existingLeads) {
      const sourceCode = lead.notes?.match(/Source Code: ([^\n]+)/)?.[1];
      if (sourceCode) leadKeys.add(`code:${sourceCode}`);
      const key = phoneKey(lead.phone);
      if (key) leadKeys.add(`phone:${key}`);
      if (lead.email) leadKeys.add(`email:${lead.email.toLowerCase()}`);
    }

    const memberData: Prisma.MemberCreateManyInput[] = [];
    const leadData: Prisma.LeadCreateManyInput[] = [];
    const trainerBackfill: Array<{ id: string; assignedTrainerId: string }> =
      [];
    const unmatchedTrainers = new Set<string>();

    for (const row of rows) {
      const kind = classifyRow(row);
      if (kind === 'ambiguous') {
        report.classified.ambiguous += 1;
        continue;
      }
      const code = clean(row['Code']);
      const name = splitName(row['Name']);
      if (!code || !name) {
        throw new BadRequestException(
          `Row ${code ?? '<missing Code>'} has no usable Code or Name`,
        );
      }
      if (name.singleWord) report.warnings.singleWordName.push(code);

      const { phone, disagreement } = toE164(
        row['Number'],
        row['WhatsApp Numbers'],
      );
      if (!phone) report.warnings.missingPhone.push(code);
      if (disagreement)
        report.warnings.phoneDisagreement.push(`${code}: ${disagreement}`);

      const email = validEmail(row['Email']);
      const trainerName = meaningful(row['Assigned Trainer']);
      const trainerId = trainerName
        ? (trainerMap.get(normalizeName(trainerName)) ?? null)
        : null;
      if (trainerName && !trainerId) {
        unmatchedTrainers.add(trainerName);
      } else if (trainerId) {
        report.trainers.matched += 1;
      }

      if (kind === 'member') {
        report.classified.members += 1;
        const existing = memberByCode.get(code);
        const key = phoneKey(phone);
        if (
          existing ||
          (key && memberPhones.has(key)) ||
          (email && memberEmails.has(email))
        ) {
          report.members.alreadyPresent += 1;
          // A re-run after the gym creates the trainers it was missing
          // should attach them, rather than the assignment being lost
          // for good because the member row already exists.
          if (existing && !existing.assignedTrainerId && trainerId) {
            trainerBackfill.push({
              id: existing.id,
              assignedTrainerId: trainerId,
            });
          }
          continue;
        }

        const joinedAt = parseDayFirstDate(row['Conversion Date']);
        if (!joinedAt && clean(row['Conversion Date'])) {
          report.warnings.unparseableJoinDate.push(
            `${code}: ${clean(row['Conversion Date'])}`,
          );
        }
        const dateOfBirth = parseDayFirstDate(row['DOB']);
        if (!dateOfBirth && clean(row['DOB'])) {
          report.warnings.unparseableDateOfBirth.push(
            `${code}: ${clean(row['DOB'])}`,
          );
        }

        const status =
          clean(row['Membership Status']) === 'Active' ? 'ACTIVE' : 'INACTIVE';
        if (status === 'ACTIVE') report.warnings.activeWithoutMembership += 1;

        memberData.push({
          organizationId,
          primaryBranchId: branchId,
          memberCode: code,
          firstName: name.firstName,
          lastName: name.lastName,
          email,
          phone,
          dateOfBirth,
          gender: mapGender(row['Gender']),
          // Only what the row actually says. The previous version
          // stamped every member as Kanpur / Uttar Pradesh / India,
          // including the one whose note reads "LIVE IN DELHI".
          addressLine1: meaningful(row['Address']),
          memberType: 'GYM',
          leadSource: meaningful(row['Source of Promo']),
          status,
          assignedTrainerId: trainerId,
          notes: sourceNotes(row, code),
          // Left to the column default when the source has no readable
          // date, so "we do not know" is not recorded as "joined today".
          ...(joinedAt ? { joinedAt } : {}),
        });
        memberByCode.set(code, {
          id: '',
          memberCode: code,
          phone,
          email,
          assignedTrainerId: trainerId,
        });
        if (key) memberPhones.add(key);
        if (email) memberEmails.add(email);
        continue;
      }

      report.classified.leads += 1;
      const key = phoneKey(phone);
      if (
        leadKeys.has(`code:${code}`) ||
        (key && leadKeys.has(`phone:${key}`)) ||
        (email && leadKeys.has(`email:${email}`))
      ) {
        report.leads.alreadyPresent += 1;
        continue;
      }
      const enquiredAt = parseDayFirstDate(row['Date of Enquiry']);
      leadData.push({
        organizationId,
        branchId,
        firstName: name.firstName,
        lastName: name.lastName,
        email,
        phone,
        source:
          meaningful(row['Source of Promo']) ?? meaningful(row['Lead Type']),
        status: 'NEW',
        notes: sourceNotes(row, code),
        ...(enquiredAt ? { createdAt: enquiredAt } : {}),
        assignedToUserId: trainerId,
      });
      leadKeys.add(`code:${code}`);
      if (key) leadKeys.add(`phone:${key}`);
      if (email) leadKeys.add(`email:${email}`);
    }

    report.members.toCreate = memberData.length;
    report.leads.toCreate = leadData.length;
    report.trainers.unmatched = [...unmatchedTrainers].sort();

    if (dryRun) return report;

    // Members and leads land together or not at all: a half-applied
    // import is worse than none, because the second attempt would see
    // the first half as "already present" and skip it.
    await this.prisma.$transaction(async (tx) => {
      if (memberData.length) {
        const created = await tx.member.createMany({
          data: memberData,
          skipDuplicates: true,
        });
        report.members.created = created.count;
      }
      if (leadData.length) {
        const created = await tx.lead.createMany({
          data: leadData,
          skipDuplicates: true,
        });
        report.leads.created = created.count;
      }
      for (const patch of trainerBackfill) {
        await tx.member.update({
          where: { id: patch.id },
          data: { assignedTrainerId: patch.assignedTrainerId },
        });
      }
      report.trainers.backfilled = trainerBackfill.length;
    });

    this.logger.log(
      `Customer enquiry import: rows=${report.sourceRows} membersCreated=${report.members.created} leadsCreated=${report.leads.created} trainersBackfilled=${report.trainers.backfilled} unmatchedTrainers=${report.trainers.unmatched.length}`,
    );
    return report;
  }

  private async resolveBranch(organizationId: string, requested?: string) {
    if (requested) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: requested, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!branch) throw new BadRequestException('Unknown branch');
      return branch.id;
    }
    const branches = await this.prisma.branch.findMany({
      where: { organizationId, deletedAt: null },
      select: { id: true },
      take: 2,
    });
    if (branches.length === 0) {
      throw new BadRequestException(
        'This organization has no branch to import into',
      );
    }
    if (branches.length > 1) {
      throw new BadRequestException(
        'This organization has more than one branch -- pass branchId to say which one these members belong to',
      );
    }
    return branches[0].id;
  }

  /** Trainers by normalized name. A name that matches two trainers
   * matches neither: guessing which one would attach real members to
   * the wrong person. */
  private async trainerMap(organizationId: string) {
    const trainers = await this.prisma.staffProfile.findMany({
      where: { organizationId, isTrainer: true, user: { deletedAt: null } },
      select: {
        userId: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });
    const map = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const trainer of trainers) {
      const key = normalizeName(
        `${trainer.user.firstName} ${trainer.user.lastName}`,
      );
      if (!key) continue;
      if (map.has(key)) ambiguous.add(key);
      else map.set(key, trainer.userId);
    }
    for (const key of ambiguous) map.delete(key);
    return map;
  }
}
