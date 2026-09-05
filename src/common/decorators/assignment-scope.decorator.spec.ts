import { Controller, Get, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import { PermissionsGuard } from '../guards/permissions.guard';
import { PermissionsService } from '../../rbac/permissions.service';
import { RequireAnyPermission } from './permissions.decorator';
import { CurrentAssignmentScope } from './assignment-scope.decorator';
import type { AuthenticatedUser } from '../types/authenticated-user';

@UseGuards(PermissionsGuard)
@Controller('__scope-probe')
class ScopeProbeController {
  @Get('workouts')
  @RequireAnyPermission('workouts.read', 'workouts.read_assigned')
  workoutsScope(@CurrentAssignmentScope() scope: string | null) {
    return { scope };
  }

  @Get('members')
  @RequireAnyPermission('members.read', 'members.read_assigned')
  membersScope(@CurrentAssignmentScope() scope: string | null) {
    return { scope };
  }
}

describe('CurrentAssignmentScope wiring', () => {
  let app: INestApplication;
  const grants = new Map<string, boolean>();

  const permissionsService = {
    hasPermission: jest.fn(
      async (_userId: string, _organizationId: string, key: string) => grants.get(key) ?? false,
    ),
  } as unknown as PermissionsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ScopeProbeController],
      providers: [{ provide: PermissionsService, useValue: permissionsService }],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.user = { id: 'trainer-user-1', organizationId: 'org-1' } as AuthenticatedUser;
      next();
    });
    await app.init();
  });

  afterAll(async () => app.close());

  it('scopes an assigned permission to the current user', async () => {
    grants.clear();
    grants.set('workouts.read_assigned', true);
    const res = await request(app.getHttpServer()).get('/__scope-probe/workouts').expect(200);
    expect(res.body.scope).toBe('trainer-user-1');
  });

  it('keeps an org-wide permission unrestricted', async () => {
    grants.clear();
    grants.set('workouts.read', true);
    const res = await request(app.getHttpServer()).get('/__scope-probe/workouts').expect(200);
    expect(res.body.scope).toBeNull();
  });

  it('supports assigned member permissions too', async () => {
    grants.clear();
    grants.set('members.read_assigned', true);
    const res = await request(app.getHttpServer()).get('/__scope-probe/members').expect(200);
    expect(res.body.scope).toBe('trainer-user-1');
  });
});
