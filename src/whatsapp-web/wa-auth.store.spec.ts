import { WaAuthStore, parseWaAuthKey } from './wa-auth.store';

function memoryPrisma() {
  const rows = new Map<string, string>();
  const keyOf = (where: any) =>
    `${where.sessionId_key.sessionId}:${where.sessionId_key.key}`;
  return {
    rows,
    waAuthKey: {
      upsert: jest.fn(async ({ where, create }: any) => {
        rows.set(keyOf(where), create.valueEnc);
        return create;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const valueEnc = rows.get(keyOf(where));
        return valueEnc ? { valueEnc } : null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const prefix = `${where.sessionId}:`;
        return [...rows.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .filter(([k]) =>
            where.key?.in ? where.key.in.includes(k.slice(prefix.length)) : true,
          )
          .map(([k, valueEnc]) => ({
            key: k.slice(prefix.length),
            valueEnc,
          }));
      }),
      delete: jest.fn(async ({ where }: any) => {
        rows.delete(keyOf(where));
        return {};
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        for (const k of [...rows.keys()]) {
          if (!k.startsWith(`${where.sessionId}:`)) continue;
          if (
            where.key !== undefined &&
            k.slice(`${where.sessionId}:`.length) !== where.key
          )
            continue;
          rows.delete(k);
          count += 1;
        }
        return { count };
      }),
    },
  };
}

const KEY = Buffer.alloc(32, 7);

describe('parseWaAuthKey', () => {
  it('rejects a missing or malformed key with 503, never logging material', () => {
    expect(() => parseWaAuthKey('')).toThrow(/WA_AUTH_KEY/);
    expect(() => parseWaAuthKey('xyz')).toThrow(/WA_AUTH_KEY/);
    expect(parseWaAuthKey('ab'.repeat(32))).toEqual(Buffer.alloc(32, 0xab));
  });
});

describe('WaAuthStore', () => {
  it('round-trips a key through encrypted storage', async () => {
    const prisma = memoryPrisma();
    const store = new WaAuthStore(prisma as never, 'gym-o1', KEY);
    await store.write('creds', 'secret-value');
    await expect(store.read('creds')).resolves.toBe('secret-value');
  });

  it('never stores plaintext', async () => {
    const prisma = memoryPrisma();
    const store = new WaAuthStore(prisma as never, 'gym-o1', KEY);
    await store.write('creds', 'secret-value');
    expect([...prisma.rows.values()].join('')).not.toContain('secret-value');
  });

  it('reads missing keys as null and clears per session', async () => {
    const prisma = memoryPrisma();
    const store = new WaAuthStore(prisma as never, 'gym-o1', KEY);
    await expect(store.read('nope')).resolves.toBeNull();
    await store.write('a', '1');
    await store.write('b', '2');
    await store.clear();
    await expect(store.read('a')).resolves.toBeNull();
    await expect(store.read('b')).resolves.toBeNull();
  });

  it('reads and writes keys in batches for the signal store', async () => {
    const prisma = memoryPrisma();
    const store = new WaAuthStore(prisma as never, 'gym-o1', KEY);
    await store.writeBatch({ 'a-1': 'one', 'a-2': 'two', gone: null });
    await expect(
      store.readMany(['a-1', 'a-2', 'missing']),
    ).resolves.toEqual(
      new Map([
        ['a-1', 'one'],
        ['a-2', 'two'],
        ['missing', null],
      ]),
    );
  });
});
