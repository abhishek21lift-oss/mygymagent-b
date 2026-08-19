import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin wrapper around the generated Prisma Client. This is intentionally
 * the ONLY place `PrismaClient` is constructed.
 *
 * Tenant scoping is NOT enforced here -- Prisma has no first-class
 * per-query tenant filter, so isolation is enforced one layer up, in each
 * domain repository/service, which must always include `organizationId`
 * (and `branchId` where relevant) in every `where` clause. See
 * `docs/ARCHITECTURE.md#multi-tenant-architecture` for the enforcement
 * strategy and `test/tenant-isolation.e2e-spec.ts` for the regression test
 * that guards it.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to database');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
