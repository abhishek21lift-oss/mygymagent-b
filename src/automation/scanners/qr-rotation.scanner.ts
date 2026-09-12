import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

const QR_VALIDITY_DAYS = 30;

/**
 * WS-3 QR rotation. Regenerates every MemberQrToken whose `rotatesAt` has
 * passed: a fresh random credential is hashed in (the plaintext is not
 * retained -- the member must re-fetch via GET /attendance/qr-token), and
 * `rotatesAt` moves forward another validity window. Runs weekly via the
 * automation queue's repeatable scheduler; safe to re-run (only expired
 * rows are touched).
 */
@Injectable()
export class QrRotationScanner {
  private readonly logger = new Logger(QrRotationScanner.name);

  constructor(private readonly prisma: PrismaService) {}

  async scan(): Promise<{ checked: number; rotated: number }> {
    const now = new Date();
    const expired = await this.prisma.memberQrToken.findMany({
      where: { rotatesAt: { lte: now } },
      select: { memberId: true },
      take: 500,
    });
    let rotated = 0;
    for (const row of expired) {
      const token = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      await this.prisma.memberQrToken.update({
        where: { memberId: row.memberId },
        data: {
          tokenHash,
          rotatesAt: new Date(
            Date.now() + QR_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
          ),
        },
      });
      rotated++;
    }
    this.logger.log(
      `QR rotation scan: ${expired.length} expired tokens, ${rotated} rotated`,
    );
    return { checked: expired.length, rotated };
  }
}
