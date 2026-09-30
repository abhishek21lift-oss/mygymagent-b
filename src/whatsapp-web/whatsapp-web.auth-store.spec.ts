import { randomBytes } from 'crypto';
import { WhatsappWebAuthStore } from './whatsapp-web.auth-store';

/** An in-memory stand-in for the two Prisma calls the store makes. */
function fakePrisma() {
  const rows = new Map<string, { key: string; valueEnc: string }>();
  const id = (o: string, k: string) => `${o}|${k}`;
  const model = {
    findUnique: ({ where }: any) =>
      Promise.resolve(
        rows.get(
          id(
            where.organizationId_key.organizationId,
            where.organizationId_key.key,
          ),
        ) ?? null,
      ),
    findMany: ({ where }: any) =>
      Promise.resolve(
        [...rows.entries()]
          .filter(([k]) => k.startsWith(`${where.organizationId}|`))
          .map(([, v]) => v)
          .filter((v) => where.key.in.includes(v.key)),
      ),
    upsert: ({ where, create, update }: any) => {
      const k = id(
        where.organizationId_key.organizationId,
        where.organizationId_key.key,
      );
      rows.set(k, {
        key: create.key,
        valueEnc: (rows.has(k) ? update : create).valueEnc,
      });
      return Promise.resolve();
    },
    deleteMany: ({ where }: any) => {
      for (const key of where.key?.in ?? [])
        rows.delete(id(where.organizationId, key));
      return Promise.resolve();
    },
  };
  return {
    rows,
    prisma: {
      whatsappWebAuthKey: model,
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    } as any,
  };
}

describe('WhatsappWebAuthStore', () => {
  const key = randomBytes(32);

  it('round-trips values, and never stores them in plain text', async () => {
    const { prisma, rows } = fakePrisma();
    const store = new WhatsappWebAuthStore(prisma, 'org-1', key);
    await store.write({
      creds: '{"noiseKey":"secret-material"}',
      'pre-key-1': 'abc',
    });

    expect(await store.read('creds')).toBe('{"noiseKey":"secret-material"}');
    expect([
      ...(await store.readMany(['pre-key-1', 'pre-key-2'])).entries(),
    ]).toEqual([['pre-key-1', 'abc']]);
    for (const row of rows.values()) {
      expect(row.valueEnc).toMatch(/^v1\./);
      expect(row.valueEnc).not.toContain('secret-material');
    }
  });

  it('deletes a key written as null, and keeps gyms apart', async () => {
    const { prisma } = fakePrisma();
    const a = new WhatsappWebAuthStore(prisma, 'org-a', key);
    const b = new WhatsappWebAuthStore(prisma, 'org-b', key);
    await a.write({ 'session-1': 'x' });
    expect(await b.read('session-1')).toBeNull();
    await a.write({ 'session-1': null });
    expect(await a.read('session-1')).toBeNull();
  });

  it('cannot be read with another key', async () => {
    const { prisma } = fakePrisma();
    await new WhatsappWebAuthStore(prisma, 'org-1', key).write({ creds: 'x' });
    await expect(
      new WhatsappWebAuthStore(prisma, 'org-1', randomBytes(32)).read('creds'),
    ).rejects.toThrow();
  });
});
