import { UnrecoverableError } from 'bullmq';
import { ChannelNotConfiguredError } from '../../communications/interfaces/email-provider.interface';
import { PushTokenInvalidError } from '../../communications/providers/fcm-push.provider';
import { JOB_NAMES } from '../../queue/queue.constants';
import { PushDeliveryProcessor } from './push-delivery.processor';

describe('PushDeliveryProcessor', () => {
  const data = {
    organizationId: 'org-1',
    deviceId: 'device-1',
    userId: 'user-1',
    memberId: null,
    type: 'PAYMENT_RECORDED',
    category: 'PAYMENTS',
    title: 'Payment recorded',
    body: 'x',
  };
  const job = (attemptsMade: number, name: string = JOB_NAMES.DELIVER_PUSH) =>
    ({ name, data, attemptsMade, opts: { attempts: 3 } }) as never;

  function setup(
    sendImpl: () => Promise<string>,
    device: object | null = {
      id: 'device-1',
      address: 'token-1',
    },
  ) {
    const prisma = {
      notificationDevice: { findFirst: jest.fn().mockResolvedValue(device) },
      messageLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const fcm = { sendToToken: jest.fn(sendImpl) };
    const devices = { deactivate: jest.fn().mockResolvedValue({}) };
    const processor = new PushDeliveryProcessor(
      prisma as never,
      fcm as never,
      devices as never,
    );
    return { processor, prisma, fcm, devices };
  }

  it('logs SENT with the FCM message name and never the token', async () => {
    const { processor, prisma } = setup(() =>
      Promise.resolve('projects/p/messages/1'),
    );
    await processor.process(job(0));
    const row = prisma.messageLog.create.mock.calls[0][0].data;
    expect(row).toMatchObject({
      status: 'SENT',
      channel: 'PUSH',
      recipient: 'device:device-1',
      providerMessageId: 'projects/p/messages/1',
    });
    expect(JSON.stringify(row)).not.toContain('token-1');
  });

  it('retries a transient failure without logging it until the last attempt', async () => {
    const boom = () =>
      Promise.reject(new Error('FCM send failed (UNAVAILABLE)'));

    const first = setup(boom);
    await expect(first.processor.process(job(0))).rejects.toThrow(
      'UNAVAILABLE',
    );
    expect(first.prisma.messageLog.create).not.toHaveBeenCalled();

    const last = setup(boom);
    await expect(last.processor.process(job(2))).rejects.toThrow('UNAVAILABLE');
    expect(last.prisma.messageLog.create).toHaveBeenCalledTimes(1);
    expect(last.prisma.messageLog.create.mock.calls[0][0].data).toMatchObject({
      status: 'FAILED',
      attempts: 3,
    });
    expect(last.devices.deactivate).not.toHaveBeenCalled();
  });

  it('deactivates a dead token and does not retry', async () => {
    const { processor, prisma, devices } = setup(() =>
      Promise.reject(new PushTokenInvalidError('gone', 'UNREGISTERED')),
    );
    await expect(processor.process(job(0))).resolves.toBeUndefined();
    expect(devices.deactivate).toHaveBeenCalledWith('device-1');
    expect(prisma.messageLog.create.mock.calls[0][0].data.status).toBe(
      'FAILED',
    );
  });

  it('stops retrying when push is not configured', async () => {
    const { processor } = setup(() =>
      Promise.reject(new ChannelNotConfiguredError('off')),
    );
    await expect(processor.process(job(0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('does nothing for a device unregistered since the job was queued', async () => {
    const { processor, fcm, prisma } = setup(() => Promise.resolve('x'), null);
    await processor.process(job(0));
    expect(fcm.sendToToken).not.toHaveBeenCalled();
    expect(prisma.messageLog.create).not.toHaveBeenCalled();
  });

  it('fails an unknown job name loudly instead of completing it unsent', async () => {
    const { processor } = setup(() => Promise.resolve('x'));
    await expect(
      processor.process(job(0, 'something-else')),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
