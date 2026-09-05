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

/**
 * Wiring-level proof for CurrentAssignmentScope: a real PermissionsGuard
 * resolving @RequireAnyPermission against a stub PermissionsService, real
 * param-decorator metadata, and a request.user injected by express
 * middleware the way JwtAuthGuard would set it -- the same path a live
 * request takes. No DB: the guard's only dependency is the permission
 * service, which is stubbed by role.
 */
@Controller('__scope-probe')
@UseGuards(PermissionsGuard)
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

  @Get('denied')
  @RequireAnyPermission('reports.view', 'payments.refund')
  denied(@CurrentAssignmentScope() scope: string | null) {
    return { scope };
  }
}

describe('CurrentAssignmentScope wiring', () => {
  let app: INestApplication;
  /** permission key -> granted org-wide? */
  const grants = new Map<string, boolean>();

  const permissionsService = {
    hasPermission: jest.fn(
      async (_userId: string, _organizationId: string, key: string) => {
        return grants.get(key) ?? false;
      },
    ),
  } as unknown as PermissionsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ScopeProbeController],
      providers: [
        { provide: PermissionsService, useValue: permissionsService },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (req.path.startsWith('/__scope-probe')) {
        req.user = {
          id: 'trainer-user-1',
          organizationId: 'org-1',
        } as AuthenticatedUser;
      }
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const asProbe = (path: string) =>
    request(app.getHttpServer()).get(`/__scope-probe${path}`);

  it('scopes a workouts.read_assigned-only trainer to their own id', async () => {
    grants.clear();
    grants.set('workouts.read_assigned', true);
    const res = await asProbe('/workouts').expect(200);
    expect(res.body.scope).toBe('trainer-user-1');
  });

  it('keeps workouts.read (org-wide) holders unrestricted', async () => {
    grants.clear();
    grants.set('workouts.read', true);
    const res = await asProbe('/workouts').expect(200);
    expect(res.body.scope).toBeNull();
  });

  it('still scopes through the members keys', async () => {
    grants.clear();
    grants.set('members.read_assigned', true);
    const res = await asProbe('/members').expect(200);
    expect(res.body.scope).toBe('trainer-user-1');
  });

  it('denies a caller granted neither listed permission', async () => {
    grants.clear();
    grants.set('inventory.write', true); // unrelated to the route's list
    await asProbe('/denied').expect(403);
  });
});
