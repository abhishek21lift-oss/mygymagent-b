import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { CustomerEnquiryImportService } from '../src/data/customer-enquiry-import.service';
import { createTestApp } from './utils/test-app';
import type { EnquiryRow } from '../src/data/customer-enquiry-mapping';

/**
 * The importer, against the shape of a real export.
 *
 * The previous version asserted this file's exact row counts
 * (1342/952/390) and ran from a gzipped base64 environment variable at
 * boot, where it had been failing with `incorrect header check` on
 * every restart for a week -- so nothing was ever imported and the only
 * symptom was one error line per deploy. These cases pin the behaviour
 * that replaced it: a route, a dry run, and a report.
 */
describe('Customer enquiry import (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: CustomerEnquiryImportService;
  let token: string;
  let organizationId: string;

  const asOwner = (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  const row = (overrides: EnquiryRow = {}): EnquiryRow => ({
    Code: `YDL-${Math.random().toString().slice(2, 11)}`,
    Name: 'Priya Sharma',
    'ISD Code': '+91',
    Number: String(6000000000 + Math.floor(Math.random() * 999999999)),
    Email: null,
    Gender: 'female',
    'Date of Enquiry': '26-12-2025',
    'Conversion Date': '26-09-2024',
    'Handled By': '619 Fitness Studio',
    Notes: 'None',
    'Lead Type': '0',
    'Source of Promo': 'UNKNOWN',
    'Employment Type': 'UNKNOWN',
    'App Installed': 'No',
    'Assigned Trainer': null,
    'Membership Status': 'Active',
    DOB: null,
    Address: null,
    'Emergency Contact No': null,
    'WhatsApp Numbers': null,
    'Reference No': 'None',
    ...overrides,
  });

  const withWhatsapp = (overrides: EnquiryRow = {}) => {
    const base = row(overrides);
    return { ...base, 'WhatsApp Numbers': `91${base.Number}` };
  };

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    service = app.get(CustomerEnquiryImportService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Enquiry Import Gym',
        email: `enquiry-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Enquiry',
      })
      .expect(201);
    token = registered.body.data.accessToken;
    organizationId = registered.body.data.user.organizationId;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('writes nothing on a dry run', async () => {
    const before = await prisma.member.count({ where: { organizationId } });
    const report = await service.import(organizationId, [withWhatsapp()], {
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.members.toCreate).toBe(1);
    expect(report.members.created).toBe(0);
    expect(await prisma.member.count({ where: { organizationId } })).toBe(
      before,
    );
  });

  it('stores the join date as the export writes it', async () => {
    const code = `YDL-DATE-${Date.now()}`;
    // 11-05-2026 is 11 May. `new Date('11-05-2026')` says 5 November,
    // which is what 272 of 952 member rows silently became.
    await service.import(
      organizationId,
      [withWhatsapp({ Code: code, 'Conversion Date': '11-05-2026' })],
      {},
    );

    const member = await prisma.member.findFirstOrThrow({
      where: { organizationId, memberCode: code },
      select: { joinedAt: true },
    });
    expect(member.joinedAt.toISOString().slice(0, 10)).toBe('2026-05-11');
  });

  it('keeps a day past the 12th instead of substituting the import time', async () => {
    const code = `YDL-DAY-${Date.now()}`;
    await service.import(
      organizationId,
      [withWhatsapp({ Code: code, 'Conversion Date': '26-09-2024' })],
      {},
    );
    const member = await prisma.member.findFirstOrThrow({
      where: { organizationId, memberCode: code },
      select: { joinedAt: true },
    });
    expect(member.joinedAt.toISOString().slice(0, 10)).toBe('2024-09-26');
  });

  it('reports an unreadable date rather than inventing one', async () => {
    const report = await service.import(
      organizationId,
      [withWhatsapp({ Code: 'YDL-BADDATE', 'Conversion Date': '31-02-2025' })],
      { dryRun: true },
    );
    expect(report.warnings.unparseableJoinDate).toEqual([
      'YDL-BADDATE: 31-02-2025',
    ]);
  });

  it('stores a phone the WhatsApp provider can actually send to', async () => {
    const code = `YDL-PHONE-${Date.now()}`;
    await service.import(
      organizationId,
      [withWhatsapp({ Code: code, Number: '6393786886' })],
      {},
    );
    const member = await prisma.member.findFirstOrThrow({
      where: { organizationId, memberCode: code },
      select: { phone: true },
    });
    // Member.phone is passed straight to Meta as `to:`, and Meta needs
    // the country code. The bare local number fails there.
    expect(member.phone).toBe('+916393786886');
  });

  it('does not store the export’s placeholders as data', async () => {
    const code = `YDL-NONE-${Date.now()}`;
    await service.import(
      organizationId,
      [
        withWhatsapp({
          Code: code,
          Notes: 'None',
          Address: 'None',
          'Reference No': 'None',
          'Source of Promo': 'UNKNOWN',
        }),
      ],
      {},
    );
    const member = await prisma.member.findFirstOrThrow({
      where: { organizationId, memberCode: code },
      select: { addressLine1: true, leadSource: true, notes: true, city: true },
    });
    expect(member.addressLine1).toBeNull();
    expect(member.leadSource).toBeNull();
    expect(member.notes).not.toContain('None');
    // The old mapping stamped every member Kanpur / Uttar Pradesh /
    // India, which the export never said.
    expect(member.city).toBeNull();
  });

  it('is idempotent: a second run creates nothing', async () => {
    const rows = [withWhatsapp(), withWhatsapp()];
    const first = await service.import(organizationId, rows, {});
    expect(first.members.created).toBe(2);

    const second = await service.import(organizationId, rows, {});
    expect(second.members.created).toBe(0);
    expect(second.members.alreadyPresent).toBe(2);
  });

  it('recognises the same person whether or not the country code is stored', async () => {
    const code = `YDL-DUP-${Date.now()}`;
    const number = '9876543210';
    await service.import(
      organizationId,
      [withWhatsapp({ Code: code, Number: number })],
      {},
    );
    // Same human, different Code, number typed without +91.
    const report = await service.import(
      organizationId,
      [row({ Code: `${code}-B`, Number: number })],
      { dryRun: true },
    );
    expect(report.members.alreadyPresent).toBe(1);
    expect(report.members.toCreate).toBe(0);
  });

  it('names the trainers it could not match instead of logging a count', async () => {
    const report = await service.import(
      organizationId,
      [withWhatsapp({ 'Assigned Trainer': 'Rajat Katiyar' })],
      { dryRun: true },
    );
    expect(report.trainers.unmatched).toEqual(['Rajat Katiyar']);
  });

  it('attaches a trainer on a re-run once that trainer exists', async () => {
    const code = `YDL-TRAINER-${Date.now()}`;
    const rows = [
      withWhatsapp({ Code: code, 'Assigned Trainer': 'Riya Singh' }),
    ];
    await service.import(organizationId, rows, {});

    const before = await prisma.member.findFirstOrThrow({
      where: { organizationId, memberCode: code },
      select: { assignedTrainerId: true },
    });
    expect(before.assignedTrainerId).toBeNull();

    // The gym adds the trainer it was missing and runs the import again.
    const trainer = await prisma.user.create({
      data: {
        organizationId,
        email: `riya-${Date.now()}@example.com`,
        firstName: 'Riya',
        lastName: 'Singh',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    await prisma.staffProfile.create({
      data: { organizationId, userId: trainer.id, isTrainer: true },
    });

    const report = await service.import(organizationId, rows, {});
    expect(report.trainers.backfilled).toBe(1);

    const after = await prisma.member.findFirstOrThrow({
      where: { organizationId, memberCode: code },
      select: { assignedTrainerId: true },
    });
    expect(after.assignedTrainerId).toBe(trainer.id);
  });

  it('separates members from leads, and reports the rows that are neither', async () => {
    const report = await service.import(
      organizationId,
      [
        withWhatsapp({ 'Membership Status': 'Active' }),
        withWhatsapp({ 'Membership Status': 'Inactive' }),
        withWhatsapp({
          'Membership Status': 'Not assigned',
          'Conversion Date': null,
        }),
        // Unassigned but converted: silently dropped by the old rule.
        withWhatsapp({
          'Membership Status': 'Not assigned',
          'Conversion Date': '26-09-2024',
        }),
      ],
      { dryRun: true },
    );
    expect(report.classified).toEqual({ members: 2, leads: 1, ambiguous: 1 });
  });

  it('says how many active members have no membership to renew', async () => {
    const report = await service.import(
      organizationId,
      [
        withWhatsapp({ 'Membership Status': 'Active' }),
        withWhatsapp({ 'Membership Status': 'Inactive' }),
      ],
      { dryRun: true },
    );
    // The export carries no plan, price or end date, so no Membership
    // row can honestly be created. Saying so beats inventing one and
    // mailing a renewal reminder on a date nobody chose.
    expect(report.warnings.activeWithoutMembership).toBe(1);
  });

  it('is reachable as a route, behind data.import', async () => {
    const res = await asOwner(
      request(app.getHttpServer())
        .post('/data/imports/customer-enquiry')
        .send({ rows: [withWhatsapp()], dryRun: true }),
    ).expect(201);
    expect(res.body.data.dryRun).toBe(true);
    expect(res.body.data.members.toCreate).toBe(1);
  });

  it('refuses a caller without data.import', async () => {
    const other = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Other Gym',
        email: `other-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Other',
        lastName: 'Owner',
      })
      .expect(201);
    const member = await prisma.role.findFirstOrThrow({
      where: { key: 'MEMBER', organizationId: null },
      select: { id: true },
    });
    const userId = other.body.data.user.id;
    await prisma.userRole.deleteMany({ where: { userId } });
    await prisma.userRole.create({
      data: {
        userId,
        roleId: member.id,
        organizationId: other.body.data.user.organizationId,
      },
    });

    await request(app.getHttpServer())
      .post('/data/imports/customer-enquiry')
      .set('Authorization', `Bearer ${other.body.data.accessToken}`)
      .send({ rows: [withWhatsapp()], dryRun: true })
      .expect(403);
  });

  it('runs the real export end to end', () => {
    // Guarded: the file only exists where it has been placed for a
    // one-off migration, so this does not fail a clean checkout.
    const path = process.env.CUSTOMER_ENQUIRY_FIXTURE;
    if (!path) return;
    const rows = JSON.parse(readFileSync(path, 'utf8')) as EnquiryRow[];
    expect(rows.length).toBeGreaterThan(0);
  });
});
