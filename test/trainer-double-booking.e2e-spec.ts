import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * A trainer's hour can be taken two ways: a PT session (`/pt-sessions`,
 * keyed by StaffProfile) or an appointment (`/appointments`, keyed by
 * User, with PT_SESSION as one of its types). Each used to check only its
 * own table, so the same trainer could be booked twice for one hour.
 * Every path that puts a trainer on a time now checks both.
 */
describe('Trainer double-booking across PT sessions and appointments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let branchId: string;
  let trainerUserId: string;
  let trainerProfileId: string;
  let memberId: string;
  let otherMemberId: string;

  const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const server = () => app.getHttpServer();

  /** An hour on a day well clear of every other test's bookings. */
  const slot = (dayOffset: number, hour: number) => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + dayOffset);
    start.setUTCHours(hour, 0, 0, 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return { startTime: start.toISOString(), endTime: end.toISOString() };
  };

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const reg = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Double Booking Gym',
        email: `double-booking-${stamp}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Booking',
      })
      .expect(201);
    token = reg.body.data.accessToken;
    branchId = (await as(request(server()).get('/branches')).expect(200)).body
      .data.items[0].id;

    trainerUserId = (
      await as(
        request(server())
          .post('/users')
          .send({
            email: `double-booking-trainer-${stamp}@example.com`,
            firstName: 'Tara',
            lastName: 'Trainer',
            primaryBranchId: branchId,
            roleKey: 'TRAINER',
            isTrainer: true,
          }),
      ).expect(201)
    ).body.data.id;
    const profile = await prisma.staffProfile.findUniqueOrThrow({
      where: { userId: trainerUserId },
    });
    trainerProfileId = profile.id;

    const member = (firstName: string) =>
      as(
        request(server()).post('/members').send({
          primaryBranchId: branchId,
          firstName,
          lastName: 'Member',
        }),
      ).expect(201);
    memberId = (await member('Alex')).body.data.id;
    otherMemberId = (await member('Sam')).body.data.id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  const bookPt = (
    time: { startTime: string; endTime: string },
    member = memberId,
  ) =>
    as(
      request(server())
        .post('/pt-sessions')
        .send({
          memberId: member,
          trainerId: trainerProfileId,
          branchId,
          ...time,
        }),
    );
  const bookAppointment = (time: { startTime: string; endTime: string }) =>
    as(
      request(server())
        .post('/appointments')
        .send({
          branchId,
          staffId: trainerUserId,
          memberId: otherMemberId,
          type: 'PT_SESSION',
          title: 'PT with Sam',
          ...time,
        }),
    );

  it('rejects an appointment in an hour the trainer has a PT session', async () => {
    const time = slot(30, 7);
    await bookPt(time).expect(201);
    const res = await bookAppointment(time).expect(400);
    expect(res.body.error.message).toMatch(/already booked/i);
  });

  it('rejects a PT session in an hour the trainer has an appointment', async () => {
    const time = slot(31, 7);
    await bookAppointment(time).expect(201);
    const res = await bookPt(time).expect(400);
    expect(res.body.error.message).toMatch(/already booked/i);
  });

  it('rejects rescheduling an appointment onto a PT session', async () => {
    const pt = slot(32, 7);
    await bookPt(pt).expect(201);
    const appointment = await bookAppointment(slot(32, 10)).expect(201);
    await as(
      request(server())
        .patch(`/appointments/${appointment.body.data.id}/reschedule`)
        .send(pt),
    ).expect(400);
  });

  it('rejects moving a PT session onto an appointment', async () => {
    await bookAppointment(slot(33, 7)).expect(201);
    const session = await bookPt(slot(33, 10)).expect(201);
    await as(
      request(server())
        .patch(`/pt-sessions/${session.body.data.id}`)
        .send(slot(33, 7)),
    ).expect(400);
  });

  it('still allows the trainer back-to-back across the two tables', async () => {
    await bookPt(slot(34, 7)).expect(201);
    await bookAppointment(slot(34, 8)).expect(201);
  });

  it('lets a PT session be edited without clashing with itself', async () => {
    const session = await bookPt(slot(35, 7)).expect(201);
    await as(
      request(server())
        .patch(`/pt-sessions/${session.body.data.id}`)
        .send({ notes: 'Bring a belt' }),
    ).expect(200);
  });
});
