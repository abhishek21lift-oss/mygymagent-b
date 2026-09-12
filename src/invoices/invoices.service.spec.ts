import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { CommunicationsService } from '../communications/communications.service';
import { RazorpayService } from '../payments/razorpay.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from './invoices.service';

function prismaMock() {
  const tx = {
    invoiceSequence: { upsert: jest.fn() },
    invoice: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
    },
    payment: { create: jest.fn() },
    invoicePayment: { create: jest.fn() },
    $queryRaw: jest.fn(),
  };
  return {
    organization: { findFirst: jest.fn() },
    member: { findFirst: jest.fn() },
    membership: { findFirst: jest.fn() },
    branch: { findFirst: jest.fn() },
    invoiceSequence: { upsert: jest.fn() },
    invoice: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb(tx)),
    $queryRaw: jest.fn(),
    tx,
  };
}

type PrismaMock = ReturnType<typeof prismaMock>;

describe('InvoicesService', () => {
  let service: InvoicesService;
  let prisma: PrismaMock;
  let razorpay: {
    ensureConfigured: jest.Mock;
    createOrder: jest.Mock;
    getKeyId: jest.Mock;
  };

  beforeEach(async () => {
    prisma = prismaMock();
    razorpay = {
      ensureConfigured: jest.fn(),
      createOrder: jest.fn(),
      getKeyId: jest.fn().mockReturnValue('rzp_test_123'),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RazorpayService, useValue: razorpay },
        {
          provide: CommunicationsService,
          useValue: {
            sendPaymentReceipt: jest.fn(),
            sendInvoiceDueReminder: jest.fn(),
          },
        },
      ],
    }).compile();

    service = moduleRef.get<InvoicesService>(InvoicesService);
  });

  const orgMemberMocks = () => {
    (prisma.organization.findFirst as jest.Mock).mockResolvedValue({
      id: 'org_1',
      currency: 'USD',
    });
    (prisma.member.findFirst as jest.Mock).mockResolvedValue({
      id: 'member_1',
      primaryBranchId: 'branch_1',
    });
  };

  describe('create', () => {
    it('computes subtotal/discount/tax/grandTotal server-side and issues immediately', async () => {
      orgMemberMocks();
      (prisma.tx.invoiceSequence.upsert as jest.Mock).mockResolvedValue({
        lastNumber: 7,
      });
      (prisma.tx.invoice.create as jest.Mock).mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'inv_1',
          ...data,
        }),
      );

      const result = await service.create('org_1', {
        memberId: 'member_1',
        lines: [
          { label: 'Plan', amount: 100, qty: 2 },
          { label: 'Addon', amount: 25.5 },
        ],
        discount: 10,
        taxBreakup: [{ label: 'GST', rate: 18, amount: 34.29 }],
      });

      expect(result.number).toBe(`INV-${new Date().getFullYear()}-0007`);
      expect(result.status).toBe('ISSUED');
      expect(result.issuedAt).toBeInstanceOf(Date);
      // 100*2 + 25.50 = 225.50 subtotal; -10 discount; +34.29 tax = 249.79
      expect((result.subtotal as Prisma.Decimal).toFixed(2)).toBe('225.50');
      expect((result.discountTotal as Prisma.Decimal).toFixed(2)).toBe('10.00');
      expect((result.taxTotal as Prisma.Decimal).toFixed(2)).toBe('34.29');
      expect((result.grandTotal as Prisma.Decimal).toFixed(2)).toBe('249.79');
    });

    it('stays DRAFT with no issuedAt when draft:true', async () => {
      orgMemberMocks();
      (prisma.tx.invoiceSequence.upsert as jest.Mock).mockResolvedValue({
        lastNumber: 1,
      });
      (prisma.tx.invoice.create as jest.Mock).mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: 'inv_1',
          ...data,
        }),
      );

      const result = await service.create('org_1', {
        memberId: 'member_1',
        lines: [{ label: 'Plan', amount: 50 }],
        draft: true,
      });

      expect(result.status).toBe('DRAFT');
      expect(result.issuedAt).toBeNull();
    });

    it('rejects a discount above the subtotal', async () => {
      orgMemberMocks();
      await expect(
        service.create('org_1', {
          memberId: 'member_1',
          lines: [{ label: 'Plan', amount: 50 }],
          discount: 60,
        }),
      ).rejects.toThrow('Discount cannot exceed the invoice subtotal');
    });
  });

  describe('void', () => {
    it('throws 409 when payments are linked', async () => {
      (prisma.invoice.findFirst as jest.Mock).mockResolvedValue({
        id: 'inv_1',
        status: 'ISSUED',
        grandTotal: new Prisma.Decimal(100),
        paymentLinks: [
          { amount: new Prisma.Decimal(10), payment: { status: 'COMPLETED' } },
        ],
        dunningAttempts: [],
      });
      await expect(service.void('org_1', 'inv_1')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('retryCollection', () => {
    it('throws 503 with a clear message when Razorpay is unconfigured', async () => {
      (prisma.invoice.findFirst as jest.Mock).mockResolvedValue({
        id: 'inv_1',
        number: 'INV-2026-0001',
        status: 'ISSUED',
        currency: 'USD',
        grandTotal: new Prisma.Decimal(100),
        paymentLinks: [],
        dunningAttempts: [],
        outstanding: '100.00',
      });
      razorpay.ensureConfigured.mockImplementation(() => {
        throw new ServiceUnavailableException(
          'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable online collection.',
        );
      });
      await expect(
        service.retryCollection('org_1', 'inv_1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(razorpay.createOrder).not.toHaveBeenCalled();
    });
  });

  describe('recomputeInvoiceStatus', () => {
    const baseInvoice = {
      id: 'inv_1',
      status: 'ISSUED',
      grandTotal: new Prisma.Decimal(100),
      dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      paidAt: null,
    };

    it('moves to PART_PAID on a partial capture, ignoring FAILED payments', async () => {
      (prisma.tx.invoice.findUnique as jest.Mock).mockResolvedValue({
        ...baseInvoice,
        paymentLinks: [
          { amount: new Prisma.Decimal(40), payment: { status: 'COMPLETED' } },
          { amount: new Prisma.Decimal(100), payment: { status: 'FAILED' } },
        ],
      });
      (prisma.tx.invoice.update as jest.Mock).mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          ...baseInvoice,
          ...data,
        }),
      );

      const result = await service.recomputeInvoiceStatus('inv_1');
      expect(result.status).toBe('PART_PAID');
      expect(prisma.tx.invoice.update).toHaveBeenCalledWith({
        where: { id: 'inv_1' },
        data: { status: 'PART_PAID', paidAt: null },
      });
    });

    it('moves to PAID with paidAt on full capture', async () => {
      (prisma.tx.invoice.findUnique as jest.Mock).mockResolvedValue({
        ...baseInvoice,
        paymentLinks: [
          { amount: new Prisma.Decimal(100), payment: { status: 'COMPLETED' } },
        ],
      });
      (prisma.tx.invoice.update as jest.Mock).mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          ...baseInvoice,
          ...data,
        }),
      );

      const result = await service.recomputeInvoiceStatus('inv_1');
      expect(result.status).toBe('PAID');
      expect(result.paidAt).toBeInstanceOf(Date);
    });

    it('never moves a VOID invoice', async () => {
      (prisma.tx.invoice.findUnique as jest.Mock).mockResolvedValue({
        ...baseInvoice,
        status: 'VOID',
        paymentLinks: [],
      });
      const result = await service.recomputeInvoiceStatus('inv_1');
      expect(result.status).toBe('VOID');
      expect(prisma.tx.invoice.update).not.toHaveBeenCalled();
    });
  });
});
