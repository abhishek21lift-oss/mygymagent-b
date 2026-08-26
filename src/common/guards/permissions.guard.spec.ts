import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import {
  PERMISSIONS_ANY_KEY,
  PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';

describe('PermissionsGuard tenant/branch isolation', () => {
  const branchId = 'branch-b';
  const user = {
    id: 'user-1',
    organizationId: 'org-1',
  };

  function makeContext(metadata: {
    required?: string[];
    requiredAny?: string[];
    headers?: Record<string, string>;
  }, permissions: (key: string, branch?: string) => boolean) {
    const request: any = {
      user,
      headers: metadata.headers ?? { 'x-branch-id': branchId },
    };
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => {
        if (key === PERMISSIONS_KEY) return metadata.required;
        if (key === PERMISSIONS_ANY_KEY) return metadata.requiredAny;
        return undefined;
      }),
    } as unknown as Reflector;

    const permissionService = {
      hasPermission: jest.fn(async (
        _userId: string,
        _organizationId: string,
        key: string,
        requestedBranch?: string,
      ) => permissions(key, requestedBranch)),
    } as any;

    const guard = new PermissionsGuard(reflector, permissionService);
    const context = {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    return { guard, context, request, permissionService };
  }

  it('preserves a branch-scoped grant when a later AND permission is org-wide', async () => {
    const { guard, context, request } = makeContext(
      { required: ['members.read_assigned', 'reports.view'] },
      (key, requestedBranch) => {
        if (key === 'members.read_assigned') return requestedBranch === branchId;
        return requestedBranch === undefined;
      },
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.branchScope).toBe(branchId);
  });

  it('preserves a branch-scoped grant when it appears after an org-wide permission', async () => {
    const { guard, context, request } = makeContext(
      { required: ['reports.view', 'members.read_assigned'] },
      (key, requestedBranch) => {
        if (key === 'members.read_assigned') return requestedBranch === branchId;
        return requestedBranch === undefined;
      },
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.branchScope).toBe(branchId);
  });

  it('does not invent a branch restriction for an org-wide OR permission', async () => {
    const { guard, context, request } = makeContext(
      { requiredAny: ['reports.view', 'members.read_assigned'] },
      (key, requestedBranch) => {
        if (key === 'reports.view') return requestedBranch === undefined;
        return false;
      },
    );

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.branchScope).toBeNull();
    expect(request.grantedViaPermission).toBe('reports.view');
  });

  it('rejects an unauthorized branch-scoped permission without a branch header', async () => {
    const { guard, context } = makeContext(
      { required: ['members.read_assigned'], headers: {} },
      () => false,
    );

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
