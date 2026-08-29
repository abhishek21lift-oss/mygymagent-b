import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { QueueModule } from './queue/queue.module';
import { FilesModule } from './files/files.module';
import { AuditModule } from './audit/audit.module';
import { RbacModule } from './rbac/rbac.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { PlatformRoleGuard } from './common/guards/platform-role.guard';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { HealthModule } from './health/health.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { BranchesModule } from './branches/branches.module';
import { UsersModule } from './users/users.module';
import { MembersModule } from './members/members.module';
import { MembershipPlansModule } from './membership-plans/membership-plans.module';
import { MembershipsModule } from './memberships/memberships.module';
import { AttendanceModule } from './attendance/attendance.module';
import { PlatformModule } from './platform/platform.module';
import { BillingModule } from './billing/billing.module';
import { WorkoutsModule } from './workouts/workouts.module';
import { CrmModule } from './crm/crm.module';
import { AiModule } from './ai/ai.module';
import { AiActionsModule } from './ai-actions/ai-actions.module';
import { NutritionModule } from './nutrition/nutrition.module';
import { InventoryModule } from './inventory/inventory.module';
import { PtSessionsModule } from './pt-sessions/pt-sessions.module';
import { PtPackagesModule } from './pt-packages/pt-packages.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SearchModule } from './search/search.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AutomationModule } from './automation/automation.module';
import { BriefingModule } from './briefing/briefing.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    EventEmitterModule.forRoot(),
    ThrottlerModule.forRoot({ throttlers: [{ ttl: 60_000, limit: 120 }] }),
    PrismaModule,
    QueueModule,
    FilesModule,
    AuditModule,
    RbacModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    BranchesModule,
    UsersModule,
    MembersModule,
    MembershipPlansModule,
    MembershipsModule,
    AttendanceModule,
    BillingModule,
    WorkoutsModule,
    PtSessionsModule,
    PtPackagesModule,
    CrmModule,
    AiModule,
    AiActionsModule,
    NutritionModule,
    InventoryModule,
    PlatformModule,
    NotificationsModule,
    SearchModule,
    AnalyticsModule,
    AutomationModule,
    BriefingModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: PlatformRoleGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
