import { PaymentReceiptListener } from './payment-receipt.listener';

function harness(
  opts: {
    enabled?: boolean;
    linked?: boolean;
    payment?: Record<string, unknown> | null;
    alreadyRan?: boolean;
  } = {},
) {
  const communications = {
    ownWhatsappNumberReady: jest.fn(async () => opts.linked !== false),
    send: jest.fn(async () => ({ id: 'log_1', status: 'SENT' })),
  };
  const messenger = {
    automationEnabled: jest.fn(async () => opts.enabled !== false),
  };
  const runs = {
    attempt: jest.fn(async (_org: string, _key: string, subjectId: string) => {
      if (opts.alreadyRan) return 'COOLDOWN';
      void subjectId;
      return 'SENT';
    }),
  };
  const prisma = {
    payment: {
      findFirst: jest.fn(async () =>
        opts.payment === undefined
          ? {
              amount: { toString: () => '1500' },
              currency: 'INR',
              member: { id: 'm1', phone: '919876543210', firstName: 'Asha' },
            }
          : opts.payment,
      ),
    },
  };
  const listener = new PaymentReceiptListener(
    prisma as never,
    communications as never,
    messenger as never,
    runs as never,
  );
  return { listener, runs, messenger, communications };
}

const event = {
  organizationId: 'org_1',
  branchId: 'b1',
  paymentId: 'pay_1',
  memberId: 'm1',
  amount: '1500',
  currency: 'INR',
};

describe('PaymentReceiptListener', () => {
  it('sends a receipt for a completed payment', async () => {
    const { listener, runs } = harness();
    await listener.handle(event as never);
    expect(runs.attempt).toHaveBeenCalledWith(
      'org_1',
      'PAYMENT_RECEIPT',
      'pay_1',
      expect.any(Number),
      expect.any(Function),
      expect.anything(),
    );
    await runs.attempt.mock.results[0].value;
  });

  it('sends only once for a payment announced twice (idempotency)', async () => {
    // announceStart() emits PaymentRecorded right after Billing does, so
    // the same payment can be announced twice. The run key must dedupe.
    const send = jest.fn(async () => ({ status: 'SENT' }));
    const runs = {
      attempt: jest.fn(
        async (
          _org: string,
          _key: string,
          _subject: string,
          _cooldown: number,
          action: () => Promise<unknown>,
        ) => {
          const seen =
            (runs.attempt as unknown as { _seen?: string[] })._seen ?? [];
          const key = `${_org}:${_key}:${_subject}`;
          if (seen.includes(key)) return 'COOLDOWN';
          (runs.attempt as unknown as { _seen: string[] })._seen = [
            ...seen,
            key,
          ];
          await action();
          return 'SENT';
        },
      ),
    };
    const communications = {
      ownWhatsappNumberReady: jest.fn(async () => true),
      send,
    };
    const prisma = {
      payment: {
        findFirst: jest.fn(async () => ({
          amount: { toString: () => '1500' },
          currency: 'INR',
          member: { id: 'm1', phone: '919876543210', firstName: 'Asha' },
        })),
      },
    };
    const listener = new PaymentReceiptListener(
      prisma as never,
      communications as never,
      { automationEnabled: jest.fn(async () => true) } as never,
      runs as never,
    );

    await listener.handle(event as never);
    await listener.handle(event as never);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the receipt switch is off', async () => {
    const { listener, runs, messenger } = harness({ enabled: false });
    await listener.handle(event as never);
    expect(runs.attempt).not.toHaveBeenCalled();
    expect(messenger.automationEnabled).toHaveBeenCalledWith(
      'org_1',
      'PAYMENT_RECEIPT',
    );
  });

  it('sends nothing when no number is linked', async () => {
    const { listener, runs } = harness({ linked: false });
    await listener.handle(event as never);
    expect(runs.attempt).not.toHaveBeenCalled();
  });

  it('sends nothing when the payment is not completed', async () => {
    const { listener, runs } = harness({ payment: null });
    await listener.handle(event as never);
    expect(runs.attempt).not.toHaveBeenCalled();
  });

  it('sends nothing for a member with no phone', async () => {
    const { listener, runs } = harness({
      payment: {
        amount: { toString: () => '1500' },
        currency: 'INR',
        member: { id: 'm1', phone: null, firstName: 'Asha' },
      },
    });
    await listener.handle(event as never);
    expect(runs.attempt).not.toHaveBeenCalled();
  });

  it('never fails when sending throws -- the payment is already recorded', async () => {
    const failing = {
      ownWhatsappNumberReady: jest.fn(async () => {
        throw new Error('redis down');
      }),
      send: jest.fn(),
    };
    const robust = new PaymentReceiptListener(
      { payment: { findFirst: jest.fn(async () => null) } } as never,
      failing as never,
      { automationEnabled: jest.fn(async () => true) } as never,
      { attempt: jest.fn() } as never,
    );
    await expect(robust.handle(event as never)).resolves.toBeUndefined();
    expect(failing.send).not.toHaveBeenCalled();
  });
});
