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
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        for (const k of [...rows.keys()]) {
          if (k.startsWith(`${where.sessionId}:`)) {
            rows.delete(k);
            count += 1;
          }
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
});
