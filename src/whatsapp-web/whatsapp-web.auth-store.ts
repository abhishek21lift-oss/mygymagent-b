import type { PrismaService } from '../prisma/prisma.service';
import {
  decryptWhatsappToken,
  encryptWhatsappToken,
} from '../whatsapp/whatsapp-token.vault';

/**
 * Encrypted key-value storage for one linked number's Baileys session.
 *
 * Baileys' own `useMultiFileAuthState` writes these keys to disk as plain
 * JSON. On a host with an ephemeral disk (Render) that loses the session
 * on every deploy, and in plain text it is a full login to the gym's
 * WhatsApp. So each value is AES-256-GCM encrypted with the same vault key
 * as the Meta token and stored per organization.
 *
 * Values are opaque strings here; serialising Baileys' Buffers is the
 * caller's job (see baileys-socket.factory.ts).
 */
export class WhatsappWebAuthStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationId: string,
    private readonly vaultKey: Buffer,
  ) {}

  async read(key: string): Promise<string | null> {
    const row = await this.prisma.whatsappWebAuthKey.findUnique({
      where: {
        organizationId_key: { organizationId: this.organizationId, key },
      },
      select: { valueEnc: true },
    });
    return row ? decryptWhatsappToken(row.valueEnc, this.vaultKey) : null;
  }

  async readMany(keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!keys.length) return out;
    const rows = await this.prisma.whatsappWebAuthKey.findMany({
      where: { organizationId: this.organizationId, key: { in: keys } },
      select: { key: true, valueEnc: true },
    });
    for (const row of rows) {
      out.set(row.key, decryptWhatsappToken(row.valueEnc, this.vaultKey));
    }
    return out;
  }

  /** Writes every entry; a `null` value deletes that key. */
  async write(entries: Record<string, string | null>): Promise<void> {
    const organizationId = this.organizationId;
    const puts = Object.entries(entries).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    );
    const deletes = Object.entries(entries)
      .filter(([, value]) => value === null)
      .map(([key]) => key);
    await this.prisma.$transaction([
      ...puts.map(([key, value]) => {
        const valueEnc = encryptWhatsappToken(value, this.vaultKey);
        return this.prisma.whatsappWebAuthKey.upsert({
          where: { organizationId_key: { organizationId, key } },
          create: { organizationId, key, valueEnc },
          update: { valueEnc },
        });
      }),
      ...(deletes.length
        ? [
            this.prisma.whatsappWebAuthKey.deleteMany({
              where: { organizationId, key: { in: deletes } },
            }),
          ]
        : []),
    ]);
  }

  static clear(prisma: PrismaService, organizationId: string) {
    return prisma.whatsappWebAuthKey.deleteMany({ where: { organizationId } });
  }
}
