import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';
import { Member360Service } from './member-360.service';

@Injectable()
export class Member360IntegrityService extends Member360Service {
  constructor(
    private readonly integrityPrisma: PrismaService,
    members: MembersService,
  ) {
    super(integrityPrisma, members);
  }

  override async getOverview(
    organizationId: string,
    memberId: string,
    branchScope: string | null,
    assignmentScope: string | null,
  ) {
    const overview = await super.getOverview(
      organizationId,
      memberId,
      branchScope,
      assignmentScope,
    );

    const memberships = await this.integrityPrisma.membership.findMany({
      where: { organizationId, memberId },
      select: { id: true, price: true, status: true },
    });
    const membershipIds = memberships.map((membership) => membership.id);
    const payments = membershipIds.length
      ? await this.integrityPrisma.payment.findMany({
          where: {
            organizationId,
            memberId,
            membershipId: { in: membershipIds },
            status: {
              in: [PaymentStatus.COMPLETED, PaymentStatus.PARTIALLY_REFUNDED],
            },
          },
          select: { id: true, membershipId: true, amount: true },
        })
      : [];
    const refunds = payments.length
      ? await this.integrityPrisma.refund.findMany({
          where: {
            organizationId,
            paymentId: { in: payments.map((payment) => payment.id) },
          },
          select: { paymentId: true, amount: true },
        })
      : [];

    // PaymentStatus has no PENDING state. Keep the response field stable
    // without misclassifying completed payments as pending.
    const pendingPayments = 0;
    const totalDue = memberships.reduce(
      (sum, membership) => sum.plus(membership.price),
      new Prisma.Decimal(0),
    );
    const totalPaid = payments.reduce(
      (sum, payment) => sum.plus(payment.amount),
      new Prisma.Decimal(0),
    );
    const totalRefunded = refunds.reduce(
      (sum, refund) => sum.plus(refund.amount),
      new Prisma.Decimal(0),
    );
    const outstandingBalance = totalDue.sub(totalPaid).add(totalRefunded);

    const activeMembership = memberships.find(
      (membership) => membership.status === 'ACTIVE',
    );
    const activePayments = activeMembership
      ? payments.filter((payment) => payment.membershipId === activeMembership.id)
      : [];
    const activeRefunds = activeMembership
      ? refunds.filter((refund) =>
          activePayments.some((payment) => payment.id === refund.paymentId),
        )
      : [];
    const activePaid = activePayments.reduce(
      (sum, payment) => sum.plus(payment.amount),
      new Prisma.Decimal(0),
    );
    const activeRefunded = activeRefunds.reduce(
      (sum, refund) => sum.plus(refund.amount),
      new Prisma.Decimal(0),
    );

    return {
      ...overview,
      membership: overview.membership
        ? {
            ...overview.membership,
            totalPaid: activePaid,
            outstandingBalance: activeMembership
              ? activeMembership.price.sub(activePaid).add(activeRefunded)
              : overview.membership.outstandingBalance,
          }
        : null,
      finance: {
        totalPaid,
        totalRefunded,
        outstandingBalance,
        pendingPayments,
      },
    };
  }
}
