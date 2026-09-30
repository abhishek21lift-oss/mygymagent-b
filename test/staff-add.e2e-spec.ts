import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

const PASSWORD = 'CorrectHorseBattery9';

/**
 * Adding staff three ways -- emailed invite, a password set now, or no
 * app access at all -- with their pay, and the holes the old invite left:
 * another gym's branch, and an admin making an owner.
 */
describe('Adding staff (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;
  let foreignBranchId: string;

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(server()).patch(url).set('Authorization', `Bearer ${token}`),
  });
  const owner = () => as(gym.accessToken);
  const unique = (name: string) =>
    `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.com`;

  async function register(name: string) {
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: name,
        email: unique(name.toLowerCase().replace(/\W+/g, '-')),
        password: PASSWORD,
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken as string;
    return {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: (await as(token).get('/branches').expect(200)).body.data
        .items[0].id,
    } as RegisteredAccount;
  }

  /** An ORG_ADMIN who can sign in. */
  async function admin() {
    const email = unique('admin');
    await owner()
      .post('/users')
      .send({
        access: 'PASSWORD',
        password: PASSWORD,
        email,
        firstName: 'Ada',
        lastName: 'Admin',
        primaryBranchId: gym.branchId,
        roleKey: 'ORG_ADMIN',
      })
      .expect(201);
    const session = await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    return session.body.data;
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    gym = await register('Staff Add Gym');
    foreignBranchId = (await register('Other Staff Gym')).branchId;
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  it('adds someone who can sign in straight away, with their salary', async () => {
    const email = unique('ready');
    const res = await owner()
      .post('/users')
      .send({
        access: 'PASSWORD',
        password: PASSWORD,
        email,
        firstName: 'Ravi',
        lastName: 'Ready',
        phone: '9876543210',
        primaryBranchId: gym.branchId,
        roleKey: 'TRAINER',
        isTrainer: true,
        jobTitle: 'Floor trainer',
        pay: { salaryType: 'MONTHLY', baseSalary: 25000 },
      })
      .expect(201);
    expect(res.body.data).toMatchObject({
      status: 'ACTIVE',
      hasPassword: true,
      staffProfile: {
        isTrainer: true,
        jobTitle: 'Floor trainer',
        payrollEnabled: true,
        salaryType: 'MONTHLY',
        baseSalary: '25000',
      },
    });
    expect(res.body.data.passwordHash).toBeUndefined();

    await request(server())
      .post('/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    // No invite link is left lying around for an account that has a password.
    expect(
      await prisma.passwordResetToken.count({
        where: { userId: res.body.data.id },
      }),
    ).toBe(0);
  });

  it('keeps the old email invite as the default', async () => {
    const res = await owner()
      .post('/users')
      .send({
        email: unique('invited'),
        firstName: 'Isha',
        lastName: 'Invited',
        primaryBranchId: gym.branchId,
        roleKey: 'RECEPTIONIST',
      })
      .expect(201);
    expect(res.body.data).toMatchObject({
      status: 'INVITED',
      hasPassword: false,
    });
    expect(
      await prisma.passwordResetToken.count({
        where: { userId: res.body.data.id },
      }),
    ).toBe(1);
  });

  it('adds staff without app access, and gives it to them later', async () => {
    await owner()
      .post('/users')
      .send({
        access: 'NONE',
        email: unique('nope'),
        firstName: 'Nope',
        lastName: 'Email',
        primaryBranchId: gym.branchId,
        roleKey: 'STAFF',
      })
      .expect(400);

    const res = await owner()
      .post('/users')
      .send({
        access: 'NONE',
        firstName: 'Kamla',
        lastName: 'Helper',
        phone: '9000000001',
        primaryBranchId: gym.branchId,
        roleKey: 'STAFF',
        pay: { salaryType: 'DAILY', baseSalary: 600 },
      })
      .expect(201);
    const id = res.body.data.id as string;
    expect(res.body.data).toMatchObject({
      status: 'ACTIVE',
      email: null,
      hasPassword: false,
    });

    // On payroll from day one.
    const payroll = await owner().get('/hr-payroll/staff').expect(200);
    const rows = (payroll.body.data.items ?? payroll.body.data) as {
      userId: string;
      salaryType: string;
    }[];
    expect(rows.find((r) => r.userId === id)?.salaryType).toBe('DAILY');

    const stats = await owner().get('/users/stats').expect(200);
    expect(stats.body.data.noAccess).toBeGreaterThanOrEqual(1);

    // Found by phone.
    const found = await owner().get('/users?search=9000000001').expect(200);
    expect(found.body.data.items.map((u: { id: string }) => u.id)).toEqual([
      id,
    ]);

    await owner().post(`/users/${id}/invite`).send({}).expect(400);
    const email = unique('kamla');
    const granted = await owner()
      .post(`/users/${id}/invite`)
      .send({ email })
      .expect(201);
    expect(granted.body.data.email).toBe(email);
    expect(
      await prisma.passwordResetToken.count({ where: { userId: id } }),
    ).toBe(1);

    // Sending again replaces the link rather than adding a second.
    await owner().post(`/users/${id}/invite`).send({}).expect(201);
    expect(
      await prisma.passwordResetToken.count({
        where: { userId: id, usedAt: null },
      }),
    ).toBe(1);

    // Once they have a password there is nothing to invite them to.
    await prisma.user.update({
      where: { id },
      data: { passwordHash: await argon2.hash(PASSWORD) },
    });
    await owner().post(`/users/${id}/invite`).send({}).expect(409);
  });

  it("refuses another gym's branch", async () => {
    await owner()
      .post('/users')
      .send({
        access: 'NONE',
        firstName: 'Wrong',
        lastName: 'Branch',
        primaryBranchId: foreignBranchId,
        roleKey: 'STAFF',
      })
      .expect(400);
    await owner()
      .post('/users')
      .send({
        access: 'NONE',
        firstName: 'Wrong',
        lastName: 'Grant',
        primaryBranchId: gym.branchId,
        roleKey: 'STAFF',
        roleBranchId: foreignBranchId,
      })
      .expect(400);
  });

  it('refuses pay a payroll run could not compute, and adds nobody', async () => {
    const before = await prisma.user.count({
      where: { organizationId: gym.organizationId },
    });
    await owner()
      .post('/users')
      .send({
        access: 'NONE',
        firstName: 'No',
        lastName: 'Salary',
        primaryBranchId: gym.branchId,
        roleKey: 'STAFF',
        pay: { salaryType: 'MONTHLY' },
      })
      .expect(400);
    expect(
      await prisma.user.count({
        where: { organizationId: gym.organizationId },
      }),
    ).toBe(before);
  });

  it('lets only an owner add an owner, and only an HR manager set pay', async () => {
    const session = await admin();
    const asAdmin = as(session.accessToken);
    await asAdmin
      .post('/users')
      .send({
        access: 'NONE',
        firstName: 'Would',
        lastName: 'BeOwner',
        primaryBranchId: gym.branchId,
        roleKey: 'ORG_OWNER',
      })
      .expect(403);

    const hrManage = await prisma.permission.findUniqueOrThrow({
      where: { key: 'hr.manage' },
    });
    await prisma.userPermissionOverride.create({
      data: {
        userId: session.user.id,
        organizationId: gym.organizationId,
        permissionId: hrManage.id,
        effect: 'DENY',
      },
    });
    await asAdmin
      .post('/users')
      .send({
        access: 'NONE',
        firstName: 'Paid',
        lastName: 'ByAdmin',
        primaryBranchId: gym.branchId,
        roleKey: 'STAFF',
        pay: { salaryType: 'DAILY', baseSalary: 500 },
      })
      .expect(403);
    // Without pay the same admin can still add them.
    await asAdmin
      .post('/users')
      .send({
        access: 'NONE',
        firstName: 'Unpaid',
        lastName: 'ByAdmin',
        primaryBranchId: gym.branchId,
        roleKey: 'STAFF',
      })
      .expect(201);
  });

  it("moves the staff profile's branch with the staff member", async () => {
    const second = (
      await owner()
        .post('/branches')
        .send({ name: 'Second', slug: `second-${Date.now()}` })
        .expect(201)
    ).body.data.id as string;
    const res = await owner()
      .post('/users')
      .send({
        access: 'NONE',
        firstName: 'Moving',
        lastName: 'Staff',
        primaryBranchId: gym.branchId,
        roleKey: 'STAFF',
      })
      .expect(201);
    const moved = await owner()
      .patch(`/users/${res.body.data.id}`)
      .send({ primaryBranchId: second, commissionRate: 12.5 })
      .expect(200);
    expect(moved.body.data.staffProfile).toMatchObject({
      branchId: second,
      commissionRate: '12.5',
    });
  });
});
