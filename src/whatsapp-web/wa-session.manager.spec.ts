import { ConflictException } from '@nestjs/common';
import { WaSessionManager } from './wa-session.manager';
import type { WaSocket } from './wa-types';

// Multi-hop async socket handling under parallel workers can exceed the
// 5 s default when the machine is loaded; the work itself is milliseconds.
jest.setTimeout(15_000);

function memoryRedis() {
  const data = new Map<string, string>();
  return {
    data,
    set: jest.fn(async (key: string, value: string, ..._args: unknown[]) => {
      const nx = _args.includes('NX');
      if (nx && data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => data.get(key) ?? null),
    del: jest.fn(async (...keys: string[]) => {
      let n = 0;
      for (const key of keys) if (data.delete(key)) n += 1;
      return n;
    }),
    mget: jest.fn(async (...keys: string[]) =>
      keys.map((key) => data.get(key) ?? null),
    ),
    eval: jest.fn(
      async (script: string, _n: number, key: string, arg1: string) => {
        if ((data.get(key) ?? null) !== arg1) return 0;
        if (script.includes('pexpire')) return 1;
        if (script.includes("'del'")) {
          data.delete(key);
          return 1;
        }
        return 0;
      },
    ),
  };
}

function fakeSocket() {
  const socket: WaSocket = {
    ev: {
      on: jest.fn(
        (_event: string, _listener: (arg: never) => void) => undefined,
      ),
    },
    user: { id: '919876543210@s.whatsapp.net' },
    sendMessage: jest.fn(async () => ({ key: { id: 'WAID1' } })),
    onWhatsApp: jest.fn(async (...jids: string[]) =>
      jids.map((jid) => ({ jid, exists: true })),
    ),
    requestPairingCode: jest.fn(async () => 'PAIR-1'),
    logout: jest.fn(async () => undefined),
    end: jest.fn(() => undefined),
  };
  return socket;
}

/** Emit a Baileys event into a fake socket's listeners. */
function emit(socket: WaSocket, event: string, arg: never) {
  for (const [name, listener] of (socket.ev.on as jest.Mock).mock.calls) {
    if (name === event) (listener as (arg: never) => void)(arg);
  }
}

function setup(sharedRedis?: ReturnType<typeof memoryRedis>) {
  const redis = sharedRedis ?? memoryRedis();
  const queue = { client: redis };
  const waSession = {
    upsert: jest.fn(async ({ create }: any) => ({ id: 'ws-1', ...create })),
    findUnique: jest.fn(async () => ({ status: 'PAIRING' })),
    findMany: jest.fn(async () => []),
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({})),
  };
  const waAuthKey = { deleteMany: jest.fn(async () => ({ count: 2 })) };
  const prisma = { waSession, waAuthKey };
  const config = { get: jest.fn(() => undefined) };
  const factory = { create: jest.fn(async () => fakeSocket()) };
  const manager = new WaSessionManager(
    prisma as never,
    config as never,
    queue as never,
    factory as never,
  );
  return { manager, redis, prisma, factory };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('WaSessionManager ownership', () => {
  it('opens exactly one socket when two instances race', async () => {
    const redis = memoryRedis();
    const first = setup(redis);
    const second = setup(redis);
    await first.manager.connect('o1');
    await expect(second.manager.connect('o1')).rejects.toThrow(
      ConflictException,
    );
    expect(first.factory.create).toHaveBeenCalledTimes(1);
    expect(second.factory.create).not.toHaveBeenCalled();
    await first.manager.onApplicationShutdown();
    await second.manager.onApplicationShutdown();
  });
});

describe('WaSessionManager pairing', () => {
  it('overwrites the QR when WhatsApp rotates it', async () => {
    const { manager, redis } = setup();
    await manager.connect('o1');
    const socket = (manager as any).entries.get('o1').socket as WaSocket;
    emit(socket, 'connection.update', { qr: 'qr-one' } as never);
    await flush();
    emit(socket, 'connection.update', { qr: 'qr-two' } as never);
    await flush();
    const qrKeys = [...redis.data.keys()].filter((k) => k.endsWith(':qr'));
    expect(qrKeys).toHaveLength(1);
    expect(redis.data.get(qrKeys[0])).toBe('qr-two');
    const codes = await manager.codes('o1');
    expect(codes.qrDataUrl?.startsWith('data:image/')).toBe(true);
    await manager.onApplicationShutdown();
  });

  it('asks for a pairing code when a phone number is given', async () => {
    const { manager } = setup();
    await manager.connect('o1', { pairingPhone: '919876543210' });
    const socket = (manager as any).entries.get('o1').socket as WaSocket;
    emit(socket, 'connection.update', { qr: 'QR' } as never);
    await flush();
    expect(socket.requestPairingCode).toHaveBeenCalledWith('919876543210');
    await expect(manager.codes('o1')).resolves.toMatchObject({
      pairingCode: 'PAIR-1',
    });
    await manager.onApplicationShutdown();
  });
});

describe('WaSessionManager close handling', () => {
  it('wipes keys and reports LOGGED_OUT on 401', async () => {
    const { manager, prisma, redis } = setup();
    await manager.connect('o1');
    const socket = (manager as any).entries.get('o1').socket as WaSocket;
    emit(socket, 'connection.update', { connection: 'open' } as never);
    await flush();
    emit(socket, 'connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    } as never);
    await flush();
    expect(prisma.waAuthKey.deleteMany).toHaveBeenCalled();
    expect(prisma.waSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'LOGGED_OUT' }),
      }),
    );
    expect(
      [...redis.data.keys()].filter((k) => k.endsWith(':lock')),
    ).toHaveLength(0);
    await manager.onApplicationShutdown();
  });
});

describe('WaSessionManager bootstrap', () => {
  it('resumes every non-LOGGED_OUT session', async () => {
    const { manager, prisma, factory } = setup();
    prisma.waSession.findMany.mockResolvedValue([
      { organizationId: 'o9' },
    ] as never);
    await manager.resumeLinked();
    for (let i = 0; i < 20 && factory.create.mock.calls.length === 0; i += 1) {
      await flush();
    }
    expect(factory.create).toHaveBeenCalledTimes(1);
    await manager.onApplicationShutdown();
  });
});
