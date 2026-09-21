/* eslint-disable prettier/prettier */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';
import { DataService } from './data.service';
import { gunzipSync } from 'node:zlib';

type SourceRow = Record<string, string | null>;

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  return v ? v : null;
}

function normalizeName(value: string | null): string {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[\\u0300-\\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\\s+/g, ' ');
}

function splitName(value: string | null): { firstName: string; lastName: string } | null {
  const name = clean(value);
  if (!name) return null;
  const parts = name.split(/\\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || parts[0] };
}

function validPhone(value: string | null): string | null {
  const v = clean(value);
  return v && /^\\d{10}$/.test(v) ? v : null;
}

function validEmail(value: string | null): string | null {
  const v = clean(value)?.toLowerCase() ?? null;
  return v && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v) ? v : null;
}

function validDate(value: string | null, minYear = 1900, maxYear = new Date().getFullYear() + 1): Date | null {
  const v = clean(value);
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < minYear || year > maxYear) return null;
  return d;
}

function notesFor(row: SourceRow, code: string | null): string {
  const lines = [
    '[Imported from Customer Enquiry export]',
    code ? `Source Code: ${code}` : null,
    clean(row['Date of Enquiry']) ? `Date of Enquiry: ${row['Date of Enquiry']}` : null,
    clean(row['Conversion Date']) ? `Conversion Date: ${row['Conversion Date']}` : null,
    clean(row['Lead Type']) ? `Lead Type: ${row['Lead Type']}` : null,
    clean(row['Source of Promo']) ? `Source of Promo: ${row['Source of Promo']}` : null,
    clean(row['Employment Type']) ? `Employment Type: ${row['Employment Type']}` : null,
    clean(row['App Installed']) ? `App Installed: ${row['App Installed']}` : null,
    clean(row['Handled By']) ? `Handled By: ${row['Handled By']}` : null,
    clean(row['Reference No']) ? `Reference No: ${row['Reference No']}` : null,
    clean(row['Emergency Contact No']) ? `Emergency Contact No: ${row['Emergency Contact No']}` : null,
    clean(row['WhatsApp Numbers']) ? `WhatsApp Numbers: ${row['WhatsApp Numbers']}` : null,
    clean(row['Assigned Trainer']) ? `Source Assigned Trainer: ${row['Assigned Trainer']}` : null,
    clean(row['Notes']) ? `Source Notes: ${row['Notes']}` : null,
  ].filter(Boolean);
  return lines.join('\\n');
}

@Injectable()
export class CustomerEnquiryImportService implements OnModuleInit {
  private readonly logger = new Logger(CustomerEnquiryImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: PlatformBillingService,
    private readonly data: DataService,
  ) {}

