import type { RawBodyRequest } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { RazorpayController } from './razorpay.controller';

function build() {
  const prisma = {
    razorpayWebhookEvent: { create: jest.fn(async () => ({})) },
    razorpayOrder: { findUnique: jest.fn() },
    invoice: { findFirst: jest.fn() },
    payment: { findUnique: jest.fn() },
    dunningAttempt: { findFirst: jest.fn(), create: jest.fn() },
  };
  const razorpay = {
    isWebhookConfigured: jest.fn(() => true),
    verifyWebhookSignature: jest.fn(() => true),
  };
  const invoices = {
    applyOnlineCapture: jest.fn(async () => ({})),
    getOne: jest.fn(),
  };
  const controller = new RazorpayController(
    razorpay as never,
    invoices as never,
    prisma as never,
  );
  return { controller, prisma, invoices };
}

function captured(entity: Record<string, unknown>): RawBodyRequest<Request> {
  const body = {
    event: 'payment.captured',
    payload: { payment: { entity } },
  };
  return {
    rawBody: Buffer.from(JSON.stringify(body)),
  } as unknown as RawBodyRequest<Request>;
}

const recordedOrder = {
  amount: 50_000,
  currency: 'INR',
  invoice: { id: 'inv-1', organizationId: 'org-1' },
};

const payment = (extra: Record<string, unknown> = {}) => ({
  id: 'pay_1',
  order_id: 'order_1',
  amount: 50_000,
  currency: 'INR',
  method: 'upi',
  ...extra,
});

describe('RazorpayController payment.captured', () => {
  it('applies a capture resolved by its order, with matching notes and amount', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayOrder.findUnique.mockResolvedValue(recordedOrder);

    await expect(
      controller.handleWebhook(
        captured(
          payment({ notes: { invoiceId: 'inv-1', organizationId: 'org-1' } }),
        ),
        'sig',
      ),
    ).resolves.toEqual({ received: true });

    expect(prisma.razorpayOrder.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order_1' } }),
    );
    expect(invoices.applyOnlineCapture).toHaveBeenCalledWith('org-1', 'inv-1', {
      providerPaymentId: 'pay_1',
      amountRupees: new Prisma.Decimal(500),
      currency: 'INR',
      method: 'UPI',
    });
  });

  it('refuses when the notes name a different invoice than the order', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayOrder.findUnique.mockResolvedValue(recordedOrder);

    await expect(
      controller.handleWebhook(
        captured(
          payment({
            notes: { invoiceId: 'inv-OTHER', organizationId: 'org-1' },
          }),
        ),
        'sig',
      ),
    ).resolves.toEqual({ received: true });
    expect(invoices.applyOnlineCapture).not.toHaveBeenCalled();
  });

  it('refuses when the notes name a different organization', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayOrder.findUnique.mockResolvedValue(recordedOrder);

    await controller.handleWebhook(
      captured(payment({ notes: { organizationId: 'org-OTHER' } })),
      'sig',
    );
    expect(invoices.applyOnlineCapture).not.toHaveBeenCalled();
  });

  it('never follows notes when the order is unknown', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayOrder.findUnique.mockResolvedValue(null);
    prisma.invoice.findFirst.mockResolvedValue(null);

    await controller.handleWebhook(
      captured(
        payment({
          order_id: 'order_unknown',
          notes: { invoiceId: 'inv-1', organizationId: 'org-1' },
        }),
      ),
      'sig',
    );
    expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerOrderId: 'order_unknown' } }),
    );
    expect(invoices.applyOnlineCapture).not.toHaveBeenCalled();
  });

  it('refuses a payment without an order id', async () => {
    const { controller, prisma, invoices } = build();
    await controller.handleWebhook(
      captured(
        payment({
          order_id: undefined,
          notes: { invoiceId: 'inv-1', organizationId: 'org-1' },
        }),
      ),
      'sig',
    );
    expect(prisma.razorpayOrder.findUnique).not.toHaveBeenCalled();
    expect(invoices.applyOnlineCapture).not.toHaveBeenCalled();
  });

  it('refuses a captured amount that differs from the order', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayOrder.findUnique.mockResolvedValue(recordedOrder);

    await expect(
      controller.handleWebhook(captured(payment({ amount: 100 })), 'sig'),
    ).resolves.toEqual({ received: true });
    expect(invoices.applyOnlineCapture).not.toHaveBeenCalled();
  });

  it('refuses a capture in another currency', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayOrder.findUnique.mockResolvedValue(recordedOrder);

    await controller.handleWebhook(
      captured(payment({ currency: 'USD' })),
      'sig',
    );
    expect(invoices.applyOnlineCapture).not.toHaveBeenCalled();
  });

  it('bounds a legacy order (no recorded amount) by the outstanding balance', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayOrder.findUnique.mockResolvedValue(null);
    prisma.invoice.findFirst.mockResolvedValue({
      id: 'inv-1',
      organizationId: 'org-1',
      currency: 'INR',
    });
    invoices.getOne.mockResolvedValue({ outstanding: '400.00' });

    await controller.handleWebhook(captured(payment()), 'sig');
    expect(invoices.applyOnlineCapture).not.toHaveBeenCalled();

    invoices.getOne.mockResolvedValue({ outstanding: '500.00' });
    await controller.handleWebhook(captured(payment()), 'sig');
    expect(invoices.applyOnlineCapture).toHaveBeenCalledTimes(1);
  });
});

describe('RazorpayController event dedupe', () => {
  it('records the event id before processing', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayOrder.findUnique.mockResolvedValue(recordedOrder);

    await controller.handleWebhook(captured(payment()), 'sig', 'evt_1');
    expect(prisma.razorpayWebhookEvent.create).toHaveBeenCalledWith({
      data: { id: 'evt_1' },
    });
    expect(invoices.applyOnlineCapture).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a duplicate event id without reprocessing it', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayWebhookEvent.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    await expect(
      controller.handleWebhook(captured(payment()), 'sig', 'evt_1'),
    ).resolves.toEqual({ received: true });
    expect(prisma.razorpayOrder.findUnique).not.toHaveBeenCalled();
    expect(invoices.applyOnlineCapture).not.toHaveBeenCalled();
  });

  it('processes as before when the header is absent', async () => {
    const { controller, prisma, invoices } = build();
    prisma.razorpayOrder.findUnique.mockResolvedValue(recordedOrder);

    await controller.handleWebhook(captured(payment()), 'sig');
    expect(prisma.razorpayWebhookEvent.create).not.toHaveBeenCalled();
    expect(invoices.applyOnlineCapture).toHaveBeenCalledTimes(1);
  });
});
