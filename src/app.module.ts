import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { TestableThrottlerGuard } from './common/guards/testable-throttler.guard';
import { throttlerConfig } from './common/rate-limit/throttler.config';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { CatalogModule } from './catalog/catalog.module';
import { PublicRateLimitModule } from './common/rate-limit/public-rate-limit.module';
import { QueueModule } from './queue/queue.module';
import { FilesModule } from './files/files.module';
import { AuditModule } from './audit/audit.module';
import { RbacModule } from './rbac/rbac.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { MfaEnrolmentGuard } from './common/guards/mfa-enrolment.guard';
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
import { InvoicesModule } from './invoices/invoices.module';
import { WorkoutsModule } from './workouts/workouts.module';
import { WorkoutSessionsModule } from './workout-sessions/workout-sessions.module';
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
import { MemberIntelligenceModule } from './member-intelligence/member-intelligence.module';
import { AutomationModule } from './automation/automation.module';
import { BriefingModule } from './briefing/briefing.module';
import { Client360Module } from './client-360/client-360.module';
import { CommunicationsModule } from './communications/communications.module';
import { AppointmentsModule } from './appointments/appointments.module';
import { ExpensesModule } from './expenses/expenses.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { HrPayrollModule } from './hr-payroll/hr-payroll.module';
import { PayrollModule } from './payroll/payroll.module';
import { PlatformBillingModule } from './platform-billing/platform-billing.module';
import { DataModule } from './data/data.module';
import { ClassesModule } from './classes/classes.module';
import { BusinessOsModule } from './business-os/business-os.module';
import { PortalModule } from './portal/portal.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    EventEmitterModule.forRoot(),
    // One unnamed entry, deliberately -- see throttler.config.ts for why
    // a list of them silently divides every limit in the app.
    ThrottlerModule.forRoot(throttlerConfig),
    PrismaModule,
    // Converges the code-owned catalogs at boot. Must come after
    // PrismaModule so its bootstrap hook has a live client.
    CatalogModule,
    PublicRateLimitModule,
    QueueModule,
    FilesModule,
    AuditModule,
    RbacModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    BranchesModule,
    UsersModule,
    // Before MembersModule: MemberIntelligenceModule owns the literal
    // /members/segments route, and MembersController's @Get(':id') would
    // otherwise match it first and 404 looking for a member named "segments".
    MemberIntelligenceModule,
    MembersModule,
    MembershipsModule,
    MembershipPlansModule,
    AttendanceModule,
    PlatformModule,
    BillingModule,
    InvoicesModule,
    WorkoutsModule,
    WorkoutSessionsModule,
    CrmModule,
    AiModule,
    AiActionsModule,
    NutritionModule,
    InventoryModule,
    PtSessionsModule,
    PtPackagesModule,
    NotificationsModule,
    SearchModule,
    AnalyticsModule,
    AutomationModule,
    BriefingModule,
    CommunicationsModule,
    Client360Module,
    AppointmentsModule,
    ExpensesModule,
    WhatsappModule,
    HrPayrollModule,
    PayrollModule,
    PlatformBillingModule,
    DataModule,
    ClassesModule,
    BusinessOsModule,
    PortalModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: TestableThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Immediately after authentication and before any permission check:
    // a session that owes its organization a second factor is confined
    // to the enrolment screens whatever its role would otherwise allow.
    { provide: APP_GUARD, useClass: MfaEnrolmentGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: PlatformRoleGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(reader: MiddlewareConsumer) {
    reader.apply(RequestIdMiddleware).forRoutes('*');
  }
}