  async onModuleInit() {
    const enabled = process.env.CUSTOMER_ENQUIRY_IMPORT_ENABLED === 'true';
    const payloadParts = Object.keys(process.env)
      .filter((key) => /^CUSTOMER_ENQUIRY_IMPORT_PAYLOAD_B64(?:_\\d+)?$/.test(key))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((key) => process.env[key])
      .filter((value): value is string => Boolean(value));
    const payload = payloadParts.join('');
    if (!enabled || !payload) return;

    // Fire-and-forget after Nest is ready. The operation is idempotent and
    // fails closed before any write when tenant/branch resolution is ambiguous.
    void this.run(payload).catch((error) => {
      this.logger.error(
        `Customer enquiry import failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async run(encoded: string) {
    const rows = JSON.parse(
      gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8'),
    ) as SourceRow[];

    if (!Array.isArray(rows) || rows.length !== 1342) {
      throw new Error(`Expected 1342 source rows, received ${rows?.length ?? 0}`);
    }

    const orgs = await this.prisma.organization.findMany({
      where: { name: { equals: '619 FITNESS STUDIO', mode: 'insensitive' }, deletedAt: null },
      select: { id: true, name: true },
    });
    if (orgs.length !== 1) {
      throw new Error(`Expected exactly one 619 FITNESS STUDIO organization, found ${orgs.length}`);
    }
    const organizationId = orgs[0].id;

    const branches = await this.prisma.branch.findMany({
      where: { organizationId, name: { equals: 'Main', mode: 'insensitive' }, deletedAt: null },
      select: { id: true, name: true },
    });
    if (branches.length !== 1) {
      throw new Error(`Expected exactly one Main branch, found ${branches.length}`);
    }
    const branchId = branches[0].id;

    const trainers = await this.prisma.staffProfile.findMany({
      where: { organizationId, isTrainer: true, user: { deletedAt: null } },
      select: {
        userId: true,
        branchId: true,
        user: { select: { firstName: true, lastName: true } },
      },
    });

    const trainerMap = new Map<string, string>();
    const ambiguous = new Set<string>();
    for (const trainer of trainers) {
      const key = normalizeName(`${trainer.user.firstName} ${trainer.user.lastName}`);
      if (!key) continue;
      if (trainerMap.has(key)) ambiguous.add(key);
      else trainerMap.set(key, trainer.userId);
    }
    for (const key of ambiguous) trainerMap.delete(key);

    const memberRows = rows.filter(
      (r) => clean(r['Membership Status']) !== 'Not assigned' && clean(r['Conversion Date']),
    );
    const leadRows = rows.filter(
      (r) => clean(r['Membership Status']) === 'Not assigned' && !clean(r['Conversion Date']),
    );

    if (memberRows.length !== 952 || leadRows.length !== 390) {
      throw new Error(
        `Source classification mismatch: members=${memberRows.length}, leads=${leadRows.length}`,
      );
    }

    const existingMembers = await this.prisma.member.findMany({
      where: { organizationId, deletedAt: null },
      select: { memberCode: true, phone: true, email: true },
    });
    const memberCodes = new Set(existingMembers.map((m) => m.memberCode).filter(Boolean));
    const memberPhones = new Set(existingMembers.map((m) => m.phone).filter(Boolean));
    const memberEmails = new Set(existingMembers.map((m) => m.email?.toLowerCase()).filter(Boolean));

    const memberData: any[] = [];
    const unmatchedTrainers: string[] = [];
    const invalidSourceRows: string[] = [];

    for (const row of memberRows) {
      const code = clean(row['Code']);
      const name = splitName(row['Name']);
      if (!code || !name) {
        invalidSourceRows.push(code ?? '<missing-code>');
        continue;
      }

      const phone = validPhone(row['Number']);
      const email = validEmail(row['Email']);
      if (memberCodes.has(code) || (phone && memberPhones.has(phone)) || (email && memberEmails.has(email))) {
        continue;
      }

      const trainerName = clean(row['Assigned Trainer']);
      const trainerId = trainerName ? trainerMap.get(normalizeName(trainerName)) ?? null : null;
      if (trainerName && !trainerId) unmatchedTrainers.push(`${code}:${trainerName}`);

      const gender = clean(row['Gender'])?.toUpperCase();
      const mappedGender =
        gender === 'MALE' ? 'MALE' :
        gender === 'FEMALE' ? 'FEMALE' :
        null;

      memberData.push({
        organizationId,
        primaryBranchId: branchId,
        memberCode: code,
        firstName: name.firstName,
        lastName: name.lastName,
        email,
        phone,
        dateOfBirth: validDate(row['DOB']),
        gender: mappedGender,
        addressLine1: clean(row['Address']),
        city: 'Kanpur',
        state: 'Uttar Pradesh',
        country: 'India',
        memberType: 'GYM',
        leadSource: clean(row['Source of Promo']),
        status: clean(row['Membership Status']) === 'Active' ? 'ACTIVE' : 'INACTIVE',
        assignedTrainerId: trainerId,
        notes: notesFor(row, code),
        joinedAt: validDate(row['Conversion Date']) ?? new Date(),
      });
      memberCodes.add(code);
      if (phone) memberPhones.add(phone);
      if (email) memberEmails.add(email);
    }

    const existingLeads = await this.prisma.lead.findMany({
      where: { organizationId },
      select: { phone: true, email: true, firstName: true, lastName: true, notes: true },
    });
    const leadKeys = new Set<string>();
    for (const l of existingLeads) {
      const sourceCode = l.notes?.match(/Source Code: ([^\\n]+)/)?.[1];
      if (sourceCode) leadKeys.add(`code:${sourceCode}`);
      if (l.phone) leadKeys.add(`phone:${l.phone}`);
      if (l.email) leadKeys.add(`email:${l.email.toLowerCase()}`);
    }

    const leadData: any[] = [];
    for (const row of leadRows) {
      const code = clean(row['Code']);
      const name = splitName(row['Name']);
      if (!code || !name) {
        invalidSourceRows.push(code ?? '<missing-code>');
        continue;
      }
      const phone = validPhone(row['Number']);
      const email = validEmail(row['Email']);
      if (
        leadKeys.has(`code:${code}`) ||
        (phone && leadKeys.has(`phone:${phone}`)) ||
        (email && leadKeys.has(`email:${email}`))
      ) continue;

      const trainerName = clean(row['Assigned Trainer']);
      const trainerId = trainerName ? trainerMap.get(normalizeName(trainerName)) ?? null : null;
      if (trainerName && !trainerId) unmatchedTrainers.push(`${code}:${trainerName}`);

      leadData.push({
        organizationId,
        branchId,
        firstName: name.firstName,
        lastName: name.lastName,
        email,
        phone,
        source: clean(row['Source of Promo']) ?? clean(row['Lead Type']),
        status: 'NEW',
        notes: notesFor(row, code),
        createdAt: validDate(row['Date of Enquiry']) ?? new Date(),
      });
      leadKeys.add(`code:${code}`);
      if (phone) leadKeys.add(`phone:${phone}`);
      if (email) leadKeys.add(`email:${email}`);
    }

    if (invalidSourceRows.length) {
      throw new Error(`Invalid required source rows: ${invalidSourceRows.join(', ')}`);
    }

    await this.prisma.member.createMany({ data: memberData, skipDuplicates: true });
    await this.prisma.lead.createMany({ data: leadData, skipDuplicates: true });

    const finalMembers = await this.prisma.member.count({
      where: { organizationId, primaryBranchId: branchId, memberCode: { in: memberData.map((m) => m.memberCode) } },
    });
    const finalLeads = await this.prisma.lead.count({
      where: { organizationId, branchId, notes: { contains: '[Imported from Customer Enquiry export]' } },
    });

    this.logger.log(
      `Customer enquiry import complete: source=1342, classifiedMembers=952, classifiedLeads=390, memberRowsWritten=${memberData.length}, leadRowsWritten=${leadData.length}, verifiedMembers=${finalMembers}, verifiedLeads=${finalLeads}, unmatchedTrainers=${unmatchedTrainers.length}`,
    );
    if (unmatchedTrainers.length) {
      this.logger.warn(`Trainer assignments intentionally left null: ${unmatchedTrainers.join(', ')}`);
    }

    // Billing is injected so the import module remains compatible with the
    // existing DataModule dependency graph; no billing charge is performed.
    void this.billing;
    void this.data;
  }
}
